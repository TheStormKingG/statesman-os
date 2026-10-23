/**
 * Tenancy — RLS and cross-user isolation.   [FR-14] [FR-19] [NFR-01]
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY DENIAL HERE IS PAIRED
 * ---------------------------------------------------------------------------
 * "0 rows" is the same observation for a working policy, a failed seed, a typo'd
 * uuid and an empty table (V18), and a failing RLS `USING` clause affects zero
 * rows while raising nothing (V7, V19). So no assertion in this file rests on a
 * row count of zero alone. Each denial is stated as a DIFFERENCE taken with the
 * same role, the same statement text, the same parameters and the same data —
 * where the only thing that varies is the identity in `request.jwt.claim.sub`,
 * which is the GUC `auth.uid()` reads (ADR-0015 §4.3).
 * A difference of 1 vs 0 under those conditions is attributable to the tenancy
 * predicate and to nothing else.
 *
 * The last test is the control for all of them: inside a rolled-back
 * transaction the tenancy predicate is replaced with `using (true)` and user B
 * then DOES see user A's row. Without it, every cross-user assertion here could
 * be satisfied by a broken fixture.
 *
 * ---------------------------------------------------------------------------
 * TWO MEASURED DEPARTURES FROM THE VERIFIED-FACTS REGISTER
 * ---------------------------------------------------------------------------
 * Both were established by execution against this cluster, and both are
 * recorded here rather than smoothed over.
 *
 * (a) THIS ENTRY IS INVERTED BY THE PORT, and the inversion is kept visible
 *     rather than edited out. It used to read: "V6 says a no-context read
 *     returns zero rows and no error; on this cluster it RAISES 28000, even
 *     under bare `EXPLAIN`, because planning evaluated the STABLE raising
 *     accessor". That was true of `app.require_user_id()`. The policies now call
 *     `auth.uid()`, which RETURNS NULL (ADR-0015's first measured loss,
 *     port finding P2), so `user_id = NULL` is never true, the scan returns
 *     nothing and nothing is raised. V6's original wording is what reproduces
 *     now; canon's INV-05, which requires the raise, applies only to the retired
 *     accessor. Test 3 measures both halves of the new behaviour, including the
 *     `EXPLAIN` leg, as the deliberate record that the fail-loud property was
 *     LOST and not merely relocated. Where it still lives is named there.
 *
 * (b) Canon §8.2 prescribes "inside a rolled-back transaction, DROP the policy
 *     and assert the row becomes visible". Measured: dropping the only policy
 *     on a table that is `ENABLE`d leaves default-deny, so the row stays
 *     invisible and the control silently proves nothing. Test 9 therefore runs
 *     three legs — tenancy policy (0), policy dropped (still 0, documenting
 *     this), permissive replacement (1) — and it is the third leg that is the
 *     control.
 *
 * ---------------------------------------------------------------------------
 * FIXTURE SHAPE
 * ---------------------------------------------------------------------------
 * The template database ships the sentinels of 20261021140600 and nothing else;
 * `aaaaaaaa-…0001` / `bbbbbbbb-…0002` live in `statesman_dev`, not here. So this
 * file seeds its own A and B.
 *
 *   - identity rows go in through `ownerQuery` (as `postgres`), because the
 *     chain is now `decision → public.profile → auth.users` and `auth.users` is
 *     the platform's: `authenticated` holds nothing on it at all. The pre-port
 *     reason — `app_user` had no grants to the app role — is retired with the
 *     table (ADR-0015 §4.6 / port notes §1), and `public.profile` IS reachable
 *     by `authenticated`, which is why test 8 below is a paired policy control
 *     rather than a grant-absence assertion.
 *   - every `decision` / `decision_revision` row goes in through the real
 *     `withUser` (§8.3), so a missing INSERT policy surfaces here instead of
 *     being bypassed by a privileged fixture.
 */
import { inspect } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  EXPECTED_APP_ROLE,
  appQuery,
  assertTestConnectionIdentity,
  ensureWorkerDatabase,
  harnessEnv,
  ownerQuery,
  parseBoolean,
  queryRows,
  releaseProductionPools,
  runAsUser,
  runScopedAs,
  workerDatabaseName,
} from './support/db'
import type { ConnectionIdentity } from './support/db'
import {
  
  PROTECTED_TABLES,
  SENTINEL_DECISION_ID,
  SENTINEL_USER_ID,
  assertSentinelIntegrity,
} from './support/sentinels'
import { PermissionDeniedError, StatesmanError, submitDecision } from '../support/scoped-pg'
import { freshScenarioVersion } from './support/scenario-fixtures'

// ---------------------------------------------------------------------------
// Identities and fixed ids
// ---------------------------------------------------------------------------
// 8-4-4-4-12 hex with a `0` version nibble, which is what `z.guid()` and the
// `uuid` column accept and what `z.uuid()` would reject. Distinct from the
// sentinel (…dead) and from the dev seeds so a cross-contaminated database is
// visible rather than coincidentally green.

const USER_A = 'aaaaaaaa-0000-0000-0000-00000000000a'
const USER_B = 'bbbbbbbb-0000-0000-0000-00000000000b'

/** A's submitted decision — carries the one revision A owns. */
const A_SUBMITTED_ID = 'dddddddd-0000-0000-0000-0000000000a1'
/** A's draft decision — the only row test 6 touches, so its payload is stable. */
const A_DRAFT_ID = 'dddddddd-0000-0000-0000-0000000000a2'
/** B's own decision, inserted as the positive control of test 7. */
const B_DECISION_ID = 'dddddddd-0000-0000-0000-0000000000b1'
/** The id B tries to insert under A's user_id. Must never exist. */
const FORGED_ID = 'dddddddd-0000-0000-0000-0000000000f1'
/** An id that is not in any table, for the V6 leg of test 3. */
const ABSENT_DECISION_ID = 'dddddddd-0000-0000-0000-0000000000ff'

const A_SUBMIT_TOKEN = 'eeeeeeee-0000-0000-0000-0000000000a1'

/** What A sees of its own rows once `beforeAll` has run. Asserted, not assumed. */
const A_EXPECTED_DECISIONS = 2
const A_EXPECTED_REVISIONS = 1

