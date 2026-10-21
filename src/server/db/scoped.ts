/**
 * The scoped entry points: `withUser`, `withMigrator`, and typed wrappers for the
 * SECURITY DEFINER lifecycle functions.
 *
 * This file contains NO `process.env` access and NO env-gated rollback path
 * (canon 8.3). Configuration lives in `pool.ts`; identity lives in
 * `../session/resolve`.
 */

import type { PoolClient } from 'pg'
import { z } from 'zod'
import {
  acquireAppClient,
  acquireMigratorClient,
  assertNotRequestRuntime,
  assertUnprivilegedOnce,
  statementTimeoutMs,
} from './pool'
import { ContextMismatchError, MigratorMisuseError, RowCountError, mapDatabaseError } from './errors'
import { isIdentityContextActive, resolveSession } from '../session/resolve'

/* ------------------------------------------------------------------ *
 * The narrow query surface
 * ------------------------------------------------------------------ */

export type SqlRow = Record<string, unknown>
export type SqlParams = readonly unknown[]

export interface QueryRows<T extends SqlRow> {
  readonly rows: readonly T[]
  /**
   * Rows returned, or rows affected for a write.
   *
   * A row count of 0 is NEVER a success signal (V7) and never distinguishes
   * denial from absence. Prefer `queryOne` / `queryAffectingOne`, which assert
   * the count for you.
   */
  readonly rowCount: number
}

/**
 * What a caller may do with a connection.
 *
 * Deliberately NOT the `pg` client: no `BEGIN`, no `COMMIT`, no `release`, no
 * `connection`, no `copyFrom`. Transaction control and identity belong to
 * `withUser`, and a caller that could issue them could also unset the context
 * the policies depend on. No `pg` type appears in this interface, so the public
 * surface does not drag the `pg` import boundary out of this directory.
 */
export interface ScopedQueries {
  /** Run a parameterised statement. SQL text is always a literal; values are always parameters. */
  query<T extends SqlRow = SqlRow>(sql: string, params?: SqlParams): Promise<QueryRows<T>>
  /** Exactly one row, or `RowCountError`. */
  queryOne<T extends SqlRow = SqlRow>(sql: string, params?: SqlParams): Promise<T>
  /** Exactly one row affected, or `RowCountError` (V7). */
  queryAffectingOne(sql: string, params?: SqlParams): Promise<void>
}

/** No runtime value: there is no brand constructor to export. */
declare const userScopedBrand: unique symbol

/** A connection inside a transaction whose `app.current_user_id` has been set AND verified. */
export type UserScopedClient = ScopedQueries & {
  /** The identity the policies will enforce for every statement on this client. */
  readonly userId: string
  readonly [userScopedBrand]: 'UserScopedClient'
}

/**
 * A privileged connection. Unbranded on purpose: nothing that requires a
 * `UserScopedClient` will accept one, so a fixture cannot be slipped into a
 * function that is supposed to be running under the app role.
 */
export type MigratorClient = ScopedQueries & { readonly userId: string }

function makeQueries(client: PoolClient, describe: string): ScopedQueries {
  async function query<T extends SqlRow = SqlRow>(sql: string, params?: SqlParams): Promise<QueryRows<T>> {
    try {
      const result = params === undefined ? await client.query(sql) : await client.query(sql, [...params])
      const rows = result.rows as T[]
      return { rows, rowCount: result.rowCount ?? rows.length }
    } catch (err: unknown) {
      throw mapDatabaseError(err)
    }
  }

  async function queryOne<T extends SqlRow = SqlRow>(sql: string, params?: SqlParams): Promise<T> {
    const result = await query<T>(sql, params)
    const row = result.rows[0]
    if (result.rows.length !== 1 || row === undefined) {
      throw new RowCountError(
        `${describe}: expected exactly 1 row, got ${String(result.rows.length)}`,
      )
    }
    return row
  }

  async function queryAffectingOne(sql: string, params?: SqlParams): Promise<void> {
    const result = await query(sql, params)
    if (result.rowCount !== 1) {
      // V7: a failing policy affects zero rows and raises nothing, so silence
      // has to be turned into an error here or it reads as success.
      throw new RowCountError(
        `${describe}: expected exactly 1 affected row, got ${String(result.rowCount)}`,
      )
    }
  }

  return { query, queryOne, queryAffectingOne }
}

