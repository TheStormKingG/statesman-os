/**
 * Unit: SQLSTATE -> error type -> HTTP status, in `tests/support/scoped-pg/errors.ts`.
 *
 * Pure logic, no database. `mapDatabaseError` is a total function from a thrown
 * value to a typed error, and every claim the module's comments make about it is
 * checkable here without a connection.
 *
 * ── Why the expectation table is written out in full ──────────────────────────
 *
 * The table below is a SECOND expression of the mapping, not a copy of
 * `BY_SQLSTATE`. `BY_SQLSTATE` is module-private, so there is nothing to import
 * and nothing to accidentally compare to itself; the kinds, statuses and retry
 * flags are restated here from canon §4.4 and the error map. Editing one and not
 * the other is a failure, which is the whole point. A test that read the mapping
 * out of the module and then asserted the mapping equalled itself would pass
 * under every mutation.
 *
 * ── The two claims this file exists for ───────────────────────────────────────
 *
 *   1. 404 AND 409 STAY DISTINGUISHABLE. Under RLS a missing row and someone
 *      else's row are byte-identical (V7, V19), so the database cannot tell the
 *      boundary which it was. No SQLSTATE may therefore produce 404 — a 404 is
 *      only ever a `NotFoundError` raised by a service that separately read a
 *      row it owns. The sweep below asserts that over every modelled code and a
 *      set of unmodelled ones, with 409 present in the same sweep so the
 *      comparison is demonstrably live.
 *
 *   2. `dr_token_uq` AND `dr_no_uq` DO NOT FLATTEN INTO ONE CONFLICT. Both are
 *      23505 on `decision_revision`; they differ only in the constraint name,
 *      and they call for opposite responses — re-read the existing revision
 *      versus retry the write. Flattening them turns a retryable conflict into a
 *      dead end, or an idempotent replay into an infinite retry. The paired
 *      control is exact: same code, same severity, same message, one field
 *      different.
 */
import { describe, expect, it } from 'vitest'
import {
  CONSTRAINT,
  NotFoundError,
  StatesmanError,
  UnauthenticatedError,
  httpStatusFor,
  isRetryable,
  mapDatabaseError,
  publicMessageFor,
} from '../support/scoped-pg/errors'
import type { ErrorKind } from '../support/scoped-pg/errors'

/** A thrown value shaped like a `pg` error. `severity` is what `pg` sets. */
function pgError(code: string, extra: { constraint?: string; severity?: string } = {}) {
  return {
    code,
    message: `relation "decision_revision" rejected the write (${code})`,
    severity: 'severity' in extra ? extra.severity : 'ERROR',
    ...('constraint' in extra ? { constraint: extra.constraint } : {}),
  }
}

interface Expectation {
  readonly code: string
  readonly constraint?: string
  readonly kind: ErrorKind
  readonly httpStatus: number
  readonly retryable: boolean
  /** The class name, so a code silently re-pointed at a different type fails. */
  readonly typeName: string
}

/**
 * Canon §4.4 and the error map, restated. ST004 and ST006..ST009 are absent from
 * the migrations and therefore absent here; they appear in the unmodelled sweep
 * below instead, so "ST-prefixed" is not quietly treated as "modelled".
 */
