/**
 * Boundary guards — controls for four guards of the TEST HARNESS, not of the product.
 *
 * ===========================================================================
 * READ THIS BEFORE READING ANY TEST BELOW: WHAT THESE FOUR GUARDS NOW PROTECT
 * ===========================================================================
 * Under ADR-0015 the application is a static export talking to Supabase from the
 * browser. There is no Node request path and no server-side connection pool, so
 * ADR-0015 §6/§6.1 retires `withUser`, `assertUnprivilegedOnce()`, the eager
 * identity probe and `DISCARD ALL` **from everything that ships**. The code that
 * holds them moved from `src/server/db/**` to `tests/support/scoped-pg/**` and
 * its own module headers say "TEST-ONLY (ADR-0015) … it has no production role".
 *
 * So the four guards below protect exactly one thing: **this integration
 * harness's own `pg` access.** That is a smaller claim than this file used to
 * make, and it is stated here, in each `describe` title, and in each test's own
 * comment, so nobody can read a green run as evidence about the product.
 *
 * It is still a claim worth gating, and that is why all four controls were KEPT
 * (option (a) of the port's decision) rather than deleted:
 *
 *   `runAsUser` → `withUser` is the seam tenancy.test.ts, forgery.test.ts,
 *   lifecycle.test.ts, concurrency.test.ts and scenario-content.test.ts take
 *   every data assertion through. Post-port a harness that lost its identity,
 *   its role check, its session hygiene or its row-count assertion does not go
 *   red — it goes GREEN while addressing nobody, because `auth.uid()` returns
 *   NULL where `app.require_user_id()` raised `28000`, and a NULL identity reads
 *   0 rows from every protected table while raising nothing (ADR-0015's first
 *   measured loss). These four guards are what stop that from happening
 *   silently, so without them the suite's other 70-odd assertions are
 *   unfalsifiable.
 *
 * WHAT WAS LOST ANYWAY, recorded rather than quietly re-labelled: the
 * production-side versions of all four are gone with the server, and with them
 * the second and third of the journal's three layers (ADR-0015 "RLS becomes the
 * only wall"). The properties that *survive* in shipped form survive as posture
 * rules 11/12 and the harness role guard, not as anything in this file.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * A prior adversarial pass built a mirrored checkout, removed ONE guard at a
 * time, and re-ran the integration suite. Four removals left the suite green at
 * 44/44, which means the suite could not see the guard at all:
 *
 *   M2  the eager identity probe in `beginScopedTransaction` replaced with a
 *       fabricated local row. Post-port the probe reads `auth.uid()`, so the
 *       instrument below swaps `auth.uid()` and not `app.require_user_id()`.
 *   M3  `await assertUnprivilegedOnce()` deleted from `withUser`.
 *   M4  the `DISCARD ALL` block deleted from `finishScopedTransaction`
 *       (canon §7.6 names pooled-identity leak a RELEASE BLOCKER).
 *   M7  `queryAffectingOne`'s `rowCount !== 1` assertion replaced with
 *       `if (false)`.
 *
 * All four were separately measured as WORKING. They were not broken; they were
 * unobserved. This file observes them — in their current, harness-only home.
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
 *   - M2 swaps `auth.uid()` by RENAME, not by `create or replace`.
 *     The tenancy policies bind the function by OID, so renaming the original
 *     leaves `decision` / `decision_revision` enforcement pointing at the REAL
 *     function throughout — only the harness's transaction preamble, which
 *     resolves the name at parse time, sees the impostor. MEASURED on this
 *     emulation: during the swap `pg_get_expr(polqual)` for `decision_tenancy`
 *     reads `(user_id = auth.uid_shadowed())`, and after the restore it reads
 *     `(user_id = auth.uid())` again. Restoring is a drop plus a rename back,
 *     with no function body text round-tripped and no policy ever dropped.
 *
 *     THE SWAP RUNS AS THE CLUSTER SUPERUSER, not as `postgres`. Port finding P9:
 *     schema `auth` is platform-owned (`supabase_auth_admin` live, the bootstrap
 *     role in the emulation), so `postgres` gets "permission denied for schema
 *     auth" — which is a property worth having, because it means no migration in
 *     `supabase/migrations/` can weaken the platform's identity accessor even by
 *     accident. Only an out-of-band instrument like this one can, which is why
 *     the restore is verified from the catalog rather than inferred.
 *   - M3 repoints `APP_DATABASE_URL` and closes the module-private pools.
 *     `afterEach` puts the worker's URL back, clears the cached privilege
 *     verdict and closes the pools again, so the next file in this worker builds
 *     a fresh pool against its own database.
 *
 * Both use `releaseProductionPools()` from the harness rather than reaching into
 * `tests/support/scoped-pg/pool.ts`. That module is module-private — the eslint boundary
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
  queryRows,
  releaseProductionPools,
  runAsUser,
  workerDatabaseName,
} from './support/db'
import { enterIdentityContext } from '../support/scoped-pg/session'
import {
  ContextMismatchError,
  PrivilegeAssertionError,
  RowCountError,
  StatesmanError,
  withUser,
} from '../support/scoped-pg'
import type { UserScopedClient } from '../support/scoped-pg'
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
 * The identity the impostor `auth.uid()` returns.
 *
 * It MUST be a valid 8-4-4-4-12 hex uuid. `beginScopedTransaction` parses the
 * probe's result with `z.guid()` — NOT `z.uuid()` (V33) — before comparing it, so
 * a malformed value would produce the "did not return a usable uuid"
 * `ContextMismatchError` instead of the "does not agree with the identity just
 * set" one. Those are different branches and the first is the weaker claim: it
 * fires for a NULL identity too, which is the condition that is easy to reach by
 * accident. This instrument must drive the SPECIFIC branch that catches an
 * identity which resolved successfully to the wrong user.
 */
