/**
 * Boundary guards — controls for four guards that were proven VACUOUS.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * A prior adversarial pass built a mirrored checkout, removed ONE guard at a
 * time, and re-ran the integration suite. Four removals left the suite green at
 * 44/44, which means the suite could not see the guard at all:
 *
 *   M2  `withUser`'s eager `select app.require_user_id()` replaced with a
 *       fabricated local row.
 *   M3  `await assertUnprivilegedOnce()` deleted from `withUser`.
 *   M4  the `DISCARD ALL` block deleted from `finishScopedTransaction`
 *       (canon §7.6 names pooled-identity leak a RELEASE BLOCKER).
 *   M7  `queryAffectingOne`'s `rowCount !== 1` assertion replaced with
 *       `if (false)`.
 *
 * All four were separately measured as WORKING in production. They were not
 * broken; they were unobserved. This file observes them.
 *
 * ---------------------------------------------------------------------------
 * THE RULE EVERY TEST HERE OBEYS
 * ---------------------------------------------------------------------------
 * A guard whose removal leaves the suite green is not protecting anything the
 * suite can see. So each test asserts the guard's observable EFFECT — never its
 * source text — and each one was watched going red with the guard removed in a
 * scratch copy. Three consequences for how the tests are written:
 *
 *   1. Every denial is PAIRED with a positive control on the same path, because
 *      a rejection that would also happen with the guard absent is not evidence.
 *   2. The `DISCARD ALL` test asserts `pg_backend_pid()` is IDENTICAL across the
 *      two calls BEFORE it asserts anything was cleared. Two different backends
 *      would trivially not share state, so without that assertion the test
 *      proves nothing — it is the one line that makes the other two meaningful.
 *   3. The row-count test drives the throwing branch from BOTH sides (0 affected
 *      and 2 affected) and also records that the same statements return quietly
 *      through plain `query()`. Every existing call site affects exactly one
 *      row, so that branch is otherwise dead code.
 *
 * ---------------------------------------------------------------------------
 * TWO DELIBERATELY INVASIVE INSTRUMENTS, AND HOW THEY ARE PUT BACK
 * ---------------------------------------------------------------------------
 * `isolate: false` (vitest.integration.config.ts) means every test file in a
 * worker shares one process AND one cloned database. Two tests here mutate
 * shared state, so both restore it:
 *
 *   - M2 swaps `app.require_user_id()` by RENAME, not by `create or replace`.
 *     The tenancy policies bind the function by OID, so renaming the original
 *     leaves `decision` / `decision_revision` enforcement pointing at the REAL
 *     function throughout — only `withUser`'s preamble, which resolves the name
 *     at parse time, sees the impostor. Restoring is a drop plus a rename back,
 *     with no function body text round-tripped and no policy ever dropped.
 *   - M3 repoints `APP_DATABASE_URL` and closes the module-private pools.
 *     `afterEach` puts the worker's URL back, clears the cached privilege
 *     verdict and closes the pools again, so the next file in this worker builds
 *     a fresh pool against its own database.
 *
 * Both use `releaseProductionPools()` from the harness rather than reaching into
 * `src/server/db/pool.ts`. That module is module-private — the eslint boundary
 * names it and `npm run boundaries` resolves it through the TypeScript module
 * resolver — and `releaseProductionPools()` already is exactly
 * `resetPrivilegeAssertionCacheForTests()` followed by `closePools()`. Dropping
 * the cached verdict matters as much as closing the pools: it is keyed to
 * nothing, so it would otherwise survive as "role already verified" taken
 * against a connection that no longer exists.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  appDatabaseUrl,
  ensureWorkerDatabase,
  harnessEnv,
  migratorDatabaseUrl,
  ownerQuery,
  releaseProductionPools,
  runAsUser,
  workerDatabaseName,
} from './support/db'
import { enterIdentityContext } from '../../src/server/session/resolve'
import {
  ContextMismatchError,
  PrivilegeAssertionError,
  RowCountError,
  StatesmanError,
  withUser,
} from '../../src/server/db'
import type { UserScopedClient } from '../../src/server/db'
import { backendPid, seedUser } from './support/race'

// ---------------------------------------------------------------------------
// Identities and fixed ids
// ---------------------------------------------------------------------------
// 8-4-4-4-12 hex with a `0` version nibble: what the `uuid` column and
// `z.guid()` accept, and what `z.uuid()` would reject. Distinct from the
// sentinel (…dead), from tenancy.test.ts's A/B and from the dev seeds, so a
// cross-contaminated database shows up as a wrong count rather than as an
// accidental pass.

const USER_A = 'aaaaaaaa-0000-0000-0000-0000000b9a01'
const USER_B = 'bbbbbbbb-0000-0000-0000-0000000b9b01'

/** A's two drafts. BOTH are needed: the `>1 affected` leg updates them together. */
const A_DRAFT_1 = 'dddddddd-0000-0000-0000-0000000b9d01'
const A_DRAFT_2 = 'dddddddd-0000-0000-0000-0000000b9d02'
/** B's own draft, so B's failing cross-user update is not its only write. */
const B_DRAFT_1 = 'dddddddd-0000-0000-0000-0000000b9d0b'