const TABLE: readonly Expectation[] = [
  { code: '28000', kind: 'missing_context', httpStatus: 500, retryable: false, typeName: 'MissingContextError' },
  { code: '42501', kind: 'permission_denied', httpStatus: 403, retryable: false, typeName: 'PermissionDeniedError' },
  { code: 'ST001', kind: 'append_only', httpStatus: 409, retryable: false, typeName: 'AppendOnlyError' },
  { code: 'ST002', kind: 'illegal_transition', httpStatus: 409, retryable: false, typeName: 'IllegalTransitionError' },
  { code: 'ST003', kind: 'frozen_draft', httpStatus: 409, retryable: false, typeName: 'FrozenDraftError' },
  { code: 'ST005', kind: 'row_count', httpStatus: 409, retryable: false, typeName: 'RowCountError' },
  { code: 'ST010', kind: 'invalid_decision_state', httpStatus: 409, retryable: false, typeName: 'InvalidDecisionStateError' },
  { code: 'ST011', kind: 'invalid_decision_state', httpStatus: 409, retryable: false, typeName: 'InvalidDecisionStateError' },
  { code: 'ST012', kind: 'bad_milestone', httpStatus: 500, retryable: false, typeName: 'BadMilestoneError' },
  { code: 'ST099', kind: 'posture', httpStatus: 500, retryable: false, typeName: 'PostureError' },
  {
    code: '23505',
    constraint: CONSTRAINT.idempotencyToken,
    kind: 'idempotency_replay',
    httpStatus: 409,
    retryable: false,
    typeName: 'IdempotencyReplayError',
  },
  {
    code: '23505',
    constraint: CONSTRAINT.revisionNumber,
    kind: 'revision_number_conflict',
    httpStatus: 409,
    retryable: true,
    typeName: 'RevisionNumberConflictError',
  },
  {
    code: '23505',
    constraint: 'app_user_email_lower_uq',
    kind: 'unique_violation',
    httpStatus: 409,
    retryable: false,
    typeName: 'UniqueViolationError',
  },
  {
    // 23505 with NO constraint name. `pg` omits `constraint` for some unique
    // failures, and the switch's default arm has to carry that case rather than
    // falling into one of the two named branches.
    code: '23505',
    kind: 'unique_violation',
    httpStatus: 409,
    retryable: false,
    typeName: 'UniqueViolationError',
  },
]

function describeRow(row: Expectation): string {
  return row.constraint === undefined ? row.code : `${row.code} on ${row.constraint}`
}

function mapRow(row: Expectation): unknown {
  return mapDatabaseError(
    row.constraint === undefined ? pgError(row.code) : pgError(row.code, { constraint: row.constraint }),
  )
}

describe('mapDatabaseError: every modelled SQLSTATE', () => {
  it('maps each code to its own type, kind, status and retry semantics', () => {
    for (const row of TABLE) {
      const mapped = mapRow(row)
      const where = describeRow(row)

      expect(mapped, `${where} did not map to a StatesmanError at all`).toBeInstanceOf(
        StatesmanError,
      )
      if (!(mapped instanceof StatesmanError)) continue

      expect(mapped.constructor.name, `${where}: wrong error class`).toBe(row.typeName)
      expect(mapped.kind, `${where}: wrong kind`).toBe(row.kind)
      expect(mapped.httpStatus, `${where}: wrong HTTP status`).toBe(row.httpStatus)
      expect(mapped.retryable, `${where}: wrong retry semantics`).toBe(row.retryable)
      expect(mapped.sqlState, `${where}: the SQLSTATE was not carried through`).toBe(row.code)

      // The free functions must agree with the object they wrap. They are what
      // the HTTP layer actually calls, so a disagreement here is a live bug even
      // when the class is right.
      expect(httpStatusFor(mapRow(row)), `${where}: httpStatusFor disagrees`).toBe(row.httpStatus)
      expect(isRetryable(mapRow(row)), `${where}: isRetryable disagrees`).toBe(row.retryable)
    }
  })

  it('covers every code the table claims, and the table is not empty', () => {
    // THE ANTI-VACUOUS CONTROL for the loop above. A `for` over an empty or
    // accidentally-filtered array passes every assertion inside it. These two
    // numbers are derived from canon §4.4's code list, not read off the table.
    expect(TABLE.length).toBe(14)
    expect(new Set(TABLE.map((r) => r.code)).size).toBe(11)
  })
})