const IMPOSTOR_USER_ID = '00000000-0000-0000-0000-0000000f00d5'

/** The name the real `auth.uid()` is parked under while the impostor is installed. */
const SHADOWED_NAME = 'uid_shadowed'

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
/**
 * `app.require_user_id()` and not `auth.uid()`, deliberately.
 *
 * 20261021140100 keeps the raising wrapper and grants EXECUTE on it to
 * `authenticated` (MEASURED: `grant execute on function app.require_user_id() to
 * authenticated`), and it is the one accessor that still fails loudly. If the
 * claim were missing this statement raises `28000` instead of matching
 * `user_id = NULL` and updating zero rows — and a zero-row update is precisely
 * what the M7 leg below is asserting about, so the two must not be confusable.
 * A policy predicate may not do this (ADR-0015: a raising policy would give the
 * local target a failure mode the live one lacks); a test statement may.
 */
const UPDATE_ALL_MY_DRAFTS =
  'update public.decision set draft_payload = $1::jsonb where user_id = app.require_user_id()'
// unscoped-count-ok: this count is taken THROUGH RLS as `authenticated` with a claim,
// so the policy `user_id = auth.uid()` is the scoping predicate and the result is
// per-user by construction rather than whole-table. The assertion it feeds
// (`owned === A_DRAFT_COUNT`) is about USER_A, whose ids are unique to this file, so a
// sibling file's rows in the shared worker clone cannot move it. The marker is explicit
// rather than relying on the detector's 200-character window happening to catch the
// `where id = $1` of the next constant.
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
 * This is worth recording rather than smoothing over, because the port did NOT
 * remove the hazard, it moved it: `auth.uid()` is
 * `coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
 * nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid`
 * (scripts/emulate-supabase.sh, Supabase's published definition). After a discard
 * the claim GUC reads '' and not NULL, so an accessor that tested only `is null`
 * would hand the policy `''::uuid`. The real accessor's `nullif(…, '')` is what
 * closes that, which is why `absent` below is asserted alongside the raw value —
 * that boolean is byte-for-byte the accessor's own predicate, and it is the claim
 * that does not depend on which of the two renderings a given server produces.
 */
const CLEARED_VALUE = ''

/**
 * Both probes in one row, plus the absence predicate the real accessor uses.
 *
 * `absent` is `nullif(current_setting(...), '') is null` — byte-for-byte the
 * condition `auth.uid()` applies to `request.jwt.claim.sub`. Asserting it makes
 * the control independent of whether the discard leaves NULL or ''.
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
// The M2 instrument: swap auth.uid() by RENAME
// ---------------------------------------------------------------------------

/**
 * Run DDL as the CLUSTER SUPERUSER against this worker's clone.
 *
 * `ownerQuery` connects as `postgres`, which cannot touch schema `auth` — it is
 * platform-owned (port finding P9), and that refusal is a property the project
 * wants to keep, because it means nothing in `supabase/migrations/` can weaken
 * the identity accessor. The swap therefore needs the one role that does own the
 * emulated `auth` schema. MEASURED on this cluster: `auth` and `auth.uid()` are
 * both owned by `TEST_ADMIN_ROLE`.
 *
 * This is the same concession the posture suite's `auth.uid()`-volatility probe
 * (port verification leg E4) already takes, and it is confined to DDL on the
 * instrument: no data read in this file goes through this connection.
 */
async function adminQuery(sql: string): Promise<string[][]> {
  await ensureWorkerDatabase()
  return queryRows(sql, { db: workerDatabaseName() })
}

/**
 * Park the real `auth.uid()` under another name and install an impostor that
 * returns a FIXED, DIFFERENT uuid.
 *
 * `auth.uid()` AND NOT `app.require_user_id()`, which is what this instrument
 * used to swap. The harness's transaction preamble now reads `auth.uid()`
 * directly (`IDENTITY_PROBE_SQL` in tests/support/scoped-pg/scoped.ts), because
 * that is the accessor the POLICIES consult; probing the raising wrapper would
 * measure the wrapper. So a rename of `app.require_user_id()` no longer reaches
 * the probe at all, and the pre-port version of this test failed with "expected
 * the call to reject, but it resolved" — a mutation that stopped biting because
 * its target moved, which is exactly the shape this file exists to catch.
 *
 * Rename rather than `create or replace` for two reasons. First, the tenancy
 * policies on `decision` and `decision_revision` bind the function by OID, so a
 * rename carries them — and their EXECUTE grant — to the parked function, which
 * means RLS keeps working correctly throughout and no policy is ever dropped.
 * Second, restoring needs no copy of the original body: the original object is
 * still there, under a different name.
 *
 * The impostor is `stable` and takes no arguments, matching the real function's
 * volatility (MEASURED: `pg_proc.provolatile = 's'`) so the planner treats the
 * call the same way — and so posture rule 6, which fails a `auth.uid()` made
 * IMMUTABLE, would not be the thing that caught this.
 *
 * The EXECUTE grants mirror scripts/emulate-supabase.sh exactly, including the
 * `revoke … from public` that V2/V30 require and the grant to `postgres` without
 * which a SECURITY DEFINER lifecycle body fails with "permission denied for
 * function uid" (port finding P7).
 */
async function installImpostorAuthUid(): Promise<void> {
  await adminQuery(
    `alter function auth.uid() rename to ${SHADOWED_NAME};
     create function auth.uid() returns uuid
       language sql stable set search_path = pg_catalog
       as 'select ''${IMPOSTOR_USER_ID}''::uuid';
     revoke execute on function auth.uid() from public;
     grant execute on function auth.uid() to postgres, anon, authenticated, service_role;`,
  )
}

async function restoreRealAuthUid(): Promise<void> {
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
      await adminQuery(
        `drop function if exists auth.uid();
         alter function auth.${SHADOWED_NAME}() rename to uid;`,
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
      `auth.${SHADOWED_NAME}() still exists, so the impostor auth.uid() is STILL ` +
        'INSTALLED. Every later test in this worker — and every tenancy, forgery and ' +
        'lifecycle assertion in every later FILE in this worker — would run against a ' +
        `forged identity accessor. Last restore error: ${String(lastError)}`,
      { cause: lastError },
    )
  }
}