/** Exactly how many drafts A owns once `beforeAll` has run. Asserted, not assumed. */
const A_DRAFT_COUNT = 2

/**
 * The identity the impostor `app.require_user_id()` returns.
 *
 * It MUST be a valid 8-4-4-4-12 hex uuid. `beginScopedTransaction` parses the
 * probe's result with `z.guid()` before comparing it, so a malformed value would
 * produce the "unexpected shape" `ContextMismatchError` instead of the
 * "does not agree with the identity just set" one — a different branch, and the
 * weaker of the two claims.
 */
const IMPOSTOR_USER_ID = '00000000-0000-0000-0000-0000000f00d5'

/** The name the real function is parked under while the impostor is installed. */
const SHADOWED_NAME = 'require_user_id_shadowed'

// ---------------------------------------------------------------------------
// Literal SQL.
//
// Every statement the DATA PATH runs is a literal with `$n` parameters — no
// value reaches SQL text (canon §6.1 rule 4). The fixture DDL further down
// (`installImpostorRequireUserId`, the probe readers) does splice module
// constants into its text, because an identifier cannot be parameterised and a
// psql variable is not substituted inside a dollar- or single-quoted function
// body. Those constants are compile-time literals in this file and never derive
// from a row, an argument or the environment.
// ---------------------------------------------------------------------------

const INSERT_DECISION =
  'insert into public.decision (id, user_id, draft_payload) values ($1::uuid, $2::uuid, $3::jsonb)'
const UPDATE_ONE_DRAFT = 'update public.decision set draft_payload = $1::jsonb where id = $2::uuid'
const UPDATE_ALL_MY_DRAFTS =
  'update public.decision set draft_payload = $1::jsonb where user_id = app.require_user_id()'
const COUNT_MY_DECISIONS = 'select count(*)::int as n from public.decision'
const READ_PAYLOAD = 'select draft_payload::text as payload from public.decision where id = $1::uuid'

/** The leak probes of the DISCARD ALL control. A session GUC and a named prepared statement. */
const LEAK_GUC = 'statesman.leak_probe'
const LEAK_PREPARED = 'statesman_leak_probe'
const PLANT_GUC = `select set_config('${LEAK_GUC}', 'planted', false) as applied`
const PLANT_PREPARED = `prepare ${LEAK_PREPARED} as select 1 as one`

const PLANTED_VALUE = 'planted'

/**
 * How a GUC that was NEVER set in this session reads.
 *
 * `current_setting(..., true)` returns NULL for a name the session has never
 * seen, so it is coalesced to a marker that the planting statement cannot
 * produce. NULL and '' are otherwise easy to confuse, and the difference turns
 * out to matter — see CLEARED_VALUE.
 */
const NEVER_SET_MARKER = '(never set)'

/**
 * How the GUC reads AFTER `DISCARD ALL`. MEASURED on this cluster, and not what
 * the obvious guess would be: the empty string, NOT NULL.
 *
 * `DISCARD ALL` performs `RESET ALL`, and resetting a customized option returns
 * it to its reset value rather than deleting the session's entry for it. A
 * placeholder GUC that was never present in `postgresql.conf` has '' as that
 * reset value, so the name survives the discard carrying no value.
 *
 * This is worth recording rather than smoothing over, because it is exactly the
 * case migration 0001 wrote `app.require_user_id()` for: after a discard,
 * `app.current_user_id` is '' and not NULL, and an accessor that tested only
 * `is null` would hand the policy `''::uuid`. The real accessor tests
 * `v is null or v = ''`, which is why `absent` below is asserted alongside the
 * raw value — that boolean is the same predicate, and it is the claim that does
 * not depend on which of the two renderings a given server produces.
 */
