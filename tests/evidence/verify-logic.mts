import {
  mapDatabaseError, httpStatusFor, isRetryable,
  MissingContextError, PermissionDeniedError, AppendOnlyError, IllegalTransitionError,
  FrozenDraftError, RowCountError, InvalidDecisionStateError, BadMilestoneError, PostureError,
  IdempotencyReplayError, RevisionNumberConflictError, UniqueViolationError, UnknownDatabaseError,
  NotFoundError, StatesmanError,
} from '/Users/stefangravesande/Documents/Projects/Stathos/src/server/db/index'
import { resolveSession, enterIdentityContext, isIdentityContextActive } from '/Users/stefangravesande/Documents/Projects/Stathos/src/server/session/resolve'
import { withMigrator } from '/Users/stefangravesande/Documents/Projects/Stathos/src/server/db/index'

let fails = 0
function check(name: string, ok: boolean, extra = '') {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -- ' + extra : ''}`)
}
const pgErr = (code: string, constraint?: string) =>
  Object.assign(new Error(`boom ${code}`), { code, severity: 'ERROR', ...(constraint ? { constraint } : {}) })

// --- SQLSTATE table -------------------------------------------------------
// The third slot holds an error CLASS, used as the right operand of `instanceof`
// and for `.name`. Typed as a constructor rather than `Function`, which would also
// accept a plain function and make `instanceof` a runtime TypeError.
const cases: Array<[string, string | undefined, new (...args: never[]) => Error, number]> = [
  ['28000', undefined, MissingContextError, 500],
  ['42501', undefined, PermissionDeniedError, 403],
  ['ST001', undefined, AppendOnlyError, 409],
  ['ST002', undefined, IllegalTransitionError, 409],
  ['ST003', undefined, FrozenDraftError, 409],
  ['ST005', undefined, RowCountError, 409],
  ['ST010', undefined, InvalidDecisionStateError, 409],
  ['ST011', undefined, InvalidDecisionStateError, 409],
  ['ST012', undefined, BadMilestoneError, 500],
  ['ST099', undefined, PostureError, 500],
  ['23505', 'dr_token_uq', IdempotencyReplayError, 409],
  ['23505', 'dr_no_uq', RevisionNumberConflictError, 409],
  ['23505', 'app_user_email_uq', UniqueViolationError, 409],
  ['22003', undefined, UnknownDatabaseError, 500],
]
for (const [code, constraint, Cls, status] of cases) {
  const mapped = mapDatabaseError(pgErr(code, constraint))
  check(`${code}${constraint ? '/' + constraint : ''} -> ${Cls.name}`, mapped instanceof Cls,
    mapped instanceof StatesmanError ? mapped.kind : String(mapped))
  check(`${code}${constraint ? '/' + constraint : ''} -> HTTP ${status}`, httpStatusFor(pgErr(code, constraint)) === status,
    String(httpStatusFor(pgErr(code, constraint))))
}

// --- the two 23505 branches are NOT flattened -----------------------------
const replay = mapDatabaseError(pgErr('23505', 'dr_token_uq'))
const renum = mapDatabaseError(pgErr('23505', 'dr_no_uq'))
check('23505 branches are distinct types', replay!.constructor !== renum!.constructor)
check('dr_no_uq is retryable', isRetryable(pgErr('23505', 'dr_no_uq')))
check('dr_token_uq is NOT retryable', !isRetryable(pgErr('23505', 'dr_token_uq')))

// --- 404 stays distinguishable from 409 -----------------------------------
check('NotFoundError -> 404', httpStatusFor(new NotFoundError('x')) === 404)
check('no SQLSTATE yields 404', !cases.some(([c, k]) => httpStatusFor(pgErr(c, k)) === 404))

// --- non-pg errors are not misclassified ----------------------------------
check('EPIPE is not a SQLSTATE', mapDatabaseError(Object.assign(new Error('e'), { code: 'EPIPE' })) instanceof StatesmanError === false)
check('ECONNREFUSED is not a SQLSTATE', mapDatabaseError(Object.assign(new Error('e'), { code: 'ECONNREFUSED' })) instanceof StatesmanError === false)
check('plain Error passes through', mapDatabaseError(new Error('plain')) instanceof StatesmanError === false)
check('already-mapped error passes through unchanged', mapDatabaseError(replay) === replay)
check('lowercase st010 is not treated as ST010', mapDatabaseError(pgErr('st010')) instanceof InvalidDecisionStateError === false)

// --- session resolution ---------------------------------------------------
check('no identity context is reported as inactive', !isIdentityContextActive())
let threw = ''
try { await resolveSession() } catch (e) { threw = (e as Error).constructor.name }
check('resolveSession throws with no identity (never returns null)', threw === 'UnauthenticatedError', threw)

await enterIdentityContext('aaaaaaaa-0000-0000-0000-000000000001', async () => {
  const s = await resolveSession()
  check('resolveSession returns the seeded identity', s.userId === 'aaaaaaaa-0000-0000-0000-000000000001', s.userId)
  check('identity context reported active', isIdentityContextActive())
})
check('identity context closed after the scope', !isIdentityContextActive())

let bad = ''
try { await enterIdentityContext('not-a-uuid', async () => undefined) } catch (e) { bad = (e as Error).constructor.name }
check('enterIdentityContext rejects a non-uuid', bad === 'UnauthenticatedError', bad)

// --- withMigrator guards (positive controls) ------------------------------
let g1 = ''
process.env.NEXT_RUNTIME = 'nodejs'
try { await withMigrator('aaaaaaaa-0000-0000-0000-000000000001', async () => undefined) } catch (e) { g1 = (e as Error).constructor.name }
check('withMigrator refuses under NEXT_RUNTIME', g1 === 'MigratorMisuseError', g1)
delete process.env.NEXT_RUNTIME

let g2 = ''
await enterIdentityContext('aaaaaaaa-0000-0000-0000-000000000001', async () => {
  try { await withMigrator('aaaaaaaa-0000-0000-0000-000000000001', async () => undefined) } catch (e) { g2 = (e as Error).constructor.name }
})
check('withMigrator refuses inside an identity context', g2 === 'MigratorMisuseError', g2)

console.log(fails === 0 ? '\nALL LOGIC CHECKS PASSED' : `\n${fails} LOGIC CHECK(S) FAILED`)
process.exit(fails === 0 ? 0 : 1)