/** True when the parked name exists, i.e. a swap is still in place. */
async function impostorIsInstalled(): Promise<boolean> {
  const rows = await ownerQuery(
    `select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'auth' and p.proname = '${SHADOWED_NAME}';`,
  )
  return rows[0]?.[0] === '1'
}

/**
 * What `auth.uid()` resolves to when USER_A's claim is set, read as the owner.
 *
 * TWO-SIDED BY CONSTRUCTION. With the real accessor installed this returns
 * USER_A, because that is the claim the script sets; with the impostor installed
 * it returns IMPOSTOR_USER_ID regardless of the claim. So a single reading
 * distinguishes "the swap took" from "the swap did not take", rather than merely
 * reporting a constant that would look the same either way.
 *
 * The claim is set with `set_config(…, true)` INSIDE an explicit transaction.
 * MEASURED repeatedly on this project: a `SET LOCAL` issued outside a transaction
 * block is scoped to that single statement and the next one reads the empty
 * string — which would make `auth.uid()` NULL, and a NULL here would be read as
 * "the swap did not take" when in fact the instrument was never armed.
 */
async function authUidWithClaimForOwner(claim: string): Promise<string> {
  const rows = await ownerQuery(
    `begin;
     select set_config('request.jwt.claim.sub', :'claim', true);
     select set_config('request.jwt.claims', '', true);
     select 'guc', coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), '');
     select 'v', coalesce(auth.uid()::text, '');
     rollback;`,
    { claim },
  )
  const guc = rows.find((r) => r[0] === 'guc')?.[1]
  if (guc !== claim) {
    throw new Error(
      `the claim GUC read back as '${String(guc)}' inside the probe transaction, expected ` +
        `'${claim}'. The SET LOCAL did not take effect, so this reading says nothing ` +
        'about whether the accessor was swapped.',
    )
  }
  const value = rows.find((r) => r[0] === 'v')?.[1]
  if (value === undefined || value === '') {
    throw new Error(
      'auth.uid() came back NULL with the claim demonstrably set, which is neither the ' +
        'real accessor nor the impostor — the instrument is in an unknown state',
    )
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

  // PORTED (ADR-0015): `public.app_user` is retired and `seedUser` now writes
  // `auth.users` then `public.profile`, in that order, because `profile.user_id`
  // carries a real FK to `auth.users(id)`. It still goes through the owner
  // connection rather than `withUser`, but for a DIFFERENT reason than before:
  // not grant-absence on `app_user`, but because `auth.users` belongs to the
  // platform and `authenticated` holds nothing on it at all (MEASURED:
  // `revoke all on table auth.users from public, anon, authenticated`).
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
 *   - the FORCE bracket is now BELT AND BRACES rather than load-bearing, and
 *     saying so is the honest version. Pre-port the fixture role merely OWNED the
 *     tables, so it was subject to its own policy under FORCE (V8) and the
 *     bracket was required for the DELETE to affect anything. Post-port
 *     `ownerQuery` connects as `postgres`, which is BYPASSRLS — MEASURED on the
 *     built template: as `postgres`, with FORCE on and no claim set,
 *     `select count(*) from public.decision` returns the sentinel row and raises
 *     nothing. The bracket is kept because the re-FORCE assertion below is cheap
 *     and because a fixture role that ever becomes a merely-owning role would
 *     silently no-op (V8) without it.
 *   - `decision` is deleted before `public.profile`, because `decision.user_id`
 *     is `on delete restrict` (canon §5.2: erasure is a deliberate path, never a
 *     cascade).
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
     -- Scoped only. The whole-table leg that used to sit here measured which sibling
     -- files had run first in this worker, not what this file left behind
     -- (vitest.integration.config.ts shares one clone per worker, V35). The source gate
     -- tests/unit/no-unscoped-counts.test.ts caught it, which is the gate working.
     select 'left',
            (select count(*)::text from public.decision
              where user_id in (:'a'::uuid, :'b'::uuid));
     alter table public.decision force row level security;
     -- PORTED (ADR-0015): public.app_user is retired. The identity now lives in
     -- public.profile with a REAL foreign key to auth.users(id) ON DELETE RESTRICT, so
     -- the order below is load-bearing in a way the single DELETE was not: revisions,
     -- then decisions, then the profile, then the auth row. RESTRICT means a profile
     -- still holding decisions refuses to go, which is canon 5.2 working as intended —
     -- erasure is a deliberate path, never a cascade.
     delete from public.profile where user_id in (:'a'::uuid, :'b'::uuid);
     -- The auth.users row is deliberately NOT deleted. scripts/emulate-supabase.sh grants
     -- the postgres role only SELECT, INSERT and REFERENCES on auth.users, withholding
     -- UPDATE and
     -- DELETE on purpose (port finding P8): GoTrue owns identities, and a harness that
     -- deleted one would be editing another system's table — on the live project it would
     -- be deleting a real account. MEASURED: the DELETE fails with 42501, which is the
     -- emulation refusing exactly as the deployed target would. The profile row is ours
     -- and is removed; the worker database is dropped at teardown anyway.
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
  // THE TOTAL COUNT IS NOT MEASURED AT ALL, and the block that used to report it
  // has been REMOVED rather than re-pointed.
  //
  // It was already dead, and worse than dead. The whole-table leg was deleted
  // from the SQL above when V35's source gate (tests/unit/no-unscoped-counts.test.ts)
  // caught it, so the 'left' row carries two columns; the reader that survived
  // tested `left[2] !== '1'` against `undefined`, which is ALWAYS true, and then
  // printed `Number(undefined) - 1` — so every single run emitted a warning
  // claiming "NaN stray rows left by another test file". A diagnostic that fires
  // unconditionally and reports NaN trains the reader to ignore the warning
  // channel, which is how a real stray would have gone unnoticed.
  //
  // Nothing replaces it: this file does not own the total. Other files in this
  // worker seed decision rows too, and whether they have run yet depends on a
  // file-to-worker assignment that changes with the number of test files, so any
  // claim about the total would fail THIS file for another file's leftovers.
  // The hard assertion above covers exactly what this file is responsible for.
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
  // in this worker would otherwise run against an impostor identity accessor.
  if (await impostorIsInstalled()) await restoreRealAuthUid()
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
      `auth.${SHADOWED_NAME}() exists, so a previous test left the impostor auth.uid() ` +
        'installed. Refusing to run: every assertion in this file would be measuring a ' +
        'forged identity accessor, not the guard it names.',
    )
  }
})

