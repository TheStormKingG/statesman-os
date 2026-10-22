/**
 * SQLSTATE -> typed domain error mapping for the data boundary.
 *
 * This module is intentionally dependency-free. It does NOT import `pg`:
 *   - the `pg` import boundary (canon 6.1) stays confined to `pool.ts`;
 *   - a structural guard survives two copies of `pg` in one process, which an
 *     `instanceof DatabaseError` check does not.
 *
 * Custom SQLSTATEs are UPPERCASE. A lowercase custom code silently resolves to
 * 42704 (V13), so the keys below are written exactly as the migrations raise them.
 */

export type ErrorKind =
  | 'unauthenticated'
  | 'missing_context'
  | 'context_mismatch'
  | 'permission_denied'
  | 'append_only'
  | 'illegal_transition'
  | 'frozen_draft'
  | 'row_count'
  | 'invalid_decision_state'
  | 'bad_milestone'
  | 'posture'
  | 'idempotency_replay'
  | 'revision_number_conflict'
  | 'unique_violation'
  | 'not_found'
  | 'privilege_assertion'
  | 'migrator_misuse'
  | 'configuration'
  | 'unknown_database'
  // ── Supabase Auth (GoTrue) ────────────────────────────────────────────────
  // A THIRD error source, alongside PostgreSQL SQLSTATEs and PostgREST codes.
  // It is in this union rather than in a parallel one so `httpStatusFor`,
  // `publicMessageFor` and `isRetryable` keep working for every error the
  // application can produce; the classes themselves live in `auth-errors.ts`
  // because this file is about the data boundary and GoTrue is not it.
  | 'invalid_credentials'
  | 'email_not_confirmed'
  | 'signup_disabled'
  | 'rate_limited'
  | 'weak_password'
  | 'unknown_auth'

export interface StatesmanErrorInit {
  readonly message: string
  readonly kind: ErrorKind
  readonly httpStatus: number
  /** Safe to render to a client. Never contains a database message. */
  readonly publicMessage: string
  /** True when the SAME call, unchanged, may succeed on a retry. */
  readonly retryable?: boolean | undefined
  readonly sqlState?: string | undefined
  readonly constraintName?: string | undefined
  readonly cause?: unknown
}

/** Base class for every error this boundary raises. */
export class StatesmanError extends Error {
  readonly kind: ErrorKind
  readonly httpStatus: number
  readonly publicMessage: string
  readonly retryable: boolean
  readonly sqlState: string | undefined
  readonly constraintName: string | undefined

  constructor(init: StatesmanErrorInit) {
    super(init.message, { cause: init.cause })
    this.name = new.target.name
    this.kind = init.kind
    this.httpStatus = init.httpStatus
    this.publicMessage = init.publicMessage
    this.retryable = init.retryable ?? false
    this.sqlState = init.sqlState
    this.constraintName = init.constraintName
  }
}

type Detail = {
  readonly sqlState?: string | undefined
  readonly constraintName?: string | undefined
  readonly cause?: unknown
}

/* ------------------------------------------------------------------ *
 * Boundary / configuration errors (no SQLSTATE behind them)
 * ------------------------------------------------------------------ */

/** No identity in the request context. The caller never authenticated. */
export class UnauthenticatedError extends StatesmanError {
  constructor(message: string, detail: Detail = {}) {
    super({
      ...detail,
      message,
      kind: 'unauthenticated',
      httpStatus: 401,
      publicMessage: 'Sign in to continue.',
    })
  }
}

/** A required environment variable is missing or malformed. */
export class ConfigurationError extends StatesmanError {
  constructor(message: string, detail: Detail = {}) {
    super({
      ...detail,
      message,
      kind: 'configuration',
      httpStatus: 500,
      publicMessage: 'The server is misconfigured.',
    })
  }
}

/**
 * The connection's role is not safe to carry user data: it is a superuser, has
 * BYPASSRLS, owns a relation in `public`, or can reach a privileged role by
 * SET ROLE (V1, V3, V4). Fails the process's first data call, closed.
 */