describe('404 and 409 stay distinguishable', () => {
  /**
   * Codes this boundary does not model, including ST-prefixed ones that are not
   * in the migrations. None of them may become a 404 either: an unmodelled
   * database error is a 500, never "not found".
   */
  const UNMODELLED = [
    '23502', // not_null_violation
    '23503', // foreign_key_violation
    '23514', // check_violation
    '22P02', // invalid_text_representation
    '40001', // serialization_failure
    '40P01', // deadlock_detected
    '42601', // syntax_error
    '42P01', // undefined_table
    '53300', // too_many_connections
    '57014', // query_canceled
    '42704', // undefined_object — what a lowercase custom code resolves to (V13)
    'ST004',
    'ST006',
    'ST013',
    'ST100',
  ] as const

  it('no SQLSTATE produces 404, while 409 and 500 are both reachable', () => {
    const statuses = new Set<number>()
    for (const code of [...TABLE.map((r) => r.code), ...UNMODELLED]) {
      const status = httpStatusFor(pgError(code))
      statuses.add(status)
      expect(
        status,
        `SQLSTATE ${code} produced a 404. Under RLS absence and denial are ` +
          'byte-identical (V7, V19), so the database cannot know a row was missing. ' +
          'A 404 manufactured from a SQLSTATE is a guess presented as a fact.',
      ).not.toBe(404)
    }

    // POSITIVE CONTROL for the sweep. If `httpStatusFor` returned a constant, or
    // the sweep ran over nothing, "never 404" would hold trivially. 409 and 500
    // must both appear, so the function is demonstrably discriminating.
    expect(
      statuses.has(409),
      'no code in the sweep produced a 409, so the "never 404" assertion above is ' +
        'not distinguishing anything',
    ).toBe(true)
    expect(statuses.has(500)).toBe(true)
    expect(statuses.has(403)).toBe(true)
  })

  it('404 comes only from a NotFoundError the service raised itself', () => {
    expect(httpStatusFor(new NotFoundError('read a row I own, it was not there'))).toBe(404)
    // And it survives re-mapping: `mapDatabaseError` returns a StatesmanError
    // unchanged, so applying the boundary twice cannot turn a 404 into a 500.
    expect(httpStatusFor(mapDatabaseError(new NotFoundError('x')))).toBe(404)
    expect(httpStatusFor(new UnauthenticatedError('no identity'))).toBe(401)
  })
})

describe('dr_token_uq and dr_no_uq are different conflicts', () => {
  it('differ in type and in retry semantics, from inputs that differ only in the constraint', () => {
    // Byte-identical inputs apart from `constraint`. Any difference observed
    // below is therefore attributable to the constraint name and to nothing
    // else — not to the code, the message or the severity.
    const replay = mapDatabaseError(pgError('23505', { constraint: CONSTRAINT.idempotencyToken }))
    const renumber = mapDatabaseError(pgError('23505', { constraint: CONSTRAINT.revisionNumber }))

    expect(replay).toBeInstanceOf(StatesmanError)
    expect(renumber).toBeInstanceOf(StatesmanError)
    if (!(replay instanceof StatesmanError) || !(renumber instanceof StatesmanError)) return

    expect(replay.kind).toBe('idempotency_replay')
    expect(renumber.kind).toBe('revision_number_conflict')
    expect(
      replay.kind === renumber.kind,
      'the two 23505 constraints collapsed into one error kind. A replay must be ' +
        're-read and a revision-number clash must be retried; one type cannot carry ' +
        'both instructions.',
    ).toBe(false)
    expect(replay.constructor.name).not.toBe(renumber.constructor.name)

    // The semantic difference, which is the reason the types are distinct.
    expect(isRetryable(pgError('23505', { constraint: CONSTRAINT.revisionNumber }))).toBe(true)
    expect(isRetryable(pgError('23505', { constraint: CONSTRAINT.idempotencyToken }))).toBe(false)

    // Both are still 409 — the distinction is NOT carried by the status code, so
    // an HTTP layer that only reads the status cannot recover it. That is why
    // `isRetryable` exists.
    expect(replay.httpStatus).toBe(409)
    expect(renumber.httpStatus).toBe(409)

    // NEGATIVE CONTROL: an unrecognised constraint must not be absorbed into
    // either special case. Without this leg a `default` arm that returned
    // `IdempotencyReplayError` would satisfy everything above.
    const other = mapDatabaseError(pgError('23505', { constraint: 'some_other_uq' }))
    expect(other).toBeInstanceOf(StatesmanError)
    if (other instanceof StatesmanError) {
      expect(other.kind).toBe('unique_violation')
      expect(other.constraintName).toBe('some_other_uq')
    }
  })

  it('carries the constraint name through, so a diagnosis is possible', () => {
    const mapped = mapDatabaseError(pgError('23505', { constraint: CONSTRAINT.revisionNumber }))
    expect(mapped instanceof StatesmanError && mapped.constraintName).toBe('dr_no_uq')
    // The spellings are the migration's, asserted here so renaming a constraint
    // in SQL without updating CONSTRAINT is caught by the unit gate.
    expect(CONSTRAINT.idempotencyToken).toBe('dr_token_uq')
    expect(CONSTRAINT.revisionNumber).toBe('dr_no_uq')
  })
})