// ===========================================================================
// M2 — the eager identity probe in beginScopedTransaction
//
// GUARDS TEST INFRASTRUCTURE, NOT THE PRODUCT. The probe lives in
// tests/support/scoped-pg/scoped.ts, which ADR-0015 retired from the request
// path; nothing that ships calls it. Decision: KEPT (option (a)), re-pointed at
// the harness, because `runAsUser` is how every data assertion in this suite
// acquires an identity, and post-port a lost identity does not raise `28000` any
// more — `auth.uid()` returns NULL, every protected table returns 0 rows, and
// the whole suite goes green against nobody. This probe is the one place the
// project still permits the fail-loud property, so it is the one place that can
// be controlled.
// ===========================================================================
describe('harness guard M2 (test infrastructure): the scoped transaction verifies the identity it just set', () => {
  it('positive control: with the real auth.uid(), withUser resolves and the callback runs', async () => {
    let ran = false
    const seen = await runAsUser(USER_A, (db) => {
      ran = true
      return Promise.resolve(db.userId)
    })
    expect(ran).toBe(true)
    expect(seen).toBe(USER_A)
  })

  it('rejects with ContextMismatchError when auth.uid() disagrees with the claim just set, and the callback never runs', async () => {
    // The preamble resolves `auth.uid()` by NAME at parse time, so the pools are
    // closed around the swap: a reused backend cannot be carrying a cached plan
    // for the previous object.
    await releaseProductionPools()
    await installImpostorAuthUid()

    let ran = false
    let error: StatesmanError | undefined
    let impostorValue = ''
    try {
      // INSTRUMENT VALIDATION, first: if the swap did not take, the rejection
      // below would have to come from somewhere else, and this test would be
      // asserting a coincidence. The helper sets USER_A's claim, so the real
      // accessor would answer USER_A here and only the impostor can answer
      // IMPOSTOR_USER_ID — the reading tells the two states apart rather than
      // returning a constant.
      impostorValue = await authUidWithClaimForOwner(USER_A)

      error = await rejectionOf(() =>
        runAsUser(USER_A, () => {
          ran = true
          return Promise.resolve()
        }),
      )
    } finally {
      await releaseProductionPools()
      await restoreRealAuthUid()
    }

    // The swap really was in place, and it really did return the other identity
    // even with the correct one set in `request.jwt.claim.sub`.
    expect(impostorValue).toBe(IMPOSTOR_USER_ID)
    expect(impostorValue).not.toBe(USER_A)

    // The observable effect of the eager probe: the transaction is abandoned
    // BEFORE the caller's work, so no statement ever ran under an identity the
    // boundary could not confirm.
    expect(error).toBeInstanceOf(ContextMismatchError)
    expect(error?.kind).toBe('context_mismatch')
    // WHICH BRANCH, asserted. `beginScopedTransaction` has three rejection
    // branches and only one of them is this test's claim: "the probe did not
    // return a usable uuid" fires for a NULL identity, and "the claim GUC holds
    // X but Y was just set" fires when the SET LOCAL did nothing. Both would be
    // satisfied by a broken instrument. The message below is the branch that
    // only a successfully-resolved WRONG identity can reach.
    expect(error?.message).toContain('does not agree with the identity just set')
    expect(error?.message).toContain('auth.uid()')
    expect(ran).toBe(false)

    // And the restore landed: the same call that failed a moment ago succeeds
    // again, which is what keeps this test from poisoning the rest of the worker.
    await expect(runAsUser(USER_A, (db) => Promise.resolve(db.userId))).resolves.toBe(USER_A)
  })
})