export class PrivilegeAssertionError extends StatesmanError {
  constructor(message: string, detail: Detail = {}) {
    super({
      ...detail,
      message,
      kind: 'privilege_assertion',
      httpStatus: 500,
      publicMessage: 'The server is misconfigured.',
    })
  }
}

/** `withMigrator` was reached from somewhere it must never be reachable from. */
export class MigratorMisuseError extends StatesmanError {
  constructor(message: string, detail: Detail = {}) {
    super({
      ...detail,
      message,
      kind: 'migrator_misuse',
      httpStatus: 500,
      publicMessage: 'The server is misconfigured.',
    })
  }
}

/**
 * The eager `app.require_user_id()` probe returned an identity other than the
 * one just set. The transaction is abandoned rather than trusted.
 */
export class ContextMismatchError extends StatesmanError {
  constructor(message: string, detail: Detail = {}) {
    super({
      ...detail,
      message,
      kind: 'context_mismatch',
      httpStatus: 500,
      publicMessage: 'The request could not be completed.',
    })
  }
}

/**
 * The row does not exist, or does not belong to the caller.
 *
 * NO SQLSTATE MAPS HERE, and that is deliberate. Under RLS a missing row and a
 * someone-else's row are byte-identical (V7, V19), so the database cannot tell
 * us which it was. Only a service that has separately read a row it owns may
 * raise this. Nothing in this module manufactures a 404 out of a row count.
 */
export class NotFoundError extends StatesmanError {
  constructor(message: string, detail: Detail = {}) {
    super({
      ...detail,
      message,
      kind: 'not_found',
      httpStatus: 404,
      publicMessage: 'Not found.',
    })
  }
}

/* ------------------------------------------------------------------ *
 * SQLSTATE-backed errors
 * ------------------------------------------------------------------ */

/** 28000 — `app.require_user_id()` raised: no transaction-local identity. */
export class MissingContextError extends StatesmanError {
  constructor(message: string, detail: Detail = {}) {
    super({
      ...detail,
      message,
      kind: 'missing_context',
      // 500, not 401: withUser always sets context before the caller runs, so a
      // 28000 reaching here means the data path itself is broken.
      httpStatus: 500,
      publicMessage: 'The request could not be completed.',
    })
  }
}

/** 42501 — the app role lacks the privilege. Grant-absence is working. */
export class PermissionDeniedError extends StatesmanError {
  constructor(message: string, detail: Detail = {}) {
    super({
      ...detail,
      message,
      kind: 'permission_denied',
      httpStatus: 403,
      publicMessage: 'That operation is not permitted.',
    })
  }
}

/** ST001 — append-only violation (UPDATE/DELETE/TRUNCATE on an immutable row). */
export class AppendOnlyError extends StatesmanError {
  constructor(message: string, detail: Detail = {}) {
    super({
      ...detail,
      message,
      kind: 'append_only',
      httpStatus: 409,
      publicMessage: 'This record cannot be changed once written.',
    })
  }
}

/** ST002 — illegal lifecycle state transition. */
export class IllegalTransitionError extends StatesmanError {
  constructor(message: string, detail: Detail = {}) {
    super({
      ...detail,
      message,
      kind: 'illegal_transition',
      httpStatus: 409,
      publicMessage: 'That step is not available from the current state.',
    })
  }
}

/** ST003 — the draft of a submitted decision is frozen. */
export class FrozenDraftError extends StatesmanError {
  constructor(message: string, detail: Detail = {}) {
    super({
      ...detail,
      message,
      kind: 'frozen_draft',
      httpStatus: 409,
      publicMessage: 'This decision has been submitted and can no longer be edited.',
    })
  }
}

/**
 * ST005 — a privileged write asserted `row_count = 1` and did not get it.
 *
 * 409, not 404: the row was reachable when it was locked, so a zero count here
 * means the state moved under us, not that nothing was there. A real 404 needs
 * a separate owned-row read (see NotFoundError).
 */