const CLEARED_VALUE = ''

/**
 * Both probes in one row, plus the absence predicate the real accessor uses.
 *
 * `absent` is `nullif(current_setting(...), '') is null` — byte-for-byte the
 * condition `app.require_user_id()` applies to `app.current_user_id`. Asserting
 * it makes the control independent of whether the discard leaves NULL or ''.
 */
const READ_LEAK_PROBES =
  `select coalesce(current_setting('${LEAK_GUC}', true), '${NEVER_SET_MARKER}') as guc, ` +
  `(nullif(current_setting('${LEAK_GUC}', true), '') is null) as absent, ` +
  `(select count(*)::int from pg_prepared_statements where name = '${LEAK_PREPARED}') as prepared`

interface LeakProbes {
  readonly guc: string
  readonly absent: boolean
  readonly prepared: number
}

async function readLeakProbes(db: UserScopedClient): Promise<LeakProbes> {
  const row = await db.queryOne<{ guc: string; absent: boolean; prepared: number }>(READ_LEAK_PROBES)
  return { guc: row.guc, absent: row.absent, prepared: Number(row.prepared) }
}

// ---------------------------------------------------------------------------
// Helpers — each one FAILS when the thing it measures did not happen
// ---------------------------------------------------------------------------

/**
 * The typed error a data-path call rejected with.
 *
 * THROWS when the call RESOLVED. This is what makes every denial below red
 * rather than silent when its guard is removed: "it did not reject" is a
 * failure, not an absence of evidence.
 */
async function rejectionOf(run: () => Promise<unknown>): Promise<StatesmanError> {
  let raised: unknown
  try {
    await run()
  } catch (error: unknown) {
    raised = error
  }
  if (raised === undefined) {
    throw new Error('expected the call to reject, but it resolved')
  }
  if (!(raised instanceof StatesmanError)) {
    // Not `throw raised`: the value is `unknown`, and rethrowing it loses the
    // fact that the data boundary was supposed to produce a typed error. The
    // original is carried as `cause`, so nothing is swallowed.
    throw new Error('expected a StatesmanError from the data boundary', { cause: raised })
  }
  return raised
}

/**
 * Drive the REAL `withUser` against an arbitrary connection URL.
 *
 * `runAsUser` cannot be used for the privilege tests: it calls
 * `pointProductionPoolsAtWorkerDatabase()`, which overwrites `APP_DATABASE_URL`
 * with the worker's own app-role URL and would undo the whole point. So this
 * sets the URL itself, clears the cached verdict and the pools so the next
 * acquire reads the new value, and then enters the same ambient identity
 * context the authentication middleware opens.
 *
 * Returns whether the caller's callback RAN. A guard that rejects after the
 * callback has already touched user data has not protected anything.
 */
async function withUserAgainst(
  url: string,
  options: { readonly freshVerdict: boolean } = { freshVerdict: true },
): Promise<{ readonly ran: boolean; readonly error: unknown }> {
  process.env['APP_DATABASE_URL'] = url
  if (options.freshVerdict) {
    await releaseProductionPools()
  }
  let ran = false
  let error: unknown
  try {
    await enterIdentityContext(USER_A, () =>
      withUser(async (db) => {
        ran = true
        await db.queryOne('select 1 as reached')
      }),
    )
  } catch (caught: unknown) {
    error = caught
  }
  return { ran, error }
}

/** A connection string for `role` against this worker's database. */
function urlForRole(role: string): string {
  return `postgres://${encodeURIComponent(role)}@127.0.0.1:5432/${workerDatabaseName()}`
}

// ---------------------------------------------------------------------------
// The M2 instrument: swap app.require_user_id() by RENAME
// ---------------------------------------------------------------------------

/**
 * Park the real `app.require_user_id()` under another name and install an
 * impostor that returns a FIXED, DIFFERENT uuid.
 *
 * Rename rather than `create or replace` for two reasons. First, the tenancy
 * policies on `decision` and `decision_revision` bind the function by OID, so a
 * rename carries them — and their EXECUTE grant — to the parked function, which
 * means RLS keeps working correctly throughout and no policy is ever dropped.
 * Second, restoring needs no copy of the original body: the original object is
 * still there, under a different name.
 *
 * The impostor is `stable` and takes no arguments, matching the real function's
 * volatility so the planner treats the call the same way.
 */