// ===========================================================================
// M3 — assertUnprivilegedOnce()
//
// GUARDS TEST INFRASTRUCTURE, NOT THE PRODUCT. ADR-0015 §6.1 says in as many
// words that `assertUnprivilegedOnce()` "has nothing to act on" once there is no
// server pool, and the module that holds it is headed "TEST-ONLY … no production
// role". Decision: KEPT (option (a)), re-pointed, because the harness DOES have
// a pool and ADR-0015's "the trap this introduces" is about exactly this: a
// connection as `postgres` passes every tenancy, cross-user and forgery
// assertion while enforcing nothing. `assertTestConnectionIdentity()` guards the
// psql seam; this guards the `pg` seam. Two seams, two controls.
//
// THE PRODUCTION PROPERTY IS GONE and is NOT replaced by anything here. What
// survives in shipped form is posture rules 11 (BYPASSRLS) and 12 (broad
// grants), which ask which privileged roles may EXIST, plus the harness role
// guard (mutation M22). Those are different questions from "is THIS connection
// privileged", and the shipped answer to that question is now "there is no
// connection".
//
// REWORKED, NOT RENAMED. The pre-port version refused `statesman_migrator` and
// asserted the message named `statesman_migrator` and `statesman_owner`. Both
// roles are retired, so a substitution would have produced a test that passes
// while asserting nothing about the thing that is actually dangerous. The legs
// below target the PROPERTY instead — bypassrls, ownership, and membership via
// `pg_has_role(…, 'MEMBER')` (V3) — and the roles are chosen because they hold
// those properties on a Supabase-shaped target, not because of their names.
// ===========================================================================