/* ------------------------------------------------------------------ *
 * Transaction setup, shared by both entry points
 * ------------------------------------------------------------------ */

const SET_CONFIG_SQL = 'select set_config($1, $2, true) as applied'
const REQUIRE_USER_SQL = 'select app.require_user_id()::text as user_id'

const requireUserRow = z.object({ user_id: z.guid() })

/**
 * Open the transaction and install the identity, in the canon's order.
 *
 * `statement_timeout` is applied first so the two setup round trips are
 * themselves bounded. It is carried as a `set_config` PARAMETER, never
 * interpolated into SQL text.
 *
 * The eager `app.require_user_id()` call is load-bearing, not a sanity check:
 * with no context set, a `select ... where id = '<nonexistent uuid>'` returns
 * zero rows and NO error (V6), so the policy cannot be relied on to raise. One
 * extra round trip makes a context failure loud regardless of query shape, and
 * comparing the value it returns catches a context that was set to something
 * other than what we asked for.
 */
async function beginScopedTransaction(client: PoolClient, userId: string): Promise<void> {
  await client.query('begin')
  await client.query(SET_CONFIG_SQL, ['statement_timeout', String(statementTimeoutMs())])
  await client.query(SET_CONFIG_SQL, ['app.current_user_id', userId])

  const probe = await client.query(REQUIRE_USER_SQL)
  if (probe.rows.length !== 1) {
    throw new ContextMismatchError(
      `app.require_user_id() returned ${String(probe.rows.length)} rows; expected exactly 1`,
    )
  }
  const parsed = requireUserRow.safeParse(probe.rows[0])
  if (!parsed.success) {
    throw new ContextMismatchError(`app.require_user_id() returned an unexpected shape: ${parsed.error.message}`)
  }
  if (parsed.data.user_id.toLowerCase() !== userId) {
    throw new ContextMismatchError(
      'app.require_user_id() does not agree with the identity just set; abandoning the transaction',
    )
  }
}

/**
 * Close the transaction and hand the connection back clean.
 *
 * `DISCARD ALL` makes a mistaken `is_local = false` inert rather than merely
 * tested-for (V5): any session-level GUC, prepared statement or temp table the
 * transaction left behind is gone before the connection is reused.
 *
 * If COMMIT, ROLLBACK or DISCARD ALL fails, the connection is DESTROYED instead
 * of returned, because a connection whose state could not be cleared must not
 * carry one caller's identity into another caller's transaction.
 */
async function finishScopedTransaction(client: PoolClient, outcome: 'commit' | 'rollback'): Promise<void> {
  let tainted = false
  try {
    await client.query(outcome)
  } catch (err: unknown) {
    tainted = true
    if (outcome === 'commit') {
      client.release(true)
      throw mapDatabaseError(err)
    }
  }
  try {
    await client.query('discard all')
  } catch {
    tainted = true
  }
  client.release(tainted ? true : undefined)
}

/* ------------------------------------------------------------------ *
 * withUser
 * ------------------------------------------------------------------ */

/**
 * The request-path data entry point.
 *
 * It takes NO session parameter (ADR-0006). An identity arriving as an argument
 * type-checks when handed a victim's id and makes RLS faithfully enforce the
 * attacker's chosen identity, so `withUser` resolves the session itself.
 *
 * Body order:
 *   1. `assertUnprivilegedOnce()` — cached, so every path validates the role,
 *      independently of any framework lifecycle hook (V1, V3, V4);
 *   2. resolve the session (throws when there is none);
 *   3. BEGIN;
 *   4. `set_config('app.current_user_id', $1, true)`;
 *   5. eager `app.require_user_id()` (V6);
 *   6. the caller's work;
 *   7. COMMIT, or ROLLBACK on any throw;
 *   8. `DISCARD ALL`, then release.
 */
export async function withUser<T>(fn: (db: UserScopedClient) => Promise<T>): Promise<T> {
  await assertUnprivilegedOnce()
  const session = await resolveSession()

  const client = await acquireAppClient()
  let outcome: 'commit' | 'rollback' = 'rollback'
  try {
    await beginScopedTransaction(client, session.userId)
    // AST-ALLOW(brand-mint): the sole mint site for UserScopedClient.
    const scoped = {
      ...makeQueries(client, 'withUser'),
      userId: session.userId,
    } as UserScopedClient
    const value = await fn(scoped)
    outcome = 'commit'
    return value
  } catch (err: unknown) {
    throw mapDatabaseError(err)
  } finally {
    await finishScopedTransaction(client, outcome)
  }
}

