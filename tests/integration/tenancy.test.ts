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
 * where the only thing that varies is the identity in `app.current_user_id`.
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
 * Both were established by execution against this cluster while writing this
 * file, and both are recorded here rather than smoothed over.
 *
 * (a) V6 says a no-context `select ... where id = '<nonexistent uuid>'` returns
 *     rc=0, zero rows and no error. On this cluster, against `public.decision`
 *     and `public.decision_revision` under the `app.require_user_id()` policy,
 *     it RAISES 28000 — for an existent id, a nonexistent id, a prepared
 *     statement, `enable_seqscan = off`, a bare `count(*)`, and even for
 *     `EXPLAIN` with no `ANALYZE`. See the comment on test 3: the `EXPLAIN` leg
 *     is the discriminating evidence, and the conclusion V6 is cited for
 *     (validate the context eagerly) survives intact — for a stronger reason
 *     than V6 gives. Canon's own INV-05 requires exactly this raise, so the
 *     register and the invariant list disagree with each other; the invariant
 *     is what reproduces.
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
 * The template database ships the sentinels of migration 0006 and nothing else;
 * `aaaaaaaa-…0001` / `bbbbbbbb-…0002` live in `statesman_dev`, not here. So this
 * file seeds its own A and B.
 *
 *   - `app_user` rows go in through `ownerQuery`, because `app_user` has no
 *     grants to `statesman_app` at all (§4.6) and `statesman_migrator` is
 *     `noinherit`, so even `withMigrator` cannot reach it without `SET ROLE`.
 *   - every `decision` / `decision_revision` row goes in through the real
 *     `withUser` (§8.3), so a missing INSERT policy surfaces here instead of
 *     being bypassed by a privileged fixture.
 */
import { inspect } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  EXPECTED_APP_ROLE,
  appQuery,
  ensureWorkerDatabase,
  harnessEnv,
  ownerQuery,
  parseBoolean,
  queryRows,
  releaseProductionPools,
  runAsUser,
  workerDatabaseName,
} from './support/db'
import type { ConnectionIdentity } from './support/db'
import {
  NO_USER_CONTEXT,
  PROTECTED_TABLES,
  SENTINEL_DECISION_ID,
  SENTINEL_USER_ID,
  assertSentinelIntegrity,
} from './support/sentinels'
import { PermissionDeniedError, StatesmanError, submitDecision } from '../../src/server/db'

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
const INSERT_DECISION =
  'insert into public.decision (id, user_id, draft_payload) values ($1::uuid, $2::uuid, $3::jsonb)'
const WHO_AM_I = 'select app.require_user_id()::text as me'

const GRANT_PROTECTED = [
  { table: 'app_user', sql: 'select 1 as probe from public.app_user limit 1' },
  { table: 'user_session', sql: 'select 1 as probe from public.user_session limit 1' },
  { table: 'auth_attempt', sql: 'select 1 as probe from public.auth_attempt limit 1' },
] as const

/** Sentinel marker for a NULL timestamp, so `null` and `''` cannot be confused. */
const NO_TIMESTAMP = '(null)'

// ---------------------------------------------------------------------------
// Helpers — each one FAILS when the thing it is measuring did not happen
// ---------------------------------------------------------------------------