async function installImpostorRequireUserId(): Promise<void> {
  await ownerQuery(
    `alter function app.require_user_id() rename to ${SHADOWED_NAME};
     create function app.require_user_id() returns uuid
       language sql stable set search_path = pg_catalog
       as 'select ''${IMPOSTOR_USER_ID}''::uuid';
     revoke execute on function app.require_user_id() from public;
     grant execute on function app.require_user_id() to statesman_app;`,
  )
}

async function restoreRealRequireUserId(): Promise<void> {
  // Retried once, then VERIFIED.
  //
  // Observed once across the mutation runs for this file: the swap took 345ms
  // instead of the usual ~75ms and every later test in the file failed, which is
  // the signature of a restore that did not land. `ownerQuery` spawns a psql
  // subprocess, so it can fail or stall transiently under load, and a restore
  // that throws from inside a `finally` leaves the impostor installed — every
  // subsequent test then runs against a forged identity function and fails for a
  // reason that has nothing to do with what it is testing.
  //
  // The two statements are idempotent as a pair, so a retry is safe: after a
  // partial first attempt the `drop ... if exists` is a no-op and only the
  // rename is redone.
  let lastError: unknown
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await ownerQuery(
        `drop function if exists app.require_user_id();
         alter function app.${SHADOWED_NAME}() rename to require_user_id;`,
      )
      lastError = undefined
      break
    } catch (error: unknown) {
      lastError = error
    }
  }
  // Asserted from the catalog rather than inferred from "the statement did not
  // throw", because this is the one failure that must never be silent.
  if (await impostorIsInstalled()) {
    throw new Error(
      `app.${SHADOWED_NAME}() still exists, so the impostor app.require_user_id() is ` +
        'STILL INSTALLED. Every later test in this worker would run against a forged ' +
        `identity function. Last restore error: ${String(lastError)}`,
      { cause: lastError },
    )
  }
}

/** True when the parked name exists, i.e. a swap is still in place. */
async function impostorIsInstalled(): Promise<boolean> {
  const rows = await ownerQuery(
    `select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname = '${SHADOWED_NAME}';`,
  )
  return rows[0]?.[0] === '1'
}

/** What `app.require_user_id()` currently returns, read as the owner. */
async function requireUserIdReturnsForOwner(): Promise<string> {
  const rows = await ownerQuery(
    `begin;
     select set_config('app.current_user_id', '${IMPOSTOR_USER_ID}', true);
     select 'v', app.require_user_id()::text;
     rollback;`,
  )
  const value = rows.find((r) => r[0] === 'v')?.[1]
  if (value === undefined) {
    throw new Error('could not read app.require_user_id() back as the owner')
  }
  return value
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Clones this worker's database AND runs the role guard inside one cached
  // promise, so there is no path to the database that skips it (canon §8.3).
  await ensureWorkerDatabase()

  // `app_user` has no grants to statesman_app at all (§4.6) and the migrator is
  // `noinherit`, so the owner seeds it. Through the same path migration 0006
  // uses for its sentinel.
  await seedUser(USER_A)
  await seedUser(USER_B)

  // Every decision row goes in through the real `withUser`, under the real
  // INSERT policy (canon §8.3), so a missing WITH CHECK surfaces here rather
  // than being bypassed by a privileged fixture. `queryAffectingOne` is what
  // turns a WITH CHECK failure's silent zero-row outcome into an error (V7) —
  // and is itself one of the guards under test, which is why the row counts it
  // claims are re-measured below.
  await runAsUser(USER_A, async (db) => {
    await db.queryAffectingOne(INSERT_DECISION, [A_DRAFT_1, db.userId, JSON.stringify({ n: 1 })])
    await db.queryAffectingOne(INSERT_DECISION, [A_DRAFT_2, db.userId, JSON.stringify({ n: 2 })])
  })
  await runAsUser(USER_B, async (db) => {
    await db.queryAffectingOne(INSERT_DECISION, [B_DRAFT_1, db.userId, JSON.stringify({ n: 'b' })])
  })
}, 120_000)