/* ------------------------------------------------------------------ *
 * withMigrator — TESTS AND MIGRATIONS ONLY
 * ------------------------------------------------------------------ */

/**
 * ===================================================================
 *  DO NOT CALL THIS FROM A REQUEST PATH. EVER.
 * ===================================================================
 *
 * `statesman_migrator` is a member of `statesman_owner`. It exists to create
 * template databases, apply migrations and build fixtures. Reaching it from a
 * route handler hands a request the schema owner's privileges.
 *
 * Unlike `withUser`, this does NOT call `assertUnprivilegedOnce()` — it could
 * not, because the role it uses is privileged by design. That is precisely why
 * the two guards below exist, and why the client it yields is unbranded.
 *
 * Guard 1 (structural, verified): `assertNotRequestRuntime` refuses when
 * `process.env.NEXT_RUNTIME` is set. next@16.4.2's CLI sets it for `dev`,
 * `build` and `start`; a `tsx` or `vitest` process does not.
 *
 * Guard 2 (structural, partial): refuses when an identity context is open,
 * which an authenticated request always has. It does NOT cover a pre-identity
 * request path (sign-in, sign-up) on a custom server that bypasses the Next CLI.
 *
 * Identity is still set, and still verified eagerly, because `decision` and
 * `decision_revision` are FORCE ROW LEVEL SECURITY: the owner is subject to the
 * policies too (V8), so a migrator transaction without context sees nothing.
 */
export async function withMigrator<T>(userId: string, fn: (db: MigratorClient) => Promise<T>): Promise<T> {
  assertNotRequestRuntime('withMigrator')
  if (isIdentityContextActive()) {
    throw new MigratorMisuseError(
      'withMigrator was called inside an identity context, which means a request path reached it. ' +
        'Use withUser.',
    )
  }
  const parsed = z.guid().safeParse(userId)
  if (!parsed.success) {
    throw new MigratorMisuseError('withMigrator was called with a userId that is not a uuid')
  }
  const normalisedUserId = parsed.data.toLowerCase()

  const client = await acquireMigratorClient()
  let outcome: 'commit' | 'rollback' = 'rollback'
  try {
    await beginScopedTransaction(client, normalisedUserId)
    const scoped: MigratorClient = {
      ...makeQueries(client, 'withMigrator'),
      userId: normalisedUserId,
    }
    const value = await fn(scoped)
    outcome = 'commit'
    return value
  } catch (err: unknown) {
    throw mapDatabaseError(err)
  } finally {
    await finishScopedTransaction(client, outcome)
  }
}

/* ------------------------------------------------------------------ *
 * Typed wrappers for the SECURITY DEFINER lifecycle functions
 * ------------------------------------------------------------------ */

/**
 * Input validation mirrors the constraints the database itself enforces, and
 * invents none:
 *   - `confidence` is `smallint not null check (confidence between 0 and 100)`;
 *   - `forecast`, `horizon`, `rationale` are `text not null` with NO length or
 *     content check, so none is imposed here. A validator stricter than its
 *     column rejects values the database considers legal, and the rejection
 *     then looks like a database rule that does not exist.
 *   - ids are 8-4-4-4-12 hex (`z.guid()`), which is what the `uuid` type
 *     accepts. `z.uuid()` enforces an RFC version nibble and rejects this
 *     project's own seeded ids — verified by execution against zod@4.6.7.
 *
 * V25: `z.toJSONSchema()` drops refinements, so these rules must run here, on
 * the server, after parse — they cannot be delegated to a constrained decoder.
 */
const revisionInputSchema = z.object({
  decisionId: z.guid(),
  idempotencyToken: z.guid(),
  content: z.json(),
  confidence: z.int().min(0).max(100),
  forecast: z.string(),
  horizon: z.string(),
  rationale: z.string(),
})

export type RevisionInput = z.input<typeof revisionInputSchema>

const revisionResultRow = z.object({
  revision_id: z.guid(),
  revision_no: z.number().int(),
  replayed: z.boolean(),
})

export interface RevisionResult {
  readonly revisionId: string
  readonly revisionNo: number
  /**
   * True when the idempotency token had already been used and the EXISTING
   * revision is being returned. Not an error, and not a new write.
   */
  readonly replayed: boolean
}