// ---------------------------------------------------------------------------
// Literal SQL. No interpolation anywhere (canon §6.1 rule 4) — the
// grant-protected probes are a fixed table of literals rather than a loop over
// a template string, so there is no code path that builds SQL text at all.
// ---------------------------------------------------------------------------

const COUNT_DECISIONS_OWNED_BY =
  'select count(*)::int as n from public.decision where user_id = $1::uuid'
const COUNT_REVISIONS_OWNED_BY =
  'select count(*)::int as n from public.decision_revision where user_id = $1::uuid'
const READ_DRAFT =
  'select draft_payload::text as payload, coalesce(draft_updated_at::text, $2) as touched ' +
  'from public.decision where id = $1::uuid'
const UPDATE_DRAFT =
  'update public.decision set draft_payload = $1::jsonb where id = $2::uuid'
// $4 is the scenario version. `decision_one_open_draft_per_scenario` permits ONE open
// draft per user per case (20261022170000), and this file seeds more than one draft for
// the same user, so each needs its own case. The product rule, not a workaround.
const INSERT_DECISION =
  'insert into public.decision (id, user_id, draft_payload, scenario_version_id) ' +
  'values ($1::uuid, $2::uuid, $3::jsonb, $4::uuid)'
/**
 * The identity, read BOTH ways, in one statement.
 *
 * `auth.uid()` is what every policy in `supabase/migrations/` consults, so it is
 * the authoritative column here. `app.require_user_id()` is the raising wrapper
 * that survives for the lifecycle SECURITY DEFINER functions and nothing else
 * (port finding P2); reading it alongside asserts the first half of finding P1 —
 * that the wrapper inside a definer body still resolves to the CALLER — rather
 * than taking it on trust. EXECUTE on both is granted to `authenticated` by
 * 20261021140100.
 *
 * Reading only the wrapper, as this did pre-port, would measure the wrapper
 * instead of the accessor the policy uses. Reading only the accessor would lose
 * the one remaining fail-loud signal in the schema.
 */
const WHO_AM_I =
  'select auth.uid()::text as me, app.require_user_id()::text as wrapped'

/** Sentinel marker for a NULL timestamp, so `null` and `''` cannot be confused. */
const NO_TIMESTAMP = '(null)'

// ---------------------------------------------------------------------------
// Helpers — each one FAILS when the thing it is measuring did not happen
// ---------------------------------------------------------------------------

/**
 * psql prints the SQLSTATE inline only because `db.ts` passes
 * `VERBOSITY=verbose`: `ERROR:  42P01: relation "public.app_user" does not
 * exist`. Without it the line carries no code, and the one surviving caller
 * (test 8) depends on telling 42P01 "the table is gone" from 42501 "the table is
 * there and ungranted" — which are different worlds and must not both read as a
 * pass. The pre-port example here was a 28000 from a policy; no policy raises
 * that any more (port finding P2).
 */
const PG_ERROR_WITH_CODE = /\bERROR:\s+([0-9A-Z]{5}):/

/**
 * The SQLSTATE a psql-routed statement raised.
 *
 * Throws when the statement SUCCEEDED, so this can never be the quiet half of a
 * gate: "it did not raise" is a failure, not an absence of evidence. Also
 * rethrows an error that carries no SQLSTATE, because a spawn failure or a
 * missing table must not be read as a denial.
 */
/**
 * A caught value rendered legibly.
 *
 * `String(value)` on a plain object yields `[object Object]`, which is exactly
 * the text an assertion message must never contain: the statement failed, the
 * SQLSTATE could not be found, and the report says nothing about why. `inspect`
 * prints the object's own contents, so a psql failure that arrives as something
 * other than an Error is still diagnosable from the failure output alone.
 */
function describeCaught(value: unknown): string {
  return typeof value === 'string' ? value : inspect(value, { depth: 3 })
}

/**
 * The same value, in a form that is safe to `throw`.
 *
 * A bare `throw caught` re-throws whatever was caught, including a non-Error,
 * which loses the stack and defeats most reporters. Wrapping preserves the
 * original under `cause` while guaranteeing the thrown value is an Error.
 */
function rethrowable(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(`a non-Error value was thrown: ${describeCaught(value)}`, { cause: value })
}

async function sqlstateFromPsql(run: () => Promise<unknown>): Promise<string> {
  let raised: unknown
  try {
    await run()
  } catch (error: unknown) {
    raised = error
  }
  if (raised === undefined) {
    throw new Error('expected the statement to raise a SQLSTATE, but it succeeded')
  }
  const text = raised instanceof Error ? raised.message : describeCaught(raised)
  const code = PG_ERROR_WITH_CODE.exec(text)?.[1]
  if (code === undefined) throw rethrowable(raised)
  return code
}

/** The typed error a data-path call rejected with. Throws when it resolved. */
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
  if (!(raised instanceof StatesmanError)) throw rethrowable(raised)
  return raised
}

/** The single psql row carrying `label` in column 0. Throws on 0 or >1. */
function labelled(rows: readonly string[][], label: string): readonly string[] {
  const matches = rows.filter((row) => row[0] === label)
  const first = matches[0]
  if (matches.length !== 1 || first === undefined) {
    throw new Error(
      `expected exactly one row labelled '${label}', got ${matches.length} ` +
        `(rows: ${JSON.stringify(rows)})`,
    )
  }
  return first
}

function cell(rows: readonly string[][], label: string, index: number): string {
  const value = labelled(rows, label)[index]
  if (value === undefined) {
    throw new Error(`row '${label}' has no column ${index}`)
  }
  return value
}

/** A psql cell as an integer. A non-numeric cell throws instead of becoming NaN. */
function intCell(rows: readonly string[][], label: string, index: number): number {
  const raw = cell(rows, label, index)
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || String(parsed) !== raw.trim()) {
    throw new Error(`row '${label}' column ${index} is not an integer: '${raw}'`)
  }
  return parsed
}