/**
 * Remove this file's own rows, and PROVE they are gone.
 *
 * Not housekeeping. `isolate: false` gives every file in a worker the same
 * cloned database, and `state-machine.test.ts` asserts that the TOTAL
 * `public.decision` row count is 1 — the sentinel and nothing else. That
 * assertion is a real invariant of the template, so the three decision rows
 * seeded here have to be gone before the next file in this worker starts. Vitest
 * runs files in a worker sequentially, so this `afterAll` is the right seam.
 *
 * Shape notes:
 *   - the owner is subject to the tenancy policy under FORCE (V8), so the delete
 *     is bracketed the way migration 0006 brackets its seed, and the re-FORCE is
 *     asserted from the catalog afterwards — leaving FORCE off would make every
 *     later assertion in this worker vacuous.
 *   - `decision` is deleted before `app_user`, because `decision.user_id` is
 *     `on delete restrict`.
 *   - `decision_revision` is `on delete cascade` from `decision` AND carries
 *     append-only triggers that fire for the owner too (V32). This file creates
 *     no revisions, so the cascade touches zero rows and the FOR EACH ROW
 *     trigger never fires. If that ever stops being true this cleanup raises
 *     ST001 and fails loudly, which is the correct outcome.
 */
async function removeFixtureRows(): Promise<void> {
  const rows = await ownerQuery(
    `alter table public.decision no force row level security;
     delete from public.decision where user_id in (:'a'::uuid, :'b'::uuid);
     select 'left',
            (select count(*)::text from public.decision
              where user_id in (:'a'::uuid, :'b'::uuid)),
            (select count(*)::text from public.decision);
     alter table public.decision force row level security;
     delete from public.app_user where id in (:'a'::uuid, :'b'::uuid);
     select 'forced', c.relrowsecurity::text, c.relforcerowsecurity::text
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'decision';`,
    { a: USER_A, b: USER_B },
  )

  const left = rows.find((r) => r[0] === 'left')
  const forced = rows.find((r) => r[0] === 'forced')
  if (left === undefined || forced === undefined) {
    throw new Error(`fixture cleanup returned no labelled rows: ${JSON.stringify(rows)}`)
  }
  if (left[1] !== '0') {
    throw new Error(`fixture cleanup left ${String(left[1])} of this file's decision rows behind`)
  }
  // The TOTAL count is reported, NOT asserted — deliberately.
  //
  // `state-machine.test.ts` requires `public.decision` to hold only the sentinel,
  // so it is tempting to assert that here. But this file does not own the total:
  // other files in this worker seed decision rows too, and whether they have run
  // yet depends on a file-to-worker assignment that changes with the number of
  // test files. Asserting the total would fail THIS file for another file's
  // leftovers — the same misattribution the tripwire above exists to prevent, and
  // the reason the guards in this suite went unnoticed for so long.
  //
  // So the hard assertion above covers exactly what this file is responsible
  // for — its own rows — and the total is surfaced as a diagnostic that names
  // the condition and whose fault it is not.
  if (left[2] !== '1') {
    const strays = Number(left[2]) - 1
    console.warn(
      `[boundary-guards] this file's own rows are gone, but public.decision still holds ` +
        `${String(left[2])} rows: the sentinel plus ${String(strays)} row(s) left by ` +
        'ANOTHER test file in this worker. Not this file. A total-row assertion elsewhere ' +
        '(state-machine.test.ts) will fail or pass depending on file order, which is a ' +
        'real defect in whichever file seeded them without cleaning up.',
    )
  }
  if (forced[1] !== 'true' || forced[2] !== 'true') {
    throw new Error(
      `the FORCE bracket did not close: relrowsecurity=${String(forced[1])} ` +
        `relforcerowsecurity=${String(forced[2])} — this worker would carry on with ` +
        'tenancy enforcement switched off',
    )
  }
}

afterAll(async () => {
  // Safety net. If a test threw between the swap and its restore, the next file
  // in this worker would otherwise run against an impostor identity function.
  if (await impostorIsInstalled()) await restoreRealRequireUserId()
  await removeFixtureRows()
  process.env['APP_DATABASE_URL'] = appDatabaseUrl()
  await releaseProductionPools()
})

/**
 * Refuse to run ANY test while the identity function is swapped.
 *
 * This turns the one failure mode that cascades into a single, attributable
 * message. Without it, an unrestored swap shows up as seven or eight unrelated
 * assertion failures in M3, M4 and M7 — each of which looks like a broken guard
 * and is really a broken fixture. Misattributing a fixture fault to the thing
 * under test is exactly what this file exists to prevent, so the check is made
 * on the way IN to every test rather than only on the way out of the one that
 * does the swapping.
 */