export class RowCountError extends StatesmanError {
  constructor(message: string, detail: Detail = {}) {
    super({
      ...detail,
      message,
      kind: 'row_count',
      httpStatus: 409,
      publicMessage: 'The record changed while this request was in flight.',
    })
  }
}

/** ST010 / ST011 — not a submittable draft / not a submitted decision. */
export class InvalidDecisionStateError extends StatesmanError {
  constructor(message: string, detail: Detail = {}) {
    super({
      ...detail,
      message,
      kind: 'invalid_decision_state',
      httpStatus: 409,
      publicMessage: 'That step is not available from the current state.',
    })
  }
}

/**
 * ST012 — the database rejected a milestone name.
 *
 * 500: `stampMilestone` validates the four-literal union before the call, so an
 * ST012 means the TypeScript union and the SQL list have drifted apart. That is
 * a deployment inconsistency, not bad client input.
 */
export class BadMilestoneError extends StatesmanError {
  constructor(message: string, detail: Detail = {}) {
    super({
      ...detail,
      message,
      kind: 'bad_milestone',
      httpStatus: 500,
      publicMessage: 'The request could not be completed.',
    })
  }
}

/** ST099 — `app.verify_security_posture()` failed. */
export class PostureError extends StatesmanError {
  constructor(message: string, detail: Detail = {}) {
    super({
      ...detail,
      message,
      kind: 'posture',
      httpStatus: 500,
      publicMessage: 'The server is misconfigured.',
    })
  }
}

/**
 * 23505 on `dr_token_uq` — two callers raced past the idempotency probe with the
 * same token. The right response is to re-read the existing revision, NOT to
 * retry the write, which is why this is a distinct type.
 */
export class IdempotencyReplayError extends StatesmanError {
  constructor(message: string, detail: Detail = {}) {
    super({
      ...detail,
      message,
      kind: 'idempotency_replay',
      httpStatus: 409,
      publicMessage: 'This submission was already recorded.',
    })
  }
}

/**
 * 23505 on `dr_no_uq` — two revisions computed the same `revision_no`. The right
 * response is to retry, which recomputes `max(revision_no) + 1`. Flattening this
 * into the same error as a replay would turn a retryable conflict into a dead end.
 */
export class RevisionNumberConflictError extends StatesmanError {
  constructor(message: string, detail: Detail = {}) {
    super({
      ...detail,
      message,
      kind: 'revision_number_conflict',
      httpStatus: 409,
      publicMessage: 'Another revision was saved first. Please try again.',
      retryable: true,
    })
  }
}

/** 23505 on any other constraint. Carries the constraint name for diagnosis. */
export class UniqueViolationError extends StatesmanError {
  constructor(message: string, detail: Detail = {}) {
    super({
      ...detail,
      message,
      kind: 'unique_violation',
      httpStatus: 409,
      publicMessage: 'That value is already in use.',
    })
  }
}

/** A database error with a SQLSTATE this boundary does not model. */
export class UnknownDatabaseError extends StatesmanError {
  constructor(message: string, detail: Detail = {}) {
    super({
      ...detail,
      message,
      kind: 'unknown_database',
      httpStatus: 500,
      publicMessage: 'The request could not be completed.',
    })
  }
}

/* ------------------------------------------------------------------ *
 * Mapping
 * ------------------------------------------------------------------ */

/** Constraint names, from migration 0003. Spelled once. */
export const CONSTRAINT = {
  idempotencyToken: 'dr_token_uq',
  revisionNumber: 'dr_no_uq',
} as const

type Factory = (message: string, detail: Detail) => StatesmanError

