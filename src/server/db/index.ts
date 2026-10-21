/**
 * The ONLY public surface of the data boundary.
 *
 * Everything outside `src/server/db/**` imports from here. What is deliberately
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
 *     `pg` import boundary stays inside this directory.
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