/** A `count(*)::int` read through the real data path, as `userId`. */
async function countAs(userId: string, sql: string, ownerId: string): Promise<number> {
  return runAsUser(userId, async (db) => {
    const row = await db.queryOne<{ n: number }>(sql, [ownerId])
    return row.n
  })
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let identity: ConnectionIdentity

beforeAll(async () => {
  // Creates the worker's clone AND runs the role guard inside the same cached
  // promise, so there is no path to the database that skips it.
  identity = await ensureWorkerDatabase()

  // The identity rows, through the owner connection. `on conflict do nothing`
  // keeps this idempotent without a DELETE, which decision_revision's
  // append-only triggers would forbid anyway (V32).
  await ownerQuery(
    `-- PORTED (ADR-0015): public.app_user is retired; 20261021140200 replaces the three
     -- identity tables with public.profile, whose PK carries a REAL foreign key to
     -- auth.users(id) ON DELETE RESTRICT, so the auth row must exist first. No credential
     -- column is written: encrypted_password is nullable and NULL can never verify against
     -- anything, which is stronger than the retired malformed-argon2 trick.
     insert into auth.users (id, email, created_at, updated_at)
     values (:'a', 'a-tenancy@statesman.invalid', now(), now()),
            (:'b', 'b-tenancy@statesman.invalid', now(), now())
     on conflict (id) do nothing;
     insert into public.profile (user_id, display_name)
     values (:'a', 'tenancy fixture A'), (:'b', 'tenancy fixture B')
     on conflict (user_id) do nothing;`,
    { a: USER_A, b: USER_B },
  )

  // Both of A's decisions go in through the real withUser, as A, under the real
  // INSERT policy. `queryAffectingOne` turns a WITH CHECK failure's silent
  // zero-row outcome into an error (V7).
  // Allocated BEFORE the user transaction opens, and that ordering is load-bearing.
  // freshScenarioVersion() runs ALTER TABLE on public.scenario_version on its own
  // connection, which needs ACCESS EXCLUSIVE. An insert into public.decision takes a
  // ROW SHARE lock on scenario_version through the FK, so calling it from inside an open
  // runAsUser transaction that has already inserted deadlocks: the ALTER waits for the
  // transaction and the transaction waits for the ALTER. MEASURED as a 120s hook timeout.
  const caseSubmitted = await freshScenarioVersion('tenancy-a-submitted')
  const caseDraft = await freshScenarioVersion('tenancy-a-draft')

  await runAsUser(USER_A, async (db) => {
    expect(db.userId).toBe(USER_A)
    await db.queryAffectingOne(INSERT_DECISION, [
      A_SUBMITTED_ID,
      USER_A,
      JSON.stringify({ draft: 'a-submitted' }),
      caseSubmitted,
    ])
    await db.queryAffectingOne(INSERT_DECISION, [
      A_DRAFT_ID,
      USER_A,
      JSON.stringify({ draft: 'a-original', n: 1 }),
      caseDraft,
    ])
  })

  // A's revision, through the definer function rather than a direct INSERT:
  // `authenticated` cannot write `submitted_at` itself (it holds UPDATE on
  // draft_payload only), so this is the only legal way to produce a revision.
  const submitted = await runAsUser(USER_A, (db) =>
    submitDecision(db, {
      decisionId: A_SUBMITTED_ID,
      idempotencyToken: A_SUBMIT_TOKEN,
      content: { seed: 'a-revision-1' },
      confidence: 60,
      forecast: 'fixture forecast — fictional, not a prediction',
      horizon: 'fixture horizon',
      rationale: 'fixture rationale',
    }),
  )
  expect(submitted.replayed).toBe(false)
  expect(submitted.revisionNo).toBe(1)
})

afterAll(async () => {
  // The worker database itself is dropped by globalSetup's teardown. What has to
  // happen here is releasing the production pools and the cached privilege
  // assertion, which would otherwise hold the process open.
  await releaseProductionPools()
})

// ===========================================================================
describe('tenancy', () => {
  // -------------------------------------------------------------------------
  // 1. The instrument itself.
  // -------------------------------------------------------------------------
  it('[NFR-01] instrument: the test connection is the unprivileged app role, and the guard that says so can report a negative', async () => {
    expect(identity.database).toBe(workerDatabaseName())
    // pg_hba is `trust` locally, so a typo'd or escalated username in
    // TEST_APP_DATABASE_URL_BASE connects successfully as whatever role it
    // names, with no password error (V1). The name is read back, not assumed.
    expect(identity.currentUser).toBe(EXPECTED_APP_ROLE)
    expect(identity.isSuperuser).toBe(false)
    expect(identity.bypassesRls).toBe(false)
    // Table OWNERSHIP bypasses RLS independently of role attributes (V4), so
    // the two attribute checks above do not cover it.
    expect(identity.publicTablesOwned).toBe(0)
    // Attributes are not inherited, but SET ROLE still works (V3).
    expect(identity.reachablePrivilegedRoles).toEqual([])
    // A temp table shadows an unqualified reference to a real one (V22).
    expect(identity.holdsTempOnDatabase).toBe(false)

    // POSITIVE CONTROL for the three predicates above. Same columns, same
    // expressions, same connection — three different roles. If `rolsuper`,
    // `rolbypassrls` or the owned-table count were constants (a `::text`
    // comparison that is always false, say — see parseBoolean's comment), they
    // could not come back privileged for anyone. pg_roles is world-readable, so
    // this needs no privileged connection: the measurement is taken FROM the
    // app role, about other roles.
    const adminRole = harnessEnv().TEST_ADMIN_ROLE
    const roles = await appQuery(
      `select r.rolname, r.rolsuper::text, r.rolbypassrls::text,
              (select count(*)::text from pg_class c
                 join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public' and c.relkind in ('r','p')
                  and c.relowner = r.oid)
         from pg_roles r
        where r.rolname in (:'app', :'owner', :'admin')
        order by r.rolname;`,
      // `postgres` replaces the retired schema-owner role (ADR-0015 §4.1): it owns every
      // relation in `public` and — unlike its predecessor, whose `rolbypassrls` was
      // FALSE (V34) — it is ALSO bypassrls, which is why it is the right positive control
      // here. MEASURED: it makes `rolbypassrls::text` come back 'true' for a role whose
      // `rolsuper` is 'false', proving the two columns are read independently rather than
      // one standing in for the other. That combination is the whole trap ADR-0015 names.
      { app: EXPECTED_APP_ROLE, owner: 'postgres', admin: adminRole },
    )
    expect(roles).toHaveLength(3)

    expect(parseBoolean(cell(roles, EXPECTED_APP_ROLE, 1), 'app.rolsuper')).toBe(false)
    expect(parseBoolean(cell(roles, EXPECTED_APP_ROLE, 2), 'app.rolbypassrls')).toBe(false)
    expect(intCell(roles, EXPECTED_APP_ROLE, 3)).toBe(0)

    // The bootstrap login role answers `true` to both attribute probes, which is
    // precisely why a test must never connect as it.
    expect(parseBoolean(cell(roles, adminRole, 1), 'admin.rolsuper')).toBe(true)
    expect(parseBoolean(cell(roles, adminRole, 2), 'admin.rolbypassrls')).toBe(true)

    // And the owned-relation count is not constant-zero: on Supabase our relations are
    // owned by `postgres`, which is the role the app role must not be.
    expect(intCell(roles, 'postgres', 3)).toBeGreaterThan(0)

    // =====================================================================
    // THE GUARD'S OWN NEGATIVE CONTROL — the leg this test's title promises and
    // the leg mutation M22 names as its catcher.
    // =====================================================================
    // Everything above measures the guard's INPUTS: that its three predicates
    // return privileged values for other roles. That is not the same claim as
    // "the guard refuses a privileged connection", and the difference is not
    // academic — the predicates could all be correct while the clause that acts
    // on them had been deleted, and this test would stay green. ADR-0015 requires
    // this guard to ABORT rather than warn, so the abort itself has to be
    // observed.
    //
    // So the guard is pointed at `postgres` on this worker's own database and
    // required to THROW. This is the trap ADR-0015 names: `rolsuper` is FALSE
    // there, so a superuser-only predicate would admit the one role on the
    // platform that ignores every policy, and it is the role the CLI and the
    // dashboard SQL editor use by default.
    let refusal: unknown
    try {
      await assertTestConnectionIdentity(workerDatabaseName(), { role: 'postgres' })
    } catch (error: unknown) {
      refusal = error
    }
    if (refusal === undefined) {
      throw new Error(
        'assertTestConnectionIdentity() ACCEPTED a connection as `postgres`. Every ' +
          'tenancy, cross-user and forgery assertion in this suite would pass without ' +
          'enforcing anything, and the guard that is supposed to prevent that has just ' +
          'declined to.',
      )
    }
    const message = refusal instanceof Error ? refusal.message : describeCaught(refusal)

    // WHICH predicate caught it, not merely that something did. `postgres` fails
    // several clauses at once, so asserting only "it threw" would stay green with
    // the BYPASSRLS clause removed — which is exactly mutation M22.
    expect(message, 'the guard must name BYPASSRLS, the clause that catches `postgres`').toContain(
      'BYPASSRLS',
    )
    // The two independent reasons that are NOT role attributes: ownership (V4)
    // and membership (V3). MEASURED on this cluster: `postgres` owns 11 relations
    // in `public` and reaches `service_role`, which is BYPASSRLS.
    expect(message).toMatch(/owns [1-9][0-9]* relation\(s\) in schema public/)
    expect(message).toContain('service_role')
    // And it refused by NAME read back off the live connection, which is what
    // makes this a statement about the connection rather than about the URL.
    expect(message).toContain(`current_user is 'postgres'`)
    // Fatal, not advisory.
    expect(message).toContain('INTEGRATION HARNESS ABORTED')

    // POSITIVE CONTROL ON THE NEGATIVE CONTROL. The same function, the same
    // database, the default role: it RESOLVES. Without this, a guard that threw
    // unconditionally — a typo in the probe SQL, a dropped `auth.uid()` — would
    // satisfy every assertion above while refusing the whole suite.
    const accepted = await assertTestConnectionIdentity(workerDatabaseName())
    expect(accepted.currentUser).toBe(EXPECTED_APP_ROLE)
    expect(accepted.bypassesRls).toBe(false)
  })

  // -------------------------------------------------------------------------
  // 2. No claim, EXISTING row — rewritten: denial is now SILENT.
  // -------------------------------------------------------------------------
  it('[FR-14] a no-claim read of an EXISTING protected row returns 0 rows and RAISES NOTHING, while the same read with a claim returns it', async () => {
    // THIS TEST ASSERTED THE OPPOSITE BEFORE THE PORT, and the change is the point.
    // `app.require_user_id()` raised 28000; `auth.uid()` returns NULL, so `user_id =
    // NULL` is never true, the scan returns nothing, and no error is produced. Measured
    // here rather than assumed, because the whole shape of every denial assertion in
    // this suite depends on it.
    const withoutClaim = await appQuery(
      "select 'n', count(*)::text from public.decision where id = :'did';",
      { did: SENTINEL_DECISION_ID },
    )
    expect(intCell(withoutClaim, 'n', 1)).toBe(0)

    // THE POSITIVE CONTROL, and post-port it is no longer optional decoration — it is
    // the only thing that distinguishes the zero above from an empty table, a typo'd id,
    // a failed seed or a missing grant (V18/V19). Byte-identical statement, same role,
    // same row; the ONLY difference is that a claim is set.
    const withClaim = await runScopedAs(
      SENTINEL_USER_ID,
      "select 'row', id::text from public.decision where id = :'did';",
      { vars: { did: SENTINEL_DECISION_ID } },
    )
    expect(cell(withClaim, 'row', 1)).toBe(SENTINEL_DECISION_ID)
  })

  // -------------------------------------------------------------------------
  // 3. No claim, NON-EXISTENT row — the leg that records what was LOST.
  // -------------------------------------------------------------------------
  it('[FR-14] with no claim, an EXISTING and a NON-EXISTENT id are indistinguishable — the fail-loud property of V6 is GONE from the policy path', async () => {
    // WHAT THIS TEST USED TO PROVE. Pre-port, a no-context read raised 28000 for an
    // existent id, for a nonexistent id, and even under bare `EXPLAIN` — the raise was
    // produced at PLAN time, when selectivity estimation evaluated the STABLE raising
    // accessor. That made a missing identity impossible to miss.
    //
    // WHAT IT PROVES NOW. Nothing raises. The two reads below are byte-identical except
    // for the id, and both return zero rows, which is exactly the ambiguity V19 warns
    // about: a nonexistent row and a denied row look the same to the caller. This is
    // asserted explicitly, as a deliberate record that the property was lost rather than
    // overlooked — ADR-0015 lists it as one of the two measured losses of the port.
    //
    // WHERE THE PROPERTY WENT. It cannot live in a policy predicate: a policy that
    // raised would give the local target a failure mode the live one does not have, and
    // every local denial test would then be measuring the wrapper instead of the policy.
    // It survives in exactly two places, both instruments rather than policies —
    // `beginScopedTransaction`'s identity probe in tests/support/scoped-pg/scoped.ts,
    // which rejects a transaction whose `auth.uid()` is NULL, and `runScopedAs`, which
    // raises ST099 server-side if the claim did not take effect.
    const present = await appQuery(
      "select 'n', count(*)::text from public.decision where id = :'did';",
      { did: SENTINEL_DECISION_ID },
    )
    const absent = await appQuery(
      "select 'n', count(*)::text from public.decision where id = :'did';",
      { did: ABSENT_DECISION_ID },
    )
    expect(intCell(present, 'n', 1)).toBe(0)
    expect(intCell(absent, 'n', 1)).toBe(0)

    // EXPLAIN raises nothing either, which is the discriminating half: pre-port it DID,
    // because the raise came from planning rather than from a row reaching the qual.
    // A plan coming back at all is the evidence; its text is not asserted.
    const explained = await appQuery(
      "explain (costs off) select id from public.decision where id = :'did';",
      { did: ABSENT_DECISION_ID },
    )
    expect(explained.length).toBeGreaterThan(0)

    // THE PAIR THAT STILL WORKS. With a claim, the existing row comes back and the
    // absent one does not — so the two zeros above are attributable to the missing claim
    // for the first id and to real absence for the second, which is the only way to tell
    // them apart now.
    const withClaim = await runScopedAs(
      SENTINEL_USER_ID,
      `select 'present', count(*)::text from public.decision where id = :'did';
       select 'absent',  count(*)::text from public.decision where id = :'gone';`,
      { vars: { did: SENTINEL_DECISION_ID, gone: ABSENT_DECISION_ID } },
    )
    expect(intCell(withClaim, 'present', 1)).toBe(1)
    expect(intCell(withClaim, 'absent', 1)).toBe(0)
  })

  // -------------------------------------------------------------------------
  // 4. Sentinel visibility, both directions, over non-empty data.
  // -------------------------------------------------------------------------
  it('[FR-14] every protected table shows exactly 1 sentinel row to the sentinel user and 0 to anyone else', async () => {
    const reports = await assertSentinelIntegrity()

    // THREE owner-keyed tables plus the FIVE reference tables registered in
    // public.posture_sentinel_row. The reference five are new to this assertion: under
    // the pre-port rule 9 they were WAIVED through posture_exempt_table and carried a
    // sentinel that nothing checked — true the day it was written, with nothing to notice
    // when it stopped being true. The length is asserted against the owner list plus the
    // registry rather than a literal 8, so adding a protected table cannot quietly shrink
    // what this test covers.
    const ownerKeyed = reports.filter((r) => r.keyedBy === 'owner')
    const referenceKeyed = reports.filter((r) => r.keyedBy === 'reference')
    expect(ownerKeyed).toHaveLength(PROTECTED_TABLES.length)
    expect(referenceKeyed.length).toBeGreaterThanOrEqual(5)

    for (const report of reports) {
      // The row exists, read as `postgres`. Without this the legs below are satisfied by
      // an empty table (V18). Read through a BYPASSRLS connection, so it reports
      // EXISTENCE and says nothing about enforcement.
      expect(report.seeded, `${report.table}.seeded`).toBe(1)

      // THE CLAIMLESS LEG, AND THE PORT'S CENTRAL CHANGE. Pre-port this asserted a
      // RAISED 28000. `auth.uid()` returns NULL instead, so the read returns 0 rows and
      // raises NOTHING — MEASURED. The assertion is therefore inverted: `rows` with a
      // count of 0 is the correct observation, and a RAISE here is now the anomaly,
      // because it would mean something is reproducing the retired semantics (or that a
      // 42501/42P01 is wearing the denial's clothes).
      expect(report.withoutClaim.kind, `${report.table} claimless read`).toBe('rows')
      if (report.withoutClaim.kind === 'rows') {
        expect(report.withoutClaim.count, `${report.table} claimless rows`).toBe(0)
      }

      // THE POSITIVE CONTROL, which is what makes the zero above mean anything at all:
      // same table, same WHERE, same role, same statement — only the claim differs.
      expect(report.withEntitledClaim, `${report.table} entitled`).toBe(1)

      // And the denial, for the owner-keyed tables only. A reference table's policy is
      // `auth.uid() is not null` by design, so there is no stranger to deny and
      // asserting one would be asserting more than the design promises.
      if (report.keyedBy === 'owner') {
        expect(report.withStrangerClaim, `${report.table} stranger`).toBe(0)
      }
    }
  })

  // -------------------------------------------------------------------------
  // 5. Cross-user READ.
  // -------------------------------------------------------------------------
  it('[FR-19] user B reads 0 of A\'s decisions and 0 of A\'s revisions, while A reads exactly its own — and A\'s view is unchanged after B tries', async () => {
    // POSITIVE CONTROL FIRST. If these are not the expected non-zero counts the
    // denial below is vacuous, and the test says so before asserting anything
    // about B.
    const aDecisionsBefore = await countAs(USER_A, COUNT_DECISIONS_OWNED_BY, USER_A)
    const aRevisionsBefore = await countAs(USER_A, COUNT_REVISIONS_OWNED_BY, USER_A)
    expect(aDecisionsBefore).toBe(A_EXPECTED_DECISIONS)
    expect(aRevisionsBefore).toBe(A_EXPECTED_REVISIONS)

    // THE DENIAL. Same statement text, same parameter (A's id), same role —
    // executed under B's identity.
    const seenByB = await runAsUser(USER_B, async (db) => {
      // B's context is genuinely B's, asserted on the server rather than
      // inferred from the client object: a 0 produced by an unset context would
      // be a different fault wearing this one's clothes (and withUser's eager
      // check would already have thrown).
      const me = await db.queryOne<{ me: string; wrapped: string }>(WHO_AM_I)
      expect(me.me).toBe(USER_B)
      // The raising wrapper agrees with the accessor the policy consults, so the
      // lifecycle definer functions and the policies are scoped to the same user
      // (port finding P1, first half). A disagreement here would mean the two
      // halves of the schema enforce against different identities.
      expect(me.wrapped).toBe(USER_B)
      const decisions = await db.queryOne<{ n: number }>(COUNT_DECISIONS_OWNED_BY, [USER_A])
      const revisions = await db.queryOne<{ n: number }>(COUNT_REVISIONS_OWNED_BY, [USER_A])
      return { decisions: decisions.n, revisions: revisions.n }
    })
    expect(seenByB.decisions).toBe(0)
    expect(seenByB.revisions).toBe(0)

    // THE AFTER-STATE READ. A read is not supposed to change anything, but
    // "nothing changed" is the claim, so it is measured rather than assumed.
    expect(await countAs(USER_A, COUNT_DECISIONS_OWNED_BY, USER_A)).toBe(A_EXPECTED_DECISIONS)
    expect(await countAs(USER_A, COUNT_REVISIONS_OWNED_BY, USER_A)).toBe(A_EXPECTED_REVISIONS)
  })

  // -------------------------------------------------------------------------
  // 6. Cross-user WRITE.
  // -------------------------------------------------------------------------
  it('[FR-19] B\'s UPDATE of A\'s draft affects 0 rows, raises nothing, and leaves A\'s payload byte-identical — proven by A updating the same column successfully', async () => {
    const readDraft = async (): Promise<{ payload: string; touched: string }> =>
      runAsUser(USER_A, (db) =>
        db.queryOne<{ payload: string; touched: string }>(READ_DRAFT, [
          A_DRAFT_ID,
          NO_TIMESTAMP,
        ]),
      )

    // Baseline taken from the database, not from what was seeded: jsonb
    // normalises key order and whitespace, so byte-identity is only meaningful
    // against what Postgres actually returns.
    const before = await readDraft()
    expect(before.payload).toContain('a-original')
    expect(before.touched).toBe(NO_TIMESTAMP) // touch_draft is BEFORE UPDATE only

    // THE DENIAL. Note `db.query`, not `queryAffectingOne`: the point is that
    // the statement completes with rowCount 0 and raises NOTHING (V7, V19).
    const affected = await runAsUser(USER_B, async (db) => {
      const result = await db.query(UPDATE_DRAFT, [
        JSON.stringify({ tampered: true }),
        A_DRAFT_ID,
      ])
      return result.rowCount
    })
    expect(affected).toBe(0)

    // THE AFTER-STATE READ — the assertion that actually has teeth. A rowCount
    // of 0 is byte-identical to updating a nonexistent id (V19), so the payload
    // and the trigger-maintained timestamp are both compared.
    const after = await readDraft()
    expect(after.payload).toBe(before.payload)
    expect(after.touched).toBe(before.touched)
    expect(after.payload).not.toContain('tampered')

    // POSITIVE CONTROL. The identical statement, the identical row, the
    // identical column, the identical role — run as A — affects exactly 1 row.
    // So B's 0 is the tenancy predicate, and not a missing UPDATE grant, a
    // misspelt column, a frozen draft or a wrong id.
    await runAsUser(USER_A, (db) =>
      db.queryAffectingOne(UPDATE_DRAFT, [
        JSON.stringify({ draft: 'a-updated-by-owner', n: 2 }),
        A_DRAFT_ID,
      ]),
    )
    const owned = await readDraft()
    expect(owned.payload).toContain('a-updated-by-owner')
    expect(owned.payload).not.toBe(before.payload)
    // The trigger fired, which also proves the write reached the real table
    // rather than being swallowed somewhere.
    expect(owned.touched).not.toBe(NO_TIMESTAMP)
  })

  // -------------------------------------------------------------------------
  // 7. Cross-user INSERT.
  // -------------------------------------------------------------------------
  it('[FR-19] B inserting a decision under A\'s user_id is rejected with 42501 by the WITH CHECK, not silently accepted', async () => {
    // Allocated outside the transaction: see the note in beforeAll. A valid case is
    // supplied deliberately, so that the FK and the NOT NULL are both satisfied and the
    // WITH CHECK is demonstrably the only thing left to reject the row.
    const forgedCase = await freshScenarioVersion('tenancy-forged')
    const error = await rejectionOf(() =>
      runAsUser(USER_B, (db) =>
        db.query(INSERT_DECISION, [
          FORGED_ID,
          USER_A,
          JSON.stringify({ forged: true }),
          forgedCase,
        ]),
      ),
    )
    // 42501 and not "0 rows": an INSERT cannot be silently filtered, so WITH
    // CHECK is the one place in the tenancy policy that denies LOUDLY. If this
    // ever becomes a success with a 0 row count, the policy's with_check has
    // been dropped while its using clause survived — `pg_policies.qual` is NULL
    // for INSERT-only policies (V20), so a shape check reading only `qual`
    // would not notice.
    expect(error).toBeInstanceOf(PermissionDeniedError)
    expect(error.sqlState).toBe('42501')
    expect(error.httpStatus).toBe(403)

    // THE AFTER-STATE READ: nobody can see the forged row, including A, in whose
    // name it was attempted.
    expect(await countAs(USER_A, 'select count(*)::int as n from public.decision where id = $1::uuid', FORGED_ID)).toBe(0)
    expect(await countAs(USER_B, 'select count(*)::int as n from public.decision where id = $1::uuid', FORGED_ID)).toBe(0)

    // POSITIVE CONTROL. Same statement, same role, same session — B inserting
    // under B's OWN id succeeds and affects exactly 1 row. So the 42501 above is
    // the WITH CHECK predicate, and not a missing INSERT grant, a foreign-key
    // failure or a malformed statement.
    const ownCase = await freshScenarioVersion('tenancy-b-own')
    await runAsUser(USER_B, (db) =>
      db.queryAffectingOne(INSERT_DECISION, [
        B_DECISION_ID,
        USER_B,
        JSON.stringify({ draft: 'b-own' }),
        ownCase,
      ]),
    )
    expect(await countAs(USER_B, COUNT_DECISIONS_OWNED_BY, USER_B)).toBe(1)
    // …and A still cannot see it, which is the same denial in the other
    // direction over data that demonstrably exists.
    expect(await countAs(USER_A, COUNT_DECISIONS_OWNED_BY, USER_B)).toBe(0)
  })

  // -------------------------------------------------------------------------
  // 8. The identity table — rewritten: grant-absence is no longer available.
  // -------------------------------------------------------------------------
  it('[FR-14] app_user, user_session and auth_attempt are GONE, and public.profile is reachable but policy-scoped — the grant-absence layer is retired, not weakened', async () => {
    // WHAT THIS TEST USED TO PROVE, AND WHY IT CANNOT ANY MORE.
    //
    // Pre-port the three identity tables had NO grants to the app role at all (canon
    // §4.6), so they denied with 42501 from the absent grant — a control STRONGER than
    // RLS, because it does not depend on a policy predicate being right. ADR-0015 retires
    // ADR-0002 and 20261021140200 replaces all three with `public.profile`. That layer is
    // therefore GONE, and this test records its removal explicitly rather than being
    // deleted: a signed-in user edits their own display name directly and there is no
    // server left to proxy it, so `profile` must be reachable by `authenticated` and is
    // protected by a policy like any other table.
    //
    // THE CONSEQUENCE, STATED PLAINLY: `profile` is now defended by ONE mechanism where
    // its predecessor had two. That is why 20261021140600 seeds it a sentinel and why
    // posture rule 9a counts it.
    //
    // Leg 1 — the retired tables do not exist. Asserted as 42P01 from a real query rather
    // than from the catalog alone, so "it is gone" is observed the way a caller would
    // observe it. A 42501 here would mean the table still exists and is merely ungranted,
    // which is a different world and must not read as a pass.
    for (const name of ['app_user', 'user_session', 'auth_attempt'] as const) {
      const code = await sqlstateFromPsql(() =>
        appQuery(`select 1 as probe from public.${name} limit 1;`),
      )
      expect(code, `public.${name} must no longer exist`).toBe('42P01')
    }

    // POSITIVE CONTROL for leg 1 — the same instrument, same role, on a table that DOES
    // exist, returns no error at all. Without this, '42P01 everywhere' would also be the
    // observation if the connection or the database were wrong.
    const exists = await appQuery("select 'n', count(*)::text from public.profile;")
    expect(intCell(exists, 'n', 1)).toBe(0) // reachable, and claimless => 0 rows, no error

    // Leg 2 — the catalog agrees that the three are absent and `profile` is present.
    const rels = await ownerQuery(
      `select c.relname, 'yes'
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname in ('app_user','user_session','auth_attempt','profile')
        order by c.relname;`,
    )
    expect(rels.map((r) => r[0])).toEqual(['profile'])

    // Leg 3 — `authenticated` holds exactly the narrow grants 20261021140200 intends on
    // `profile`: SELECT and INSERT, and UPDATE on `display_name` ONLY. The negative half
    // matters as much as the positive: DELETE must not be held, because erasure is a
    // product feature with a deliberate path (FR-16) and not a row the client can drop.
    const privs = await appQuery(
      `select 'select', has_table_privilege(:'role','public.profile','select')::text
       union all
       select 'insert', has_table_privilege(:'role','public.profile','insert')::text
       union all
       select 'delete', has_table_privilege(:'role','public.profile','delete')::text
       union all
       select 'upd_display', has_column_privilege(:'role','public.profile','display_name','update')::text
       union all
       select 'upd_user_id', has_column_privilege(:'role','public.profile','user_id','update')::text;`,
      { role: EXPECTED_APP_ROLE },
    )
    expect(parseBoolean(cell(privs, 'select', 1), 'profile select')).toBe(true)
    expect(parseBoolean(cell(privs, 'insert', 1), 'profile insert')).toBe(true)
    expect(parseBoolean(cell(privs, 'delete', 1), 'profile delete')).toBe(false)
    expect(parseBoolean(cell(privs, 'upd_display', 1), 'profile update display_name')).toBe(true)
    expect(parseBoolean(cell(privs, 'upd_user_id', 1), 'profile update user_id')).toBe(false)

    // Leg 4 — THE PAIR that replaces the retired grant-absence control. A reaches its own
    // profile; B does not reach A's. Same statement, same role, only the claim differs,
    // over a row that demonstrably exists (leg 5).
    const asA = await runScopedAs(
      USER_A,
      "select 'n', count(*)::text from public.profile where user_id = :'a';",
      { vars: { a: USER_A } },
    )
    const asB = await runScopedAs(
      USER_B,
      "select 'n', count(*)::text from public.profile where user_id = :'a';",
      { vars: { a: USER_A } },
    )
    expect(intCell(asA, 'n', 1)).toBe(1)
    expect(intCell(asB, 'n', 1)).toBe(0)

    // Leg 5 — and the rows are really there, so leg 4's zero is a denial rather than an
    // empty table. unscoped-count-ok: the claim is a global LOWER BOUND, not an equality,
    // and a scoped count cannot express it. `>= 3` is the sentinel plus this file's A and
    // B, and it is monotonic, so sibling files adding profiles can only strengthen it.
    const all = await ownerQuery('select count(*)::text from public.profile;')
    expect(Number.parseInt(all[0]?.[0] ?? 'x', 10)).toBeGreaterThanOrEqual(3)
  })

  // -------------------------------------------------------------------------
  // 9. THE CONTROL FOR TESTS 5-7: can the cross-user assertion fail at all?
  // -------------------------------------------------------------------------
  it('[FR-19] with the tenancy predicate replaced by `using (true)` inside a rolled-back transaction, B DOES see A\'s row — so the cross-user tests can fail', async () => {
    // Everything happens in ONE psql session, because the policy change is DDL
    // inside an uncommitted transaction: a second connection could not see it
    // and would block on the lock. The session role is the bootstrap role — the
    // only role that can both `SET ROLE postgres` (to issue the DDL on relations
    // `postgres` owns) and `SET ROLE authenticated` (to take the reads).
    //
    // RLS IS NOT BYPASSED BY THAT, and post-port the reason has to be stated more
    // carefully than before: the bypass is decided by the CURRENT role, and BOTH
    // the bootstrap role (rolsuper) and `postgres` (rolbypassrls) would bypass it.
    // So the script asserts, at the moment each read is taken, that `current_user`
    // is `authenticated` with `rolsuper` AND `rolbypassrls` both false. Without
    // that assertion a `reset role` left in the wrong place would make all three
    // legs read as the bootstrap role and the control would "pass" by bypassing
    // the very policy it is manipulating.
    //
    // ON_ERROR_STOP=1 means any failure inside the script kills the connection,
    // which rolls the transaction back — so the bracket cannot be left open by
    // a failed assertion.
    const legs = await queryRows(
      `begin;
       set role authenticated;
       select set_config('request.jwt.claim.sub', :'b', true);
       select set_config('request.jwt.claims', '', true);
       select 'reader', current_user,
              (select r.rolsuper::text     from pg_roles r where r.rolname = current_user),
              (select r.rolbypassrls::text from pg_roles r where r.rolname = current_user);
       select 'claim1', coalesce(auth.uid()::text, '(null)');
       select 'tenancy', count(*)::text from public.decision where user_id = :'a';

       reset role;
       set role postgres;
       drop policy decision_tenancy on public.decision;
       set role authenticated;
       select 'claim2', coalesce(auth.uid()::text, '(null)');
       select 'dropped', count(*)::text from public.decision where user_id = :'a';

       reset role;
       set role postgres;
       create policy decision_tenancy_disabled on public.decision using (true) with check (true);
       set role authenticated;
       select 'claim3', coalesce(auth.uid()::text, '(null)');
       select 'permissive', count(*)::text from public.decision where user_id = :'a';

       rollback;

       select 'policies', coalesce(string_agg(p.polname, ',' order by p.polname), '(none)')
         from pg_policy p join pg_class c on c.oid = p.polrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'decision';
       select 'rls', c.relrowsecurity::text, c.relforcerowsecurity::text
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'decision';`,
      { db: workerDatabaseName(), vars: { a: USER_A, b: USER_B } },
    )

    // The reads were genuinely taken under RLS, as the app role.
    expect(cell(legs, 'reader', 1)).toBe(EXPECTED_APP_ROLE)
    expect(parseBoolean(cell(legs, 'reader', 2), 'reader.rolsuper')).toBe(false)
    expect(parseBoolean(cell(legs, 'reader', 3), 'reader.rolbypassrls')).toBe(false)

    // AND THE CLAIM TRAVELLED, asserted once per leg. This is not belt and
    // braces, it is the only thing that makes leg 1 a result at all: post-port a
    // claim that never arrived makes `auth.uid()` NULL, `user_id = NULL` is never
    // true, and leg 1's zero appears with nothing raised — identical to the
    // observation a working policy produces. `set_config(..., true)` is SET LOCAL
    // and does nothing outside an explicit transaction block, and the two
    // `reset role` / `set role` pairs between the legs are exactly the kind of
    // session churn that invites the assumption that it survived. Measured per
    // leg rather than once, because each leg is read after a role switch.
    for (const label of ['claim1', 'claim2', 'claim3'] as const) {
      expect(cell(legs, label, 1), `${label}: auth.uid() inside the bracket`).toBe(USER_B)
    }

    // Leg 1 — the tenancy policy in force: B sees nothing of A's. This is
    // tests 5-7's observation, reproduced here inside the bracket.
    expect(intCell(legs, 'tenancy', 1)).toBe(0)

    // Leg 2 — MEASURED, and the reason canon §8.2's wording does not work as
    // written. Dropping the ONLY policy on an `ENABLE`d table leaves
    // default-deny, so the row stays invisible: "drop the policy and assert the
    // row becomes visible" is a control that cannot ever succeed, and a suite
    // that implemented it literally would report a failure it would then be
    // tempted to explain away.
    expect(intCell(legs, 'dropped', 1)).toBe(0)

    // Leg 3 — THE ACTUAL CONTROL. Replace the predicate with `using (true)` and
    // A's rows become visible to B. The role, the statement, the parameters and
    // the data are all unchanged from leg 1; the only difference is the policy
    // expression. That is the proof that leg 1, and tests 5-7, measure the
    // tenancy predicate and could report the opposite. The expected figure is
    // A's real row count, so a fixture that lost its seed fails here too.
    expect(intCell(legs, 'permissive', 1)).toBe(A_EXPECTED_DECISIONS)

    // And the bracket closed. Leaving the permissive policy behind — or the
    // table with no policy at all — would make every later assertion in this
    // worker meaningless, so the catalog is read after the ROLLBACK rather than
    // trusted.
    expect(cell(legs, 'policies', 1)).toBe('decision_tenancy')
    expect(parseBoolean(cell(legs, 'rls', 1), 'decision.relrowsecurity')).toBe(true)
    expect(parseBoolean(cell(legs, 'rls', 2), 'decision.relforcerowsecurity')).toBe(true)

    // Belt and braces, through the real data path rather than the catalog: B is
    // back to seeing none of A's rows.
    expect(await countAs(USER_B, COUNT_DECISIONS_OWNED_BY, USER_A)).toBe(0)
    expect(await countAs(USER_A, COUNT_DECISIONS_OWNED_BY, USER_A)).toBe(A_EXPECTED_DECISIONS)
  })
})
