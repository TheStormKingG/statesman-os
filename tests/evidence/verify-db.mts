// Specifiers are written as string LITERALS and never assembled from a template.
// The import-boundary gate RESOLVES specifiers, so an expression it cannot
// evaluate is an [opaque-specifier] violation — that is exactly how the pg and
// pool boundaries were being evaded, and these three lines were the live
// instance: `${BASE}/db/pool` hid acquireAppClient from the gate entirely.
// closePools / acquireAppClient / assertUnprivilegedOnce are on R2's named
// allowance for tests/ and scripts/ (see POOL_TEST_ONLY_IMPORTS).
const { withUser, submitDecision, stampMilestone, mapDatabaseError } = await import(
  '/Users/stefangravesande/Documents/Projects/Stathos/tests/support/scoped-pg/index')
const { enterIdentityContext } = await import(
  '/Users/stefangravesande/Documents/Projects/Stathos/tests/support/scoped-pg/session')
const { assertUnprivilegedOnce, acquireAppClient, closePools } = await import(
  '/Users/stefangravesande/Documents/Projects/Stathos/tests/support/scoped-pg/pool')

const USER_A = 'aaaaaaaa-0000-0000-0000-000000000001'
let fails = 0
function check(name: string, ok: boolean, extra = '') {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -- ' + extra : ''}`)
}
const nameOf = (e: unknown) => (e instanceof Error ? e.constructor.name : String(e))

// 1. the role gate passes for statesman_app
try {
  await assertUnprivilegedOnce()
  check('assertUnprivilegedOnce PASSES as statesman_app', true)
} catch (e) {
  check('assertUnprivilegedOnce PASSES as statesman_app', false, (e as Error).message)
}

// 2. withUser fails closed with no identity
let noId = ''
try { await withUser(async () => 1) } catch (e) { noId = nameOf(e) }
check('withUser with no identity -> UnauthenticatedError', noId === 'UnauthenticatedError', noId)

// 3. the happy path: role, eager context probe, scoped read
await enterIdentityContext(USER_A, async () => {
  const seen = await withUser(async (db) => {
    const row = await db.queryOne<{ role: string; uid: string }>(
      'select current_user::text as role, app.require_user_id()::text as uid')
    const owned = await db.query<{ n: number }>('select count(*)::int as n from public.decision')
    return { role: row.role, uid: row.uid, clientUserId: db.userId, decisions: owned.rows[0]?.n }
  })
  check('withUser connects as statesman_app', seen.role === 'statesman_app', seen.role)
  check('eager app.require_user_id() agrees with the session', seen.uid === USER_A, seen.uid)
  check('UserScopedClient.userId is the session identity', seen.clientUserId === USER_A, seen.clientUserId)
  console.log(`INFO  decision rows visible to user A: ${String(seen.decisions)} ` +
    `(0 proves nothing on its own -- V18)`)
})

// 4. 28000 positive control: require_user_id outside any context
const raw = await acquireAppClient()
try {
  let got = ''
  try { await raw.query('select app.require_user_id()') } catch (e) { got = nameOf(mapDatabaseError(e)) }
  check('no context -> 28000 -> MissingContextError', got === 'MissingContextError', got)

  // 5. 42501 positive control: the app role cannot write a milestone column
  await raw.query('begin')
  let denied = ''
  try {
    await raw.query('update public.decision set submitted_at = now() where false')
  } catch (e) { denied = nameOf(mapDatabaseError(e)) }
  await raw.query('rollback')
  check('direct milestone write -> 42501 -> PermissionDeniedError', denied === 'PermissionDeniedError', denied)

  // 6. the connection comes back clean
  const leak = await raw.query(`select coalesce(current_setting('app.current_user_id', true), '<unset>') as v`)
  check('no identity GUC leaked onto a pooled connection', leak.rows[0]?.v === '' || leak.rows[0]?.v === '<unset>',
    String(leak.rows[0]?.v))
} finally {
  raw.release()
}

// 7. ST010 positive control through the typed wrapper (raises before any INSERT)
await enterIdentityContext(USER_A, async () => {
  let st010 = ''
  try {
    await withUser(async (db) => submitDecision(db, {
      decisionId: '11111111-2222-3333-4444-555555555555',
      idempotencyToken: '66666666-7777-8888-9999-aaaaaaaaaaaa',
      content: { title: 'probe', body: ['a', 1, null] },
      confidence: 50, forecast: 'f', horizon: 'h', rationale: 'r',
    }))
  } catch (e) { st010 = nameOf(e) }
  check('submitDecision on a foreign/absent decision -> ST010 -> InvalidDecisionStateError',
    st010 === 'InvalidDecisionStateError', st010)

  // 8. ST012 positive control on the raw definer call
  let st012 = ''
  try {
    await withUser(async (db) =>
      db.query('select app.stamp_milestone($1::uuid, $2::text)', ['11111111-2222-3333-4444-555555555555', 'bogus']))
  } catch (e) { st012 = nameOf(e) }
  check('bogus milestone -> ST012 -> BadMilestoneError', st012 === 'BadMilestoneError', st012)

  // 9. ...and the zod union makes ST012 unreachable from the validated path
  let zodStop = ''
  try {
    await withUser(async (db) => stampMilestone(db, { decisionId: USER_A, milestone: 'bogus' as never }))
  } catch (e) { zodStop = nameOf(e) }
  check('stampMilestone rejects a bogus milestone before the DB (ZodError)', zodStop === 'ZodError', zodStop)

  // 10. confidence bounds mirror the column check
  let conf = ''
  try {
    await withUser(async (db) => submitDecision(db, {
      decisionId: '11111111-2222-3333-4444-555555555555',
      idempotencyToken: '66666666-7777-8888-9999-bbbbbbbbbbbb',
      content: {}, confidence: 101, forecast: 'f', horizon: 'h', rationale: 'r',
    }))
  } catch (e) { conf = nameOf(e) }
  check('confidence 101 rejected before the DB (ZodError)', conf === 'ZodError', conf)
})

await closePools()
console.log(fails === 0 ? '\nALL DB CHECKS PASSED' : `\n${fails} DB CHECK(S) FAILED`)
process.exit(fails === 0 ? 0 : 1)