beforeEach(async () => {
  if (await impostorIsInstalled()) {
    throw new Error(
      `app.${SHADOWED_NAME}() exists, so a previous test left the impostor ` +
        'app.require_user_id() installed. Refusing to run: every assertion in this file ' +
        'would be measuring a forged identity function, not the guard it names.',
    )
  }
})

// ===========================================================================
// M2 — the eager `select app.require_user_id()` in withUser
// ===========================================================================
describe('boundary guard M2: withUser verifies the identity it just set', () => {
  it('positive control: with the real app.require_user_id(), withUser resolves and the callback runs', async () => {
    let ran = false
    const seen = await runAsUser(USER_A, (db) => {
      ran = true
      return Promise.resolve(db.userId)
    })
    expect(ran).toBe(true)
    expect(seen).toBe(USER_A)
  })

  it('rejects with ContextMismatchError when app.require_user_id() disagrees, and the callback never runs', async () => {
    // The preamble resolves `app.require_user_id()` by NAME at parse time, so
    // the pools are closed around the swap: a reused backend cannot be carrying
    // a cached plan for the previous object.
    await releaseProductionPools()
    await installImpostorRequireUserId()

    let ran = false
    let error: StatesmanError | undefined
    let impostorValue = ''
    try {
      // INSTRUMENT VALIDATION, first: if the swap did not take, the rejection
      // below would have to come from somewhere else, and this test would be
      // asserting a coincidence.
      impostorValue = await requireUserIdReturnsForOwner()

      error = await rejectionOf(() =>
        runAsUser(USER_A, () => {
          ran = true
          return Promise.resolve()
        }),
      )
    } finally {
      await releaseProductionPools()
      await restoreRealRequireUserId()
    }

    // The swap really was in place, and it really did return the other identity
    // even with the correct one set in `app.current_user_id`.
    expect(impostorValue).toBe(IMPOSTOR_USER_ID)
    expect(impostorValue).not.toBe(USER_A)

    // The observable effect of the eager probe: the transaction is abandoned
    // BEFORE the caller's work, so no statement ever ran under an identity the
    // boundary could not confirm.
    expect(error).toBeInstanceOf(ContextMismatchError)
    expect(error?.kind).toBe('context_mismatch')
    expect(error?.message).toContain('does not agree with the identity just set')
    expect(ran).toBe(false)

    // And the restore landed: the same call that failed a moment ago succeeds
    // again, which is what keeps this test from poisoning the rest of the worker.
    await expect(runAsUser(USER_A, (db) => Promise.resolve(db.userId))).resolves.toBe(USER_A)
  })
})