/**
 * Explicit casts on every placeholder.
 *
 * These are static SQL text, not interpolation (rule 4). They pin overload
 * resolution to `app.submit_decision(uuid,uuid,jsonb,smallint,text,text,text)`
 * so adding an overload later cannot silently re-target the call.
 */
const DEFINER_ARGS = '$1::uuid, $2::uuid, $3::jsonb, $4::smallint, $5::text, $6::text, $7::text'
const SUBMIT_DECISION_SQL = `select revision_id, revision_no, replayed from app.submit_decision(${DEFINER_ARGS})`
const APPEND_REVISION_SQL = `select revision_id, revision_no, replayed from app.append_revision(${DEFINER_ARGS})`
const STAMP_MILESTONE_SQL = 'select app.stamp_milestone($1::uuid, $2::text) as stamped'

function definerArgs(input: RevisionInput): SqlParams {
  const parsed = revisionInputSchema.parse(input)
  return [
    parsed.decisionId,
    parsed.idempotencyToken,
    // jsonb is handed over as a JSON string, not as an object: `z.json()` admits
    // a bare string or number, and node-postgres would send those as raw text,
    // which `::jsonb` then rejects.
    JSON.stringify(parsed.content),
    parsed.confidence,
    parsed.forecast,
    parsed.horizon,
    parsed.rationale,
  ]
}

async function callRevisionDefiner(
  db: UserScopedClient,
  sql: string,
  input: RevisionInput,
): Promise<RevisionResult> {
  const row = await db.queryOne(sql, definerArgs(input))
  const parsed = revisionResultRow.safeParse(row)
  if (!parsed.success) {
    throw new ContextMismatchError(`lifecycle function returned an unexpected shape: ${parsed.error.message}`)
  }
  return {
    revisionId: parsed.data.revision_id,
    revisionNo: parsed.data.revision_no,
    replayed: parsed.data.replayed,
  }
}

/**
 * `app.submit_decision` — first revision plus the `submitted_at` stamp.
 *
 * Identity is derived inside the function (`app.require_user_id()`), never
 * passed, so there is no user-id parameter to supply and no way to aim it at
 * someone else's decision. Raises ST010 when the row is not a submittable draft
 * of the caller's, and ST005 when the stamp did not affect exactly one row.
 */
export async function submitDecision(db: UserScopedClient, input: RevisionInput): Promise<RevisionResult> {
  return callRevisionDefiner(db, SUBMIT_DECISION_SQL, input)
}

/**
 * `app.append_revision` — a correction to an already submitted decision.
 *
 * Raises ST011 when the decision is not a submitted one of the caller's. A
 * 23505 on `dr_no_uq` surfaces as a RETRYABLE `RevisionNumberConflictError`;
 * one on `dr_token_uq` surfaces as `IdempotencyReplayError`, which is not
 * retryable and means "re-read the existing revision".
 */
export async function appendRevision(db: UserScopedClient, input: RevisionInput): Promise<RevisionResult> {
  return callRevisionDefiner(db, APPEND_REVISION_SQL, input)
}

/** The four milestones `app.stamp_milestone` accepts, as the migration lists them. */
export const MILESTONES = ['challenged', 'reflected', 'action_recorded', 'closed'] as const
const milestoneSchema = z.enum(MILESTONES)
export type MilestoneName = z.infer<typeof milestoneSchema>

const stampInputSchema = z.object({
  decisionId: z.guid(),
  milestone: milestoneSchema,
})

export type StampMilestoneInput = z.input<typeof stampInputSchema>

/**
 * `app.stamp_milestone` — write one milestone timestamp.
 *
 * `statesman_app` holds `UPDATE (draft_payload)` only, so a direct
 * `update decision set challenged_at = now()` raises 42501. This definer
 * function is the only legal writer.
 *
 * The milestone name is validated against the same four literals the function
 * checks, so an ST012 from the database means the TypeScript union and the SQL
 * list have drifted — which is why `BadMilestoneError` is a 500, not a 400.
 */
export async function stampMilestone(db: UserScopedClient, input: StampMilestoneInput): Promise<void> {
  const parsed = stampInputSchema.parse(input)
  // The function returns void, so exactly one row comes back with a null column.
  // `queryOne` asserts that, rather than trusting a row count of zero (V7).
  await db.queryOne(STAMP_MILESTONE_SQL, [parsed.decisionId, parsed.milestone])
}