/**
 * The emulation's analogue of the retired `statesman_migrator` → `statesman_owner`
 * escalation, and it is an analogue by PROPERTY rather than by position.
 *
 * MEASURED on this cluster with the same predicate the guard uses:
 *
 *   authenticator  rolsuper=f  rolbypassrls=f  owns 0  reachable: service_role [BYPASSRLS]
 *   postgres       rolsuper=f  rolbypassrls=t  owns 11 reachable: service_role [BYPASSRLS]
 *   authenticated  rolsuper=f  rolbypassrls=f  owns 0  reachable: (none)
 *
 * `authenticator` is the role PostgREST itself logs in as before switching to
 * `anon` or `authenticated`; scripts/emulate-supabase.sh creates it NOINHERIT
 * holding all three client roles, which is Supabase's own shape. It is therefore
 * the post-port role for which an attribute-only predicate reports "clean" while
 * `SET ROLE service_role` succeeds — V3 exactly, in the costume the platform
 * supplies.
 */
const MEMBERSHIP_PRIVILEGED_ROLE = 'authenticator'

/** The BYPASSRLS role it can reach. Asserted in the message, not assumed. */
const REACHED_BYPASSRLS_ROLE = 'service_role'

describe('harness guard M3 (test infrastructure): withUser refuses a privileged connection', () => {
  afterEach(async () => {
    // Every test in here repoints APP_DATABASE_URL and closes the pools. Put the
    // worker's own URL back and drop the cached verdict, which is keyed to
    // nothing and would otherwise survive as "role already verified" against a
    // connection that is gone.
    process.env['APP_DATABASE_URL'] = appDatabaseUrl()
    await releaseProductionPools()
  })

  it('positive control: the `authenticated` connection is ACCEPTED and the callback runs', async () => {
    const { ran, error } = await withUserAgainst(appDatabaseUrl())
    expect(error).toBeUndefined()
    expect(ran).toBe(true)
  })

  it("refuses `postgres` — rolsuper is FALSE, so a superuser-only predicate would admit the one role on the platform that ignores every policy", async () => {
    const { ran, error } = await withUserAgainst(migratorDatabaseUrl())

    expect(error).toBeInstanceOf(PrivilegeAssertionError)
    expect(ran).toBe(false)
    const message = (error as PrivilegeAssertionError).message

    // The role it refused, read back from the connection rather than assumed:
    // pg_hba is `trust` locally, so this URL connected with no password error
    // (V1) — which is the failure mode the guard exists for.
    expect(message).toContain('postgres')
    expect(message).toContain(workerDatabaseName())

    // THE POINT OF THIS LEG, and it is the trap ADR-0015 names. Supabase's
    // `postgres` has `rolsuper = FALSE` and `rolbypassrls = TRUE`, so it READS
    // as a restricted role, and it is the role the CLI and the dashboard SQL
    // editor use by default — i.e. the role a typo in the URL lands on. The
    // violation reported must be the BYPASSRLS one, and the SUPERUSER clause
    // must be SILENT: if the catch came from `rolsuper` it came from a predicate
    // that would have missed this role entirely.
    expect(message).toContain('has BYPASSRLS')
    expect(message).not.toContain('is a SUPERUSER')

    // And the second, independent reason: it owns relations in `public`.
    // Ownership bypasses RLS with no role attribute set at all (V4), so this is
    // not a restatement of the clause above. MEASURED: 11 relations.
    expect(message).toMatch(/owns [1-9][0-9]* relation\(s\) in schema public/)
  })

  it(`refuses \`${MEMBERSHIP_PRIVILEGED_ROLE}\`, which an ATTRIBUTE-ONLY predicate would pass: rolsuper and rolbypassrls are both false and it owns nothing, but SET ROLE reaches a BYPASSRLS role (V3)`, async () => {
    const { ran, error } = await withUserAgainst(urlForRole(MEMBERSHIP_PRIVILEGED_ROLE))

    expect(error).toBeInstanceOf(PrivilegeAssertionError)
    expect(ran).toBe(false)
    const message = (error as PrivilegeAssertionError).message

    expect(message).toContain(MEMBERSHIP_PRIVILEGED_ROLE)
    expect(message).toContain(workerDatabaseName())

    // THE POINT OF THIS LEG. Role attributes are NOT inherited, but `SET ROLE`
    // still works, so a guard built only on `rolsuper`/`rolbypassrls`/ownership
    // reports this connection clean while it can become `service_role`, which is
    // BYPASSRLS. The reachability clause must be the one that fired AND the three
    // attribute clauses must all be silent — that asymmetry is what distinguishes
    // "the membership predicate caught it" from "something else happened to".
    expect(message).toContain('SET ROLE')
    expect(message).toContain(REACHED_BYPASSRLS_ROLE)
    // The reason code is reported alongside the role name, so the test can assert
    // WHICH predicate matched rather than merely that a name appeared.
    expect(message).toContain(`${REACHED_BYPASSRLS_ROLE} [BYPASSRLS]`)
    expect(message).not.toContain('is a SUPERUSER')
    expect(message).not.toContain('the role has BYPASSRLS')
    expect(message).not.toContain('relation(s) in schema public')
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
// M4 — DISCARD ALL.
//
// GUARDS TEST INFRASTRUCTURE, NOT THE PRODUCT. Canon §7.6 called pooled-identity
// leak a RELEASE BLOCKER for the Node request path, and ADR-0015 retired that
// path: a browser holding a publishable key has no pool to leak through, and
// PostgREST's own connection handling is outside this repository (and outside the
// emulation — docs/supabase-port-notes.md §3 lists the pooler as NOT reproduced).
// Decision: KEPT (option (a)), re-pointed at the harness.
//
// WHY IT IS STILL WORTH GATING HERE. `isolate: false` means one worker process
// runs many test files against one clone through one pool, so the SAME backend
// serves tenancy, forgery and lifecycle assertions in sequence. A session-level
// `request.jwt.claim.sub` surviving one `runAsUser` would give the next
// CLAIMLESS read an identity — and a claimless read that returns rows instead of
// zero is precisely the observation tenancy.test.ts's denial legs are built on.
// Post-port that corruption is silent in the dangerous direction: it turns a
// denial into a pass.
// ===========================================================================
describe('harness guard M4 (test infrastructure): DISCARD ALL clears session state before the pooled connection is reused', () => {
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
//
// GUARDS TEST INFRASTRUCTURE, NOT THE PRODUCT. `queryAffectingOne` is a method on
// the harness's scoped client; no shipped code calls it, because no shipped code
// opens a `pg` connection. Decision: KEPT (option (a)), re-pointed at the
// harness.
//
// WHY IT IS STILL WORTH GATING HERE, and this is the strongest of the four. Every
// FIXTURE write in this suite goes through `queryAffectingOne` — see this file's
// own `beforeAll`, race.ts's `createDraftDecision`, tenancy.test.ts's seeds. A
// fixture INSERT that is silently filtered by a WITH CHECK affects zero rows and
// raises nothing (V7). Without the row-count assertion the suite would then run
// its denial tests against an EMPTY protected table — and an empty forced-RLS
// table does not deny at all: the policy qual is never evaluated, the read
// returns zero rows and raises nothing, so a correct policy, a broken policy and
// no policy are three names for the same observation (V18, and the reason
// posture rule 9 exists). This assertion is what keeps a failed seed from
// manufacturing a green denial.
// ===========================================================================
describe('harness guard M7 (test infrastructure): queryAffectingOne asserts exactly one affected row', () => {
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