// ===========================================================================
// M3 — assertUnprivilegedOnce()
// ===========================================================================
describe('boundary guard M3: withUser refuses a privileged connection', () => {
  afterEach(async () => {
    // Every test in here repoints APP_DATABASE_URL and closes the pools. Put the
    // worker's own URL back and drop the cached verdict, which is keyed to
    // nothing and would otherwise survive as "role already verified" against a
    // connection that is gone.
    process.env['APP_DATABASE_URL'] = appDatabaseUrl()
    await releaseProductionPools()
  })

  it('positive control: the statesman_app connection is ACCEPTED and the callback runs', async () => {
    const { ran, error } = await withUserAgainst(appDatabaseUrl())
    expect(error).toBeUndefined()
    expect(ran).toBe(true)
  })

  it('refuses statesman_migrator, which a rolsuper/rolbypassrls-only predicate would pass', async () => {
    const { ran, error } = await withUserAgainst(migratorDatabaseUrl())

    expect(error).toBeInstanceOf(PrivilegeAssertionError)
    expect(ran).toBe(false)
    const message = (error as PrivilegeAssertionError).message

    // The role it refused, read back from the connection rather than assumed:
    // pg_hba is `trust` locally, so this URL connected with no password error
    // (V1) — which is the failure mode the guard exists for.
    expect(message).toContain('statesman_migrator')
    expect(message).toContain(workerDatabaseName())

    // THE POINT OF THIS TEST. statesman_migrator is neither a SUPERUSER nor
    // BYPASSRLS; it is privileged because it is a MEMBER of statesman_owner,
    // which OWNS all six public relations, and ownership bypasses RLS (V4).
    // So the violation reported must be the SET ROLE reachability one, and the
    // two attribute clauses must be silent — otherwise the catch came from a
    // predicate that would have missed this role.
    expect(message).toContain('SET ROLE')
    expect(message).toContain('statesman_owner')
    expect(message).not.toContain('is a SUPERUSER')
    expect(message).not.toContain('has BYPASSRLS')
  })

  it('refuses the cluster superuser, naming the SUPERUSER attribute', async () => {
    const superuser = harnessEnv().TEST_ADMIN_ROLE
    const { ran, error } = await withUserAgainst(urlForRole(superuser))

    expect(error).toBeInstanceOf(PrivilegeAssertionError)
    expect(ran).toBe(false)
    const message = (error as PrivilegeAssertionError).message
    expect(message).toContain(superuser)
    expect(message).toContain('is a SUPERUSER')
  })

  it('does not cache a rejection: an immediate retry fails again, and a good connection afterwards still passes', async () => {
    // `assertUnprivilegedOnce` deliberately clears its cached promise on
    // rejection, so a dropped connection at start-up cannot brick the process.
    // The cost of that design is that the retry has to be shown to still fail —
    // clearing the cache must not turn a refusal into a pass.
    const first = await withUserAgainst(migratorDatabaseUrl())
    expect(first.error).toBeInstanceOf(PrivilegeAssertionError)
    expect(first.ran).toBe(false)

    // Same process, same URL, NO cache reset in between: this is the retry.
    const retry = await withUserAgainst(migratorDatabaseUrl(), { freshVerdict: false })
    expect(retry.error).toBeInstanceOf(PrivilegeAssertionError)
    expect(retry.ran).toBe(false)

    // And the cleared cache is not stuck on "failed" either: the app role still
    // passes, so the two outcomes are being measured per connection.
    const good = await withUserAgainst(appDatabaseUrl())
    expect(good.error).toBeUndefined()
    expect(good.ran).toBe(true)
  })
})

// ===========================================================================
// M4 — DISCARD ALL. Canon §7.6: pooled-identity leak is a RELEASE BLOCKER.
// ===========================================================================
describe('boundary guard M4: DISCARD ALL clears session state before the connection is reused', () => {
  it('a session GUC and a prepared statement planted in call 1 are GONE in call 2 on the SAME backend, though a plain COMMIT leaves them', async () => {
    // A fresh pool, so the two sequential acquires below can only be served by
    // one client. Nothing here sets pool size — `max` is 10 — so the identical
    // backend pid is ASSERTED rather than configured, and the test fails if the
    // calls happen to land on different backends. That assertion is the whole
    // basis of the test: two different backends would not share state no matter
    // what DISCARD ALL did.
    await releaseProductionPools()

    let survivedCommit: LeakProbes | undefined
    let plantedImmediately: LeakProbes | undefined

    const pidOne = await runAsUser(USER_A, async (db) => {
      const pid = await backendPid(db)

      // `is_local = false` is the mistake DISCARD ALL exists to make inert: a
      // SESSION-level GUC outlives the transaction. The prepared statement is
      // the second kind of leftover — not a GUC, so it tests a different clause
      // of the same statement.
      await db.query(PLANT_GUC)
      await db.query(PLANT_PREPARED)

      // Control A — the plant actually took. Without this, "gone in call 2" is
      // equally well explained by nothing ever having been planted.
      plantedImmediately = await readLeakProbes(db)

      // Control B — a plain COMMIT does NOT clear them. Issued through the
      // scoped surface on purpose: this is the only path in the suite that can
      // observe the session AFTER a commit and BEFORE withUser's `DISCARD ALL`,
      // and it is what distinguishes "the discard worked" from "a commit would
      // have been enough". No production code may do this.
      await db.query('commit')
      survivedCommit = await readLeakProbes(db)

      return pid
    })
    // withUser's `finally` has now run COMMIT (a no-op warning) and DISCARD ALL.

    const leaked = await runAsUser(USER_A, async (db) => ({
      pid: await backendPid(db),
      probes: await readLeakProbes(db),
    }))

    // 1. Same backend. Asserted FIRST, because everything after it is only
    //    meaningful on a reused connection.
    expect(leaked.pid).toBe(pidOne)

    // 2. The plant worked. Without this, "gone in call 2" is equally well
    //    explained by nothing ever having been planted.
    expect(plantedImmediately).toEqual({ guc: PLANTED_VALUE, absent: false, prepared: 1 })

    // 3. A plain COMMIT left both in place — so the clearing seen below is
    //    attributable to DISCARD ALL and not to the transaction ending.
    expect(survivedCommit).toEqual({ guc: PLANTED_VALUE, absent: false, prepared: 1 })

    // 4. The guard's observable effect: the next caller on this very backend
    //    inherits neither the GUC nor the prepared statement. `absent` is the
    //    load-bearing half — it is the same `is null or = ''` test the real
    //    `app.require_user_id()` applies, so it holds whichever of NULL or ''
    //    the discard leaves behind.
    expect(leaked.probes.absent).toBe(true)
    expect(leaked.probes.guc).not.toBe(PLANTED_VALUE)
    expect(leaked.probes).toEqual({ guc: CLEARED_VALUE, absent: true, prepared: 0 })
  })
})