const BY_SQLSTATE: Readonly<Record<string, Factory>> = {
  '28000': (m, d) => new MissingContextError(m, d),
  '42501': (m, d) => new PermissionDeniedError(m, d),
  ST001: (m, d) => new AppendOnlyError(m, d),
  ST002: (m, d) => new IllegalTransitionError(m, d),
  ST003: (m, d) => new FrozenDraftError(m, d),
  ST005: (m, d) => new RowCountError(m, d),
  ST010: (m, d) => new InvalidDecisionStateError(m, d),
  ST011: (m, d) => new InvalidDecisionStateError(m, d),
  ST012: (m, d) => new BadMilestoneError(m, d),
  ST099: (m, d) => new PostureError(m, d),
  '23505': (m, d) => {
    switch (d.constraintName) {
      case CONSTRAINT.idempotencyToken:
        return new IdempotencyReplayError(m, d)
      case CONSTRAINT.revisionNumber:
        return new RevisionNumberConflictError(m, d)
      default:
        return new UniqueViolationError(m, d)
    }
  },
}

/** SQLSTATEs are exactly five characters drawn from [0-9A-Z]. */
const SQLSTATE_SHAPE = /^[0-9A-Z]{5}$/

interface PgErrorShape {
  readonly code: string
  readonly constraintName: string | undefined
  readonly message: string
}

/**
 * Recognise a Postgres error structurally.
 *
 * The `severity` requirement is load-bearing: several Node error codes are also
 * five uppercase characters (`EPIPE`), and without it a socket failure would be
 * mapped as if the server had answered. A code this module models is accepted
 * even without `severity`, so a wrapped error still maps.
 */
function asPgError(value: unknown): PgErrorShape | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { code?: unknown; constraint?: unknown; severity?: unknown; message?: unknown }
  const code = candidate.code
  if (typeof code !== 'string' || !SQLSTATE_SHAPE.test(code)) return undefined
  if (typeof candidate.severity !== 'string' && !(code in BY_SQLSTATE)) return undefined
  return {
    code,
    constraintName: typeof candidate.constraint === 'string' ? candidate.constraint : undefined,
    message: typeof candidate.message === 'string' ? candidate.message : 'database error',
  }
}

/**
 * Translate a thrown value into a typed domain error.
 *
 * Anything that is not a recognisable Postgres error — including an error this
 * module already produced — is returned unchanged, so this is safe to apply at
 * every layer. Returns `unknown` because its result is meant to be re-thrown.
 */
export function mapDatabaseError(value: unknown): unknown {
  if (value instanceof StatesmanError) return value
  const pg = asPgError(value)
  if (pg === undefined) return value
  const detail: Detail = { sqlState: pg.code, constraintName: pg.constraintName, cause: value }
  const factory = BY_SQLSTATE[pg.code]
  const message = `[${pg.code}] ${pg.message}`
  return factory === undefined ? new UnknownDatabaseError(message, detail) : factory(message, detail)
}

/**
 * HTTP status for a thrown value.
 *
 * 404 and 409 stay distinguishable: no SQLSTATE produces 404, because under RLS
 * absence and denial are indistinguishable (V19). A 404 only ever comes from a
 * `NotFoundError` raised by a service that read a row it owns.
 */
export function httpStatusFor(value: unknown): number {
  const mapped = mapDatabaseError(value)
  return mapped instanceof StatesmanError ? mapped.httpStatus : 500
}

/** True when re-issuing the identical call may succeed. */
export function isRetryable(value: unknown): boolean {
  const mapped = mapDatabaseError(value)
  return mapped instanceof StatesmanError && mapped.retryable
}

/** A client-safe message. Never a database message. */
export function publicMessageFor(value: unknown): string {
  const mapped = mapDatabaseError(value)
  return mapped instanceof StatesmanError ? mapped.publicMessage : 'The request could not be completed.'
}

/* ------------------------------------------------------------------ *
 * The Supabase / PostgREST layer
 * ------------------------------------------------------------------ */

/**
 * A PostgREST error as it arrives in the browser. Read structurally, for the same reason
 * the pg path is: an `instanceof` check does not survive two copies of a library in one
 * process, and this module stays dependency-free.
 */