/**
 * psql prints the SQLSTATE inline only because `db.ts` passes
 * `VERBOSITY=verbose`: `ERROR:  28000: no user context`. Without it the line
 * carries no code and a 42501 would be indistinguishable from a 28000.
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

  // app_user: grant-protected, so the owner seeds it. `on conflict do nothing`
  // keeps this idempotent without a DELETE, which decision_revision's
  // append-only triggers would forbid anyway (V32).
  await ownerQuery(
    `insert into public.app_user (id, email, password_hash, algo_ver)
     values (:'a', 'a-tenancy@statesman.invalid', '!not-a-hash:fixture-cannot-authenticate', 1),
            (:'b', 'b-tenancy@statesman.invalid', '!not-a-hash:fixture-cannot-authenticate', 1)
     on conflict (id) do nothing;`,
    { a: USER_A, b: USER_B },
  )

  // Both of A's decisions go in through the real withUser, as A, under the real
  // INSERT policy. `queryAffectingOne` turns a WITH CHECK failure's silent
  // zero-row outcome into an error (V7).
  await runAsUser(USER_A, async (db) => {
    expect(db.userId).toBe(USER_A)
    await db.queryAffectingOne(INSERT_DECISION, [
      A_SUBMITTED_ID,
      USER_A,
      JSON.stringify({ draft: 'a-submitted' }),
    ])
    await db.queryAffectingOne(INSERT_DECISION, [
      A_DRAFT_ID,
      USER_A,
      JSON.stringify({ draft: 'a-original', n: 1 }),
    ])
  })

  // A's revision, through the definer function rather than a direct INSERT:
  // statesman_app cannot write `submitted_at` itself (it holds UPDATE on
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
      { app: EXPECTED_APP_ROLE, owner: 'statesman_owner', admin: adminRole },
    )
    expect(roles).toHaveLength(3)

    expect(parseBoolean(cell(roles, EXPECTED_APP_ROLE, 1), 'app.rolsuper')).toBe(false)
    expect(parseBoolean(cell(roles, EXPECTED_APP_ROLE, 2), 'app.rolbypassrls')).toBe(false)
    expect(intCell(roles, EXPECTED_APP_ROLE, 3)).toBe(0)

    // The bootstrap login role answers `true` to both attribute probes, which is
    // precisely why a test must never connect as it.
    expect(parseBoolean(cell(roles, adminRole, 1), 'admin.rolsuper')).toBe(true)
    expect(parseBoolean(cell(roles, adminRole, 2), 'admin.rolbypassrls')).toBe(true)

    // And the owned-table count is not constant-zero: the schema owner owns the
    // tables the app role must not.
    expect(intCell(roles, 'statesman_owner', 3)).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // 2. Missing context, existing row.
  // -------------------------------------------------------------------------
  it('[FR-14] a no-context read of an EXISTING protected row raises 28000, and the same read with context returns it', async () => {
    // No BEGIN, no set_config: `appQuery` is a bare psql statement as
    // statesman_app, which is the genuine no-context case.
    const code = await sqlstateFromPsql(() =>
      appQuery("select 'row', id::text from public.decision where id = :'did';", {
        did: SENTINEL_DECISION_ID,
      }),
    )
    expect(code).toBe(NO_USER_CONTEXT)

    // POSITIVE CONTROL. Byte-identical statement, same role, same row, same
    // session shape — the ONLY difference is that `app.current_user_id` is set.
    // Without this leg a 28000 could be coming from anywhere, and the row might
    // not exist at all.
    const withContext = await appQuery(
      `begin;
       select set_config('app.current_user_id', :'uid', true);
       select 'row', id::text from public.decision where id = :'did';
       rollback;`,
      { uid: SENTINEL_USER_ID, did: SENTINEL_DECISION_ID },
    )
    expect(cell(withContext, 'row', 1)).toBe(SENTINEL_DECISION_ID)
  })

  // -------------------------------------------------------------------------
  // 3. Missing context, NON-EXISTENT row — the V6 leg.
  // -------------------------------------------------------------------------
  it('[FR-14] a no-context read by a NON-EXISTENT id also raises 28000 on this cluster, at PLAN time — which is why withUser validates the context eagerly', async () => {
    // V6 records this case as "rc=0, zero rows, no error", and the canon cites
    // it for the eager `app.require_user_id()` call in withUser (§6.1 step 4).
    // MEASURED HERE: it raises 28000. Asserted as measured rather than as
    // written, because a test that asserts the register over the cluster is a
    // test of the document.
    const absent = await sqlstateFromPsql(() =>
      appQuery("select 'row', id::text from public.decision where id = :'did';", {
        did: ABSENT_DECISION_ID,
      }),
    )
    expect(absent).toBe(NO_USER_CONTEXT)

    // THE DISCRIMINATING LEG, and the reason this is not merely "V6 is wrong".
    // `EXPLAIN` without `ANALYZE` executes nothing, so no candidate row can
    // reach any qual — yet it raises too. The raise is therefore produced while
    // PLANNING, when selectivity estimation evaluates the STABLE accessor in
    // `user_id = app.require_user_id()`, not by the policy filtering a row.
    //
    // That makes it worthless as a denial signal: it is a property of the plan
    // the planner happened to choose, and it would disappear behind a cached
    // generic plan, a different predicate shape, or a policy written with a
    // non-raising accessor. V6's conclusion survives its observation —
    // the context must be validated eagerly and explicitly, because the query
    // path cannot be relied on to raise.
    const explained = await sqlstateFromPsql(() =>
      appQuery("explain (costs off) select id from public.decision where id = :'did';", {
        did: ABSENT_DECISION_ID,
      }),
    )
    expect(explained).toBe(NO_USER_CONTEXT)

    // POSITIVE CONTROL. With context set, the identical statement returns zero
    // rows and raises NOTHING — so the 28000 above is attributable to the
    // missing context, and absence alone is silent. This is the pairing V19
    // demands: a nonexistent id and a denied id look the same to the caller,
    // which is why no service may turn "0 rows" into a 404 on its own.
    const withContext = await appQuery(
      `begin;
       select set_config('app.current_user_id', :'uid', true);
       select 'found', count(*)::text from public.decision where id = :'did';
       rollback;`,
      { uid: USER_A, did: ABSENT_DECISION_ID },
    )
    expect(intCell(withContext, 'found', 1)).toBe(0)
  })

  // -------------------------------------------------------------------------
  // 4. Sentinel visibility, both directions, over non-empty data.
  // -------------------------------------------------------------------------
  it('[FR-14] every protected table shows exactly 1 sentinel row to the sentinel user and 0 to anyone else', async () => {
    const reports = await assertSentinelIntegrity()
    expect(reports).toHaveLength(PROTECTED_TABLES.length)

    for (const report of reports) {
      // The seed exists, read by the owner with the FORCE bracket off. Without
      // this, the two legs below are satisfied by an empty table (V18).
      expect(report.seeded).toBe(1)
      // As the sentinel user: visible. Under a foreign context: not. Same table,
      // same WHERE, same role, same statement — only the identity differs.
      expect(report.asOwnerContext).toBe(1)
      expect(report.asForeignContext).toBe(0)

      // The no-context leg. Asserted as the raise it measurably is (see test 3),
      // not as "returns 0": a `count(*)` with no context never reaches a row,
      // so a zero here would be the ambiguous reading V18 warns about, while a
      // 28000 is unambiguous. A row coming back would be fatal either way.
      expect(report.withoutContext.kind).toBe('raised')
      if (report.withoutContext.kind === 'raised') {
        expect(report.withoutContext.sqlstate).toBe(NO_USER_CONTEXT)
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
      const me = await db.queryOne<{ me: string }>(WHO_AM_I)
      expect(me.me).toBe(USER_B)
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
    const error = await rejectionOf(() =>
      runAsUser(USER_B, (db) =>
        db.query(INSERT_DECISION, [FORGED_ID, USER_A, JSON.stringify({ forged: true })]),
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
    await runAsUser(USER_B, (db) =>
      db.queryAffectingOne(INSERT_DECISION, [
        B_DECISION_ID,
        USER_B,
        JSON.stringify({ draft: 'b-own' }),
      ]),
    )
    expect(await countAs(USER_B, COUNT_DECISIONS_OWNED_BY, USER_B)).toBe(1)
    // …and A still cannot see it, which is the same denial in the other
    // direction over data that demonstrably exists.
    expect(await countAs(USER_A, COUNT_DECISIONS_OWNED_BY, USER_B)).toBe(0)
  })

  // -------------------------------------------------------------------------
  // 8. The grant-protected tables — a stronger control than RLS.
  // -------------------------------------------------------------------------
  it('[FR-14] app_user, user_session and auth_attempt deny statesman_app outright (42501), and the grant genuinely does not exist', async () => {
    for (const probe of GRANT_PROTECTED) {
      const error = await rejectionOf(() => runAsUser(USER_A, (db) => db.query(probe.sql)))
      expect(error, `public.${probe.table} must deny the app role`).toBeInstanceOf(
        PermissionDeniedError,
      )
      expect(error.sqlState, `public.${probe.table}`).toBe('42501')
    }

    // POSITIVE CONTROL 1 — grant absence, read from the catalog, with the same
    // instrument answering `true` for the tables that ARE granted. A denial that
    // only ever answers `false` cannot distinguish "no grant" from "no table".
    const privileges = await appQuery(
      `select 'app_user',          has_table_privilege(:'role','public.app_user','select')::text
       union all
       select 'user_session',      has_table_privilege(:'role','public.user_session','select')::text
       union all
       select 'auth_attempt',      has_table_privilege(:'role','public.auth_attempt','select')::text
       union all
       select 'decision',          has_table_privilege(:'role','public.decision','select')::text
       union all
       select 'decision_revision', has_table_privilege(:'role','public.decision_revision','select')::text;`,
      { role: EXPECTED_APP_ROLE },
    )
    expect(parseBoolean(cell(privileges, 'app_user', 1), 'app_user select')).toBe(false)
    expect(parseBoolean(cell(privileges, 'user_session', 1), 'user_session select')).toBe(false)
    expect(parseBoolean(cell(privileges, 'auth_attempt', 1), 'auth_attempt select')).toBe(false)
    // The control: the SAME function, the SAME role, on the user-owned tables.
    expect(parseBoolean(cell(privileges, 'decision', 1), 'decision select')).toBe(true)
    expect(parseBoolean(cell(privileges, 'decision_revision', 1), 'decision_revision select')).toBe(
      true,
    )

    // POSITIVE CONTROL 2 — information_schema agrees, and names zero privileges
    // of any kind held by the app role on the three tables while naming some on
    // `decision`. `grant select` would show up here as a row.
    const granted = await appQuery(
      `select t.table_name, count(*)::text
         from information_schema.table_privileges t
        where t.grantee = :'role' and t.table_schema = 'public'
          and t.table_name in ('app_user','user_session','auth_attempt','decision')
        group by t.table_name
        order by t.table_name;`,
      { role: EXPECTED_APP_ROLE },
    )
    const named = granted.map((row) => row[0])
    expect(named).not.toContain('app_user')
    expect(named).not.toContain('user_session')
    expect(named).not.toContain('auth_attempt')
    expect(intCell(granted, 'decision', 1)).toBeGreaterThan(0)

    // POSITIVE CONTROL 3 — the tables exist and are NOT empty. `app_user` holds
    // the sentinel plus this file's A and B, so the 42501 above is a denial over
    // real data rather than an exotic way of reading an empty table (V18).
    // unscoped-count-ok: the claim IS global and a lower bound, not an equality. This
    // asserts the table is NON-EMPTY so that the 42501 above is a denial over real data
    // rather than an exotic way of reading an empty table (V18). A scoped count cannot
    // express that, and `>= 3` is monotonic, so sibling files adding rows can only
    // strengthen it — which is the opposite of the order-dependence this gate exists for.
    const owned = await ownerQuery('select count(*)::text from public.app_user;')
    const ownerSees = Number.parseInt(owned[0]?.[0] ?? 'x', 10)
    expect(ownerSees).toBeGreaterThanOrEqual(3)
  })

  // -------------------------------------------------------------------------
  // 9. THE CONTROL FOR TESTS 5-7: can the cross-user assertion fail at all?
  // -------------------------------------------------------------------------
  it('[FR-19] with the tenancy predicate replaced by `using (true)` inside a rolled-back transaction, B DOES see A\'s row — so the cross-user tests can fail', async () => {
    // Everything happens in ONE psql session, because the policy change is DDL
    // inside an uncommitted transaction: a second connection could not see it
    // and would block on the lock. The session role is the bootstrap role —
    // the only role that can both `SET ROLE statesman_owner` (to issue the DDL)
    // and `SET ROLE statesman_app` (to take the reads). RLS is NOT bypassed by
    // that: the bypass is decided by the CURRENT role, and the script asserts
    // `current_user` is statesman_app with rolsuper/rolbypassrls both false at
    // the moment each read is taken.
    //
    // ON_ERROR_STOP=1 means any failure inside the script kills the connection,
    // which rolls the transaction back — so the bracket cannot be left open by
    // a failed assertion.
    const legs = await queryRows(
      `begin;
       set role statesman_app;
       select set_config('app.current_user_id', :'b', true);
       select 'reader', current_user,
              (select r.rolsuper::text     from pg_roles r where r.rolname = current_user),
              (select r.rolbypassrls::text from pg_roles r where r.rolname = current_user);
       select 'tenancy', count(*)::text from public.decision where user_id = :'a';

       reset role;
       set role statesman_owner;
       drop policy decision_tenancy on public.decision;
       set role statesman_app;
       select 'dropped', count(*)::text from public.decision where user_id = :'a';

       reset role;
       set role statesman_owner;
       create policy decision_tenancy_disabled on public.decision using (true) with check (true);
       set role statesman_app;
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