// ===========================================================================
// M7 — queryAffectingOne's rowCount assertion
// ===========================================================================
describe('boundary guard M7: queryAffectingOne asserts exactly one affected row', () => {
  it('positive control: a one-row update RESOLVES, and the write lands', async () => {
    const payload = JSON.stringify({ n: 1, control: 'one-row' })
    await runAsUser(USER_A, async (db) => {
      await db.queryAffectingOne(UPDATE_ONE_DRAFT, [payload, A_DRAFT_1])
    })
    const stored = await runAsUser(USER_A, async (db) => {
      const row = await db.queryOne<{ payload: string }>(READ_PAYLOAD, [A_DRAFT_1])
      return row.payload
    })
    expect(stored).toContain('one-row')
  })

  it('raises RowCountError when the update affects ZERO rows — a cross-user write, which RLS silences (V7)', async () => {
    const payload = JSON.stringify({ forged: true })

    // First the measurement the error has to be distinguishable from: through
    // plain `query()` the same statement SUCCEEDS, raises nothing, and reports
    // rowCount 0. That silence is V7, and it is exactly what reads as success at
    // a call site that does not assert the count.
    const silent = await runAsUser(USER_B, async (db) =>
      (await db.query(UPDATE_ONE_DRAFT, [payload, A_DRAFT_1])).rowCount,
    )
    expect(silent).toBe(0)

    // Same role, same statement, same parameters, through the asserting helper.
    const error = await rejectionOf(() =>
      runAsUser(USER_B, async (db) => {
        await db.queryAffectingOne(UPDATE_ONE_DRAFT, [payload, A_DRAFT_1])
      }),
    )
    expect(error).toBeInstanceOf(RowCountError)
    expect(error.kind).toBe('row_count')
    expect(error.message).toContain('expected exactly 1 affected row, got 0')

    // And nothing was written: A's row is untouched by B's attempt.
    const stored = await runAsUser(USER_A, async (db) => {
      const row = await db.queryOne<{ payload: string }>(READ_PAYLOAD, [A_DRAFT_1])
      return row.payload
    })
    expect(stored).not.toContain('forged')
  })

  it('raises RowCountError when the update affects MORE than one row', async () => {
    // A owns exactly two drafts, measured rather than assumed — a fixture that
    // had seeded one would make this leg a zero-vs-one test by accident.
    const owned = await runAsUser(USER_A, async (db) => {
      const row = await db.queryOne<{ n: number }>(COUNT_MY_DECISIONS)
      return Number(row.n)
    })
    expect(owned).toBe(A_DRAFT_COUNT)

    const payload = JSON.stringify({ sweep: true })

    // Plain `query()` again, for the other side of the branch: two rows is also
    // a silent success, so neither 0 nor 2 raises anything on its own.
    const affected = await runAsUser(USER_A, async (db) =>
      (await db.query(UPDATE_ALL_MY_DRAFTS, [payload])).rowCount,
    )
    expect(affected).toBe(A_DRAFT_COUNT)

    const error = await rejectionOf(() =>
      runAsUser(USER_A, async (db) => {
        await db.queryAffectingOne(UPDATE_ALL_MY_DRAFTS, [payload])
      }),
    )
    expect(error).toBeInstanceOf(RowCountError)
    expect(error.kind).toBe('row_count')
    expect(error.message).toContain(`expected exactly 1 affected row, got ${String(A_DRAFT_COUNT)}`)
  })
})