describe('mapDatabaseError: what must NOT be mapped', () => {
  it('passes a non-Postgres value through unchanged', () => {
    const plain = new Error('something else went wrong')
    expect(mapDatabaseError(plain)).toBe(plain)
    expect(mapDatabaseError('a string')).toBe('a string')
    expect(mapDatabaseError(undefined)).toBe(undefined)
    expect(mapDatabaseError(null)).toBe(null)
    expect(httpStatusFor(plain)).toBe(500)
  })

  it('does not mistake a Node error code for a SQLSTATE', () => {
    // `EPIPE` is five uppercase characters and passes the SQLSTATE shape test.
    // Without the `severity` requirement a dropped socket would be reported as
    // though the server had answered, which is why that requirement exists.
    const socket = { code: 'EPIPE', message: 'write EPIPE' }
    expect(
      mapDatabaseError(socket),
      'a socket failure was mapped as a database answer; the severity requirement ' +
        'in asPgError() is not doing its job',
    ).toBe(socket)

    // POSITIVE CONTROL for the same path: add the field `pg` always sets and the
    // identical value IS mapped. So the rejection above is attributable to the
    // missing severity, not to the shape test or to the object being unreachable.
    const mapped = mapDatabaseError({ ...socket, severity: 'ERROR' })
    expect(mapped).toBeInstanceOf(StatesmanError)
    expect(mapped instanceof StatesmanError && mapped.kind).toBe('unknown_database')
  })

  it('does not map a lowercase custom code as if it were uppercase (V13)', () => {
    // A lowercase custom SQLSTATE silently resolves to 42704 at the server, so
    // 'st001' never reaches this boundary as an append-only violation. If the
    // shape test were case-insensitive, a migration that typed 'st001' would
    // look correct here and raise undefined_object in production.
    const lower = { code: 'st001', severity: 'ERROR', message: 'append-only' }
    expect(mapDatabaseError(lower)).toBe(lower)

    // POSITIVE CONTROL: the uppercase spelling of the same code IS mapped.
    const upper = mapDatabaseError({ code: 'ST001', severity: 'ERROR', message: 'append-only' })
    expect(upper instanceof StatesmanError && upper.kind).toBe('append_only')
  })
})

describe('publicMessageFor never leaks a database message', () => {
  it('keeps the database text on the internal message and off the public one', () => {
    const secretish = 'duplicate key value violates unique constraint "dr_token_uq" DETAIL: Key (idempotency_token)=(aaaaaaaa-0000-0000-0000-000000000001) already exists'
    const raw = { code: '23505', severity: 'ERROR', message: secretish, constraint: CONSTRAINT.idempotencyToken }

    expect(publicMessageFor(raw)).not.toContain('dr_token_uq')
    expect(publicMessageFor(raw)).not.toContain('aaaaaaaa-0000')
    expect(publicMessageFor(raw)).toBe('This submission was already recorded.')

    // POSITIVE CONTROL. The database text must still be somewhere, or the
    // assertions above are satisfied by an error that dropped the detail on the
    // floor and logs nothing diagnosable.
    const mapped = mapDatabaseError(raw)
    expect(mapped instanceof Error && mapped.message).toContain('dr_token_uq')
  })

  it('falls back to a generic message for an unmapped value', () => {
    expect(publicMessageFor(new Error('internal detail'))).toBe(
      'The request could not be completed.',
    )
    expect(publicMessageFor(new Error('internal detail'))).not.toContain('internal detail')
  })
})
