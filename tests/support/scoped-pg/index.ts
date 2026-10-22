/**
 * TEST-ONLY. Scoped SQL over a direct `pg` connection.
 *
 * ── WHAT THIS DIRECTORY IS, AND WHAT IT STOPPED BEING ──────────────────────
 *
 * This was `src/server/db/**` plus `src/server/session/resolve.ts`: the
 * production data boundary of ADR-0006. ADR-0015 moved the application to a
 * Next.js static export on GitHub Pages talking to Supabase from the browser,
 * so there is no server process at runtime and therefore no server-side
 * connection pool for `withUser` to scope. The production data layer is now
 * `src/lib/supabase/**`, which reaches PostgREST over HTTP and relies on RLS.
 *
 * Nothing under `src/` imports this directory, and nothing may: it is in
 * `tests/` precisely so that a future reader does not mistake `withUser` for a
 * guard that still protects a request path. What survives here is one real
 * need — the INTEGRATION HARNESS has to issue arbitrary SQL as a chosen role,
 * inside a transaction, to observe the policies directly. PostgREST cannot do
 * that, so the harness keeps a driver.
 *
 * ── THE INCOMPATIBILITY THIS MOVE DOES NOT FIX ─────────────────────────────
 *
 * `withUser` establishes identity with
 * `set_config('app.current_user_id', $1, true)` and then probes
 * `app.require_user_id()`. The Supabase-shaped migrations in
 * `supabase/migrations/` read identity from `auth.uid()`, which reads
 * `request.jwt.claim.sub`, and their policies never call the raising wrapper at
 * all. So against the ported schema this module sets a GUC nothing reads, and
 * its eager probe raises 28000.
 *
 * That is deliberate and it is NOT this move's job to repair. The files are
 * relocated byte-for-byte apart from their import specifiers and these
 * headers, so the still-green integration suite against `migrations/**` (the
 * pre-port local schema) keeps passing and a diff shows no behavioural change.
 * ADR-0015 assigns the rewrite — `request.jwt.claim.sub`,
 * `current_user = 'authenticated'`, `rolbypassrls = false`, zero owned
 * relations in `public`, and a present claim, with its own mutation — to the
 * harness port. Until that lands, treat this module as valid for the OLD
 * schema only.
 *
 * ── the original contract, which still describes this module ───────────────
 *
 * Everything outside this directory imports from here. What is deliberately
 * NOT exported:
 *
 *   - the `Pool` instances, and `acquireAppClient` / `acquireMigratorClient`.
 *     There is no reference by which a caller could open a connection outside a
 *     scoped transaction, so `withUser`'s identity, timeout and `DISCARD ALL`
 *     discipline cannot be sidestepped;
 *   - `closePools` and `resetPrivilegeAssertionCacheForTests`, which test setup
 *     imports from `./pool` directly;
 *   - any brand constructor. `AuthenticatedSession` and `UserScopedClient` are
 *     branded with `declare const ... : unique symbol`, which has no runtime
 *     value at all, so there is nothing to export;
 *   - any `pg` type. `ScopedQueries` is expressed in plain TypeScript, so the
 *     `pg` import boundary stays inside this directory — which is now
 *     `tests/support/scoped-pg/`, and `scripts/check-import-boundaries.ts`'s
 *     `DB_DIR_REL` points here rather than at `src/`.
 */

export { withUser, withMigrator, submitDecision, appendRevision, stampMilestone, MILESTONES } from './scoped'

export type {
  UserScopedClient,
  MigratorClient,
  ScopedQueries,
  QueryRows,
  SqlRow,
  SqlParams,
  RevisionInput,
  RevisionResult,
  StampMilestoneInput,
  MilestoneName,
} from './scoped'

export {
  StatesmanError,
  UnauthenticatedError,
  ConfigurationError,
  PrivilegeAssertionError,
  MigratorMisuseError,
  ContextMismatchError,
  NotFoundError,
  MissingContextError,
  PermissionDeniedError,
  AppendOnlyError,
  IllegalTransitionError,
  FrozenDraftError,
  RowCountError,
  InvalidDecisionStateError,
  BadMilestoneError,
  PostureError,
  IdempotencyReplayError,
  RevisionNumberConflictError,
  UniqueViolationError,
  UnknownDatabaseError,
  CONSTRAINT,
  mapDatabaseError,
  httpStatusFor,
  isRetryable,
  publicMessageFor,
} from './errors'

export type { ErrorKind, StatesmanErrorInit } from './errors'