interface PostgrestShape {
  readonly code: string
  readonly message: string
  readonly details?: string | null
  readonly hint?: string | null
}

function asPostgrestError(value: unknown): PostgrestShape | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  if (typeof v['code'] !== 'string' || typeof v['message'] !== 'string') return undefined
  return {
    code: v['code'],
    message: v['message'],
    details: typeof v['details'] === 'string' ? v['details'] : null,
    hint: typeof v['hint'] === 'string' ? v['hint'] : null,
  }
}

/**
 * PostgREST does not expose `constraint` as its own field the way `pg` does, so the
 * constraint name has to be recovered from the message or details. This matters for one
 * specific reason and it is not cosmetic: `dr_token_uq` means a REPLAY (return the
 * existing revision) and `dr_no_uq` means a revision-number CONFLICT (recompute and
 * retry). Both arrive as SQLSTATE 23505. Flattening them to one "conflict" would make a
 * safe replay look like a failure and a genuine conflict look retryable in the wrong way.
 */
function constraintFrom(e: PostgrestShape): string | undefined {
  const haystack = `${e.message} ${e.details ?? ''}`
  for (const name of Object.values(CONSTRAINT)) {
    if (haystack.includes(name)) return name
  }
  return undefined
}

/** Map a PostgREST error to the same domain taxonomy the pg path produces. */
export function mapPostgrestError(value: unknown): unknown {
  if (value instanceof StatesmanError) return value
  const e = asPostgrestError(value)
  if (e === undefined) return value
  const detail: Detail = {
    sqlState: e.code,
    constraintName: constraintFrom(e),
    cause: value,
  }
  const factory = BY_SQLSTATE[e.code]
  const message = `[${e.code}] ${e.message}`
  return factory === undefined ? new UnknownDatabaseError(message, detail) : factory(message, detail)
}

/* ------------------------------------------------------------------ *
 * Zero rows is NOT absence
 * ------------------------------------------------------------------ */

/**
 * THE MOST IMPORTANT TYPE IN THIS FILE, and the one the architecture change forced.
 *
 * On the server path a missing identity RAISED SQLSTATE 28000, because
 * `app.require_user_id()` raised. On Supabase, `auth.uid()` returns NULL instead
 * (measured, with a paired control: as `authenticated` with no claim the read returns 0
 * rows and NO error; with the claim it returns the row). So RLS denial now arrives as an
 * EMPTY RESULT, indistinguishable at the wire from "the row genuinely does not exist".
 *
 * Collapsing those two into `null` is how a denial becomes a 404 and a security event
 * becomes a shrug. Worse, Slice 2 established that an EMPTY forced-RLS table does not
 * deny at all — the policy qual is never evaluated — so "0 rows" can additionally mean
 * "the table is empty and nothing was ever checked".
 *
 * Callers are therefore forced to name which of the three they are looking at. There is
 * deliberately no helper that turns this back into `T | null`.
 */
export type RowOutcome<T> =
  | { readonly kind: 'row'; readonly row: T }
  | { readonly kind: 'empty'; readonly reason: 'denied-or-absent'; readonly note: string }

/**
 * Wrap a single-row read. `empty` is returned rather than `null`, and its note states
 * plainly that the caller cannot tell denial from absence from this result alone.
 */
export function singleRowOutcome<T>(rows: readonly T[]): RowOutcome<T> {
  const first = rows[0]
  if (rows.length === 1 && first !== undefined) return { kind: 'row', row: first }
  if (rows.length === 0) {
    return {
      kind: 'empty',
      reason: 'denied-or-absent',
      note:
        'Zero rows. Under RLS with auth.uid() returning NULL this is indistinguishable ' +
        'from the row not existing, from the caller not owning it, and from the table ' +
        'being empty. Do not render this as "not found" without separate evidence.',
    }
  }
  throw new RowCountError(`expected at most 1 row, got ${String(rows.length)}`, {
    sqlState: undefined,
    cause: undefined,
  })
}
