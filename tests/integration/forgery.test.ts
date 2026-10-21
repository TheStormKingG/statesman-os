/**
 * Forgery — writing a row that claims to belong to someone else.   [FR-04] [FR-19] [NFR-01]
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * An adversarial pass weakened `decision_revision`'s tenancy WITH CHECK from
 *
 *     with check (user_id = app.require_user_id())
 * to
 *     with check (app.require_user_id() is not null)
 *
 * and the whole integration suite stayed green at 44/44. The weakening was then
 * shown to be EXPLOITABLE: as `statesman_app` under user B's identity context,
 * an INSERT into `public.decision_revision` carrying user A's `user_id`
 * SUCCEEDED. A revision is the permanent record FR-04 exists to protect, so a
 * forged one is not a tenancy inconvenience — it is an attack on the integrity
 * of the journal, and it was untested.
 *
 * `tenancy.test.ts` covers the same forgery against `public.decision` (its test
 * 7). It does NOT cover `decision_revision`, which is the table with the
 * append-only triggers, the composite parent FK and the content. This file
 * covers both tables, so neither depends on the other file continuing to exist,
 * and adds the relational half that no test touched at all.
 *
 * ---------------------------------------------------------------------------
 * OWNERSHIP HAS TWO HALVES, AND THEY FAIL DIFFERENTLY
 * ---------------------------------------------------------------------------
 * Canon §4.5: ownership is enforced relationally as well as by policy. The two
 * halves answer different questions, and MEASURED on this cluster they report
 * different SQLSTATEs from the same statement shape:
 *
 *   forged user_id       (A's user_id, A's decision)  -> 42501, the RLS WITH CHECK
 *   foreign parent       (B's user_id, A's decision)  -> 23503, `dr_parent_fk`
 *   rightful owner       (own user_id, own decision)  -> success
 *
 * The third line is what makes the first two mean anything. All three run the
 * same SQL text through the same role on the same connection shape; only the
 * identity and the parent id vary. So a difference in outcome is attributable
 * to the predicate and to the constraint, and not to a typo, a missing grant or
 * an empty table (V7, V18, V19).
 *
 * The 42501/23503 distinction is asserted, not just "it raised". A test that
 * accepts any error would pass if the composite FK were dropped and the policy
 * were the only thing left, and would pass again if the policy were weakened
 * and the FK were the only thing left — it cannot tell which of the two halves
 * is actually standing.
 *
 * ---------------------------------------------------------------------------
 * HOW THE WRITES ARE ROUTED
 * ---------------------------------------------------------------------------
 * Every attack and every control goes through the real `withUser` (§8.3) as
 * `statesman_app`, so the policy under test is the one production runs. Two
 * deliberate choices:
 *
 *   - an ATTACK uses `db.query`, never `db.queryAffectingOne`. A failing policy
 *     affects zero rows and raises nothing (V7), and `queryAffectingOne` turns
 *     that silence into a `RowCountError` — which would make a SILENTLY
 *     SUCCEEDING forgery and a SILENTLY DENIED one produce the same rejection
 *     type. With `db.query`, only a genuine database raise rejects, so the
 *     assertion is about the WITH CHECK and not about the harness.
 *   - a CONTROL uses `db.queryAffectingOne`, so a control that quietly wrote
 *     nothing fails instead of reading as a success.
 *
 * Each denial also carries an after-state read: under the weakened policy the
 * forged row exists and is visible to the victim, so the count assertion goes
 * red independently of whether the INSERT raised. Two legs, one mutation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureWorkerDatabase, ownerQuery, releaseProductionPools, runAsUser } from './support/db'
import { PermissionDeniedError, StatesmanError } from '../../src/server/db'
import { SENTINEL_USER_ID } from './support/sentinels'

// ---------------------------------------------------------------------------
// Identities and fixed ids
// ---------------------------------------------------------------------------
// 8-4-4-4-12 hex with a `0` version nibble: what the `uuid` column and
// `z.guid()` accept and what `z.uuid()` would reject (it enforces the RFC 9562
// version/variant nibbles, which makes it STRICTER than the column). The `f0`
// series is unique to this file, so a shared worker database cannot make one
// suite's row satisfy another suite's assertion.

const USER_A = 'aaaaaaaa-0000-0000-0000-00000000f0a1'
const USER_B = 'bbbbbbbb-0000-0000-0000-00000000f0b1'

/** A's decision. The parent every forgery tries to attach itself to. */
const A_DECISION_ID = 'dddddddd-0000-0000-0000-00000000f0a1'
/** B's own decision. The parent of the composite-FK positive control. */
const B_DECISION_ID = 'dddddddd-0000-0000-0000-00000000f0b1'

/** The revision B tries to insert under A's user_id, and that A then inserts legally. */
const FORGED_REVISION_ID = 'cccccccc-0000-0000-0000-00000000f001'
const FORGED_REVISION_TOKEN = 'eeeeeeee-0000-0000-0000-00000000f001'

/** The decision B tries to insert under A's user_id, and that A then inserts legally. */
const FORGED_DECISION_ID = 'dddddddd-0000-0000-0000-00000000f0f1'

/** The composite-FK case: B's own user_id, A's decision_id. Must never exist. */
const FK_REVISION_ID = 'cccccccc-0000-0000-0000-00000000f002'
const FK_REVISION_TOKEN = 'eeeeeeee-0000-0000-0000-00000000f002'

/** Its positive control: B's own user_id, B's own decision_id. */
const FK_CONTROL_REVISION_ID = 'cccccccc-0000-0000-0000-00000000f003'
const FK_CONTROL_TOKEN = 'eeeeeeee-0000-0000-0000-00000000f003'

/** The instrument test's throwaway row. Legal, and it must actually land. */
const INSTRUMENT_REVISION_ID = 'cccccccc-0000-0000-0000-00000000f004'
const INSTRUMENT_TOKEN = 'eeeeeeee-0000-0000-0000-00000000f004'

/** 42501 — the RLS WITH CHECK rejected the row. */
const PERMISSION_DENIED = '42501'
/** 23503 — foreign_key_violation. Deliberately NOT mapped to a typed error. */
const FOREIGN_KEY_VIOLATION = '23503'
/** The composite FK of canon §4.5, from migration 0003. */
const PARENT_FK = 'dr_parent_fk'

// ---------------------------------------------------------------------------
// Literal SQL. Text is constant; every value is a parameter.
// ---------------------------------------------------------------------------

const INSERT_DECISION =
  'insert into public.decision (id, user_id, draft_payload) ' +
  'values ($1::uuid, $2::uuid, $3::jsonb)'

const INSERT_REVISION =
  'insert into public.decision_revision ' +
  '  (id, decision_id, user_id, revision_no, content, confidence, ' +
  '   forecast, horizon, rationale, idempotency_token) ' +
  'values ($1::uuid, $2::uuid, $3::uuid, $4::int, $5::jsonb, $6::smallint, ' +
  '        $7, $8, $9, $10::uuid)'

const COUNT_REVISION_BY_ID =
  'select count(*)::int as n from public.decision_revision where id = $1::uuid'
const COUNT_DECISION_BY_ID =
  'select count(*)::int as n from public.decision where id = $1::uuid'
const COUNT_REVISIONS_OF =
  'select count(*)::int as n from public.decision_revision where decision_id = $1::uuid'

/** Every revision body is labelled fictional: canon §1.2's editorial boundary. */
const FORECAST = 'forgery fixture forecast — fictional, not a prediction'
const HORIZON = 'forgery fixture horizon'
const RATIONALE = 'forgery fixture rationale'

/** The revision tuple, built once so an attack and its control cannot drift apart. */
function revisionParams(
  id: string,
  decisionId: string,
  userId: string,
  revisionNo: number,
  token: string,
): readonly [string, string, string, number, string, number, string, string, string, string] {
  return [
    id,
    decisionId,
    userId,
    revisionNo,
    JSON.stringify({ forgery: 'fixture', revision: revisionNo }),
    50,
    FORECAST,
    HORIZON,
    RATIONALE,
    token,
  ]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The typed error a data-path call rejected with.
 *
 * Throws when the call RESOLVED, which is the whole point: "the forgery did not
 * happen" must never be inferred from the absence of evidence. Under the
 * weakened WITH CHECK the INSERT succeeds, so this is the leg that turns the
 * mutation into a failure. Rethrows anything that is not a `StatesmanError`,
 * because a pool failure or a missing table must not be read as a denial.
 */
async function rejectionOf(run: () => Promise<unknown>): Promise<StatesmanError> {
  let raised: unknown
  // A flag, not `raised === undefined`: a call that threw `undefined` would
  // otherwise be reported as having succeeded, which is the one answer this
  // helper must never give by accident.
  let resolved = false
  try {
    await run()
    resolved = true
  } catch (error: unknown) {
    raised = error
  }
  if (resolved) {
    throw new Error('expected the call to reject, but it resolved')
  }
  if (raised instanceof StatesmanError) return raised
  // Not a denial: a pool failure, a missing table or a thrown non-Error. Passed
  // through rather than interpreted, so it cannot be read as evidence.
  throw raised instanceof Error
    ? raised
    : new Error(`expected a StatesmanError, got: ${JSON.stringify(raised)}`)
}

/** A `count(*)::int` read through the real data path, as `userId`. */
async function countAs(userId: string, sql: string, id: string): Promise<number> {
  return runAsUser(userId, async (db) => {
    const row = await db.queryOne<{ n: number }>(sql, [id])
    return row.n
  })
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await ensureWorkerDatabase()

  // app_user is grant-protected — statesman_app has no privilege on it at all
  // (§4.6) — so the owner seeds it. `on conflict do nothing` keeps the file
  // re-runnable without a DELETE, which decision_revision's append-only
  // triggers would forbid anyway (V32).
  await ownerQuery(
    `insert into public.app_user (id, email, password_hash, algo_ver)
     values (:'a', 'a-forgery@statesman.invalid', '!not-a-hash:fixture-cannot-authenticate', 1),
            (:'b', 'b-forgery@statesman.invalid', '!not-a-hash:fixture-cannot-authenticate', 1)
     on conflict (id) do nothing;`,
    { a: USER_A, b: USER_B },
  )

  // Both parents go in through the real withUser, as their own owner, under the
  // real INSERT policy — so a missing or mis-scoped INSERT policy surfaces here
  // rather than being bypassed by a privileged fixture.
  await runAsUser(USER_A, async (db) => {
    expect(db.userId).toBe(USER_A)
    await db.queryAffectingOne(INSERT_DECISION, [
      A_DECISION_ID,
      USER_A,
      JSON.stringify({ draft: 'a-parent' }),
    ])
  })
  await runAsUser(USER_B, async (db) => {
    expect(db.userId).toBe(USER_B)
    await db.queryAffectingOne(INSERT_DECISION, [
      B_DECISION_ID,
      USER_B,
      JSON.stringify({ draft: 'b-parent' }),
    ])
  })
})

/**
 * Remove every row this file COMMITTED, and prove the brackets closed.
 *
 * ---------------------------------------------------------------------------
 * WHY A FILE-LEVEL CLEANUP IS NOT OPTIONAL HERE
 * ---------------------------------------------------------------------------
 * `isolate: false` gives one database per worker PROCESS, shared by every file
 * that lands in it. A forgery test cannot avoid committing: the victim's
 * decision has to be visible to the attacker's SEPARATE transaction, so there
 * is no rolled-back formulation of this suite. MEASURED, not anticipated — the
 * first green run of this file put it in the same worker as
 * `state-machine.test.ts`, whose last test asserts
 * `select count(*) from public.decision` is exactly 1, and it failed with 4:
 * the sentinel plus this file's three decisions.
 *
 * `boundary-guards.test.ts` already does the same thing for the same reason and
 * says so. This cleanup goes further because this file also creates REVISIONS:
 *
 *   - FORCE makes an owner-run `DELETE … WHERE` affect zero rows and raise
 *     nothing (V8), so the bracket is what makes the delete happen at all —
 *     without it this function would "succeed" and delete nothing;
 *   - `decision_revision`'s append-only triggers fire for the table OWNER too
 *     (V32), so the revisions cannot be deleted while they are enabled, and
 *     V32's own prescription is `DISABLE TRIGGER USER` bracketed like
 *     `NO FORCE`/`FORCE`;
 *   - revisions go before decisions, because `dr_parent_fk` is
 *     `on delete cascade` and the cascade would otherwise reach those triggers.
 *
 * It runs inside ONE transaction, so a failure mid-script rolls back to a state
 * with FORCE on and the triggers enabled rather than leaving tenancy switched
 * off for every file that follows in this worker. The after-state is then read
 * back on a fresh statement and asserted — a cleanup that quietly left FORCE
 * off would make the rest of the run vacuous and fail nothing locally.
 */
async function removeFixtureRows(): Promise<void> {
  // The row counts are read INSIDE the bracket, before FORCE goes back on, and
  // that placement is a measured fact rather than a convenience: the first
  // version of this function read them afterwards and psql returned
  // `ERROR: 28000: no user context` from `select count(*) from public.decision`
  // — as statesman_owner, under FORCE, with no identity context. The owner is
  // subject to its own tenancy policy (V8/V9), and the policy's accessor raises
  // rather than returning 0 (the same fact posture rule 9 is built on). The
  // catalog read that proves the bracket CLOSED runs after the commit, where it
  // belongs, because pg_class and pg_trigger are readable regardless of RLS.
  const after = await ownerQuery(
    `begin;
     alter table public.decision          no force row level security;
     alter table public.decision_revision no force row level security;
     alter table public.decision_revision disable trigger user;
     delete from public.decision_revision where user_id in (:'a'::uuid, :'b'::uuid);
     delete from public.decision          where user_id in (:'a'::uuid, :'b'::uuid);
     delete from public.app_user          where id      in (:'a'::uuid, :'b'::uuid);
     -- Every count here is SCOPED. An unscoped count is a whole-table claim, and
     -- vitest.integration.config.ts shares one clone across every file in the worker
     -- (isolate false), so a global count measures which siblings ran first rather than
     -- anything this file did. The old assertion passed only when this file happened to be
     -- scheduled first in its worker: 7 of 9 runs green, and one worker deterministically
     -- red. Scope to the sentinel and to this file own users, as state-machine.test.ts does.
     select 'rows',
            (select count(*)::text from public.decision
              where user_id = :'sentinel'::uuid),
            (select count(*)::text from public.decision_revision
              where user_id = :'sentinel'::uuid),
            (select count(*)::text from public.decision
              where user_id in (:'a'::uuid, :'b'::uuid)),
            (select count(*)::text from public.decision_revision
              where user_id in (:'a'::uuid, :'b'::uuid)),
            (select count(*)::text from public.app_user
              where id in (:'a'::uuid, :'b'::uuid));
     alter table public.decision_revision enable  trigger user;
     alter table public.decision          force row level security;
     alter table public.decision_revision force row level security;
     commit;
     select 'guards',
            (select count(*)::text from pg_class c
               join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public'
                and c.relname in ('decision', 'decision_revision')
                and c.relrowsecurity and c.relforcerowsecurity),
            (select count(*)::text from pg_trigger t
              where t.tgrelid = 'public.decision_revision'::regclass
                and not t.tgisinternal and t.tgenabled <> 'O');`,
    { a: USER_A, b: USER_B, sentinel: SENTINEL_USER_ID },
  )

  const rows = after.find((r) => r[0] === 'rows')
  const guards = after.find((r) => r[0] === 'guards')
  if (rows === undefined || guards === undefined) {
    throw new Error(`fixture cleanup returned no labelled rows: ${JSON.stringify(after)}`)
  }
  // Two separate claims, both scoped to things this file is entitled to assert about.
  // 1. The sentinel survived: this file's FORCE bracket and trigger disable did not take
  //    the shared fixture with them.
  if (rows[1] !== '1' || rows[2] !== '1') {
    throw new Error(
      `fixture cleanup left the sentinel at ${String(rows[1])} decision(s) and ` +
        `${String(rows[2])} revision(s), expected exactly 1 of each — the sentinel is what ` +
        'lets a later file distinguish a working policy from an empty table, so losing it ' +
        'makes every tenancy assertion after this file vacuous rather than failing',
    )
  }
  // 2. This file removed its OWN rows. Residue here is what drifts a sibling's counts.
  if (rows[3] !== '0' || rows[4] !== '0' || rows[5] !== '0') {
    throw new Error(
      `fixture cleanup left ${String(rows[3])} decision(s), ${String(rows[4])} revision(s) ` +
        `and ${String(rows[5])} user(s) belonging to this file's own fixtures — a later ` +
        'file in this worker would read them as its own',
    )
  }
  if (rows[3] !== '0') {
    throw new Error(`fixture cleanup left ${String(rows[3])} of this file's app_user rows`)
  }
  if (guards[1] !== '2') {
    throw new Error(
      `the NO FORCE bracket did not close: ${String(guards[1])} of 2 tables are ` +
        'enabled-and-forced, so tenancy enforcement is off for the rest of this worker',
    )
  }
  if (guards[2] !== '0') {
    throw new Error(
      `${String(guards[2])} user trigger(s) on decision_revision are still disabled, so ` +
        'the append-only guarantee is off for the rest of this worker (V32)',
    )
  }
}

afterAll(async () => {
  // Cleanup first: it goes through psql and does not depend on the pools, and
  // it must happen even if a test above failed.
  await removeFixtureRows()
  // The worker database is dropped by globalSetup's teardown; what has to
  // happen here is releasing the production pools and the cached privilege
  // assertion, which would otherwise hold the process open.
  await releaseProductionPools()
})

// ===========================================================================
describe('forgery', () => {
  // -------------------------------------------------------------------------
  // 0. The instrument. Everything below rests on `rejectionOf` being able to
  //    report that a call did NOT fail.
  // -------------------------------------------------------------------------
  it('[NFR-01] instrument: rejectionOf fails when the call it wraps succeeds', async () => {
    // A legal insert by its rightful owner. If `rejectionOf` could not tell
    // success from denial, every assertion in this file would be satisfied by a
    // policy that permits everything — which is precisely the mutation under
    // investigation.
    const probe = rejectionOf(() =>
      runAsUser(USER_B, (db) =>
        db.queryAffectingOne(
          INSERT_REVISION,
          revisionParams(INSTRUMENT_REVISION_ID, B_DECISION_ID, USER_B, 90, INSTRUMENT_TOKEN),
        ),
      ),
    )
    await expect(probe).rejects.toThrow('expected the call to reject, but it resolved')

    // ...and the row it wrote is really there, so the instrument's negative was
    // not produced by a write that failed in some other way.
    expect(await countAs(USER_B, COUNT_REVISION_BY_ID, INSTRUMENT_REVISION_ID)).toBe(1)
  })

  // -------------------------------------------------------------------------
  // 1. THE BLOCKING CASE. M1: this is the forgery that succeeded under the
  //    weakened WITH CHECK while the suite reported 44/44.
  // -------------------------------------------------------------------------
  it("[FR-04] [FR-19] B inserting a decision_revision under A's user_id is rejected by the WITH CHECK with 42501, writes nothing, and A can insert the identical row", async () => {
    const forged = revisionParams(
      FORGED_REVISION_ID,
      A_DECISION_ID, // A's parent
      USER_A, // ...claiming A's ownership
      1,
      FORGED_REVISION_TOKEN,
    )

    // Before: A owns no revisions of this decision at all, so the count below
    // is measuring the forgery and not pre-existing data.
    expect(await countAs(USER_A, COUNT_REVISIONS_OF, A_DECISION_ID)).toBe(0)
    expect(await countAs(USER_A, COUNT_REVISION_BY_ID, FORGED_REVISION_ID)).toBe(0)

    const rejection = await rejectionOf(() =>
      runAsUser(USER_B, (db) => db.query(INSERT_REVISION, forged)),
    )

    // 42501, and the typed error the boundary maps it to. Not "some error":
    // a 23503 here would mean the policy let the row through and the FK caught
    // it by accident, which is a different control with a different lifetime.
    expect(
      rejection.sqlState,
      `the forged revision was rejected with ${String(rejection.sqlState)}, not ` +
        `${PERMISSION_DENIED} — that is a different fault wearing the denial's clothes. ` +
        `Message: ${rejection.message}`,
    ).toBe(PERMISSION_DENIED)
    expect(rejection).toBeInstanceOf(PermissionDeniedError)
    expect(rejection.httpStatus).toBe(403)

    // After-state, read by the VICTIM — the one identity that would see the row
    // if it had landed. This is the second, independent leg: under the weakened
    // policy the INSERT resolves AND this count becomes 1.
    expect(
      await countAs(USER_A, COUNT_REVISION_BY_ID, FORGED_REVISION_ID),
      'a revision carrying A\'s user_id exists after B\'s attempt — the forgery landed',
    ).toBe(0)
    expect(await countAs(USER_A, COUNT_REVISIONS_OF, A_DECISION_ID)).toBe(0)
    // And B did not merely write a row only B can see.
    expect(await countAs(USER_B, COUNT_REVISION_BY_ID, FORGED_REVISION_ID)).toBe(0)

    // POSITIVE CONTROL: the identical tuple, inserted by its rightful owner,
    // succeeds. Same SQL, same role, same connection shape, same values — the
    // only difference is who is in `app.current_user_id`. Without this, the
    // denial above is satisfied by a NOT NULL violation, a bad enum, a missing
    // grant or a typo in the column list.
    await runAsUser(USER_A, (db) => db.queryAffectingOne(INSERT_REVISION, forged))
    expect(await countAs(USER_A, COUNT_REVISION_BY_ID, FORGED_REVISION_ID)).toBe(1)
    // ...and B still cannot see A's revision, now that one exists.
    expect(await countAs(USER_B, COUNT_REVISION_BY_ID, FORGED_REVISION_ID)).toBe(0)
  })

  // -------------------------------------------------------------------------
  // 2. The same forgery against the parent table. Covered by tenancy.test.ts
  //    test 7 as well; repeated here so this file does not depend on another
  //    agent's file for the half of the pair it is named after.
  // -------------------------------------------------------------------------
  it("[FR-19] B inserting a decision under A's user_id is rejected with 42501, and A can insert the identical row", async () => {
    const forged: readonly [string, string, string] = [
      FORGED_DECISION_ID,
      USER_A,
      JSON.stringify({ forged: true }),
    ]

    expect(await countAs(USER_A, COUNT_DECISION_BY_ID, FORGED_DECISION_ID)).toBe(0)

    const rejection = await rejectionOf(() =>
      runAsUser(USER_B, (db) => db.query(INSERT_DECISION, forged)),
    )
    expect(rejection.sqlState, rejection.message).toBe(PERMISSION_DENIED)
    expect(rejection).toBeInstanceOf(PermissionDeniedError)

    expect(await countAs(USER_A, COUNT_DECISION_BY_ID, FORGED_DECISION_ID)).toBe(0)
    expect(await countAs(USER_B, COUNT_DECISION_BY_ID, FORGED_DECISION_ID)).toBe(0)

    // POSITIVE CONTROL.
    await runAsUser(USER_A, (db) => db.queryAffectingOne(INSERT_DECISION, forged))
    expect(await countAs(USER_A, COUNT_DECISION_BY_ID, FORGED_DECISION_ID)).toBe(1)
    expect(await countAs(USER_B, COUNT_DECISION_BY_ID, FORGED_DECISION_ID)).toBe(0)
  })

  // -------------------------------------------------------------------------
  // 3. The relational half (canon §4.5). B claims its OWN user_id — so the
  //    tenancy predicate is satisfied and cannot be what rejects this — but
  //    attaches the revision to A's decision.
  // -------------------------------------------------------------------------
  it("[FR-04] B inserting a revision with its own user_id but A's decision_id violates the composite FK dr_parent_fk, specifically — not merely 'an error'", async () => {
    // revision_no 7, not 1: `dr_no_uq unique (decision_id, revision_no)` is a
    // unique index, index checks bypass row security, and test 1's control
    // already landed revision 1 of A's decision — so reusing 1 here would raise
    // 23505 from the index BEFORE the FK trigger ever ran, and this test would
    // be asserting the wrong mechanism. Measured, not assumed: that is exactly
    // what the first draft of this test did.
    const crossParent = revisionParams(
      FK_REVISION_ID,
      A_DECISION_ID, // A's parent
      USER_B, // ...but B's own ownership claim
      7,
      FK_REVISION_TOKEN,
    )

    const rejection = await rejectionOf(() =>
      runAsUser(USER_B, (db) => db.query(INSERT_REVISION, crossParent)),
    )

    // THE DISCRIMINATING ASSERTION. `dr_parent_fk` references
    // `decision (id, user_id)`, so (A's decision, B's user) resolves to no
    // parent row. MEASURED: foreign-key checks bypass row security, so the FK
    // genuinely looks at A's row and genuinely fails to match the pair —
    // 23503, not the policy's 42501.
    expect(
      rejection.sqlState,
      `expected ${FOREIGN_KEY_VIOLATION} from the composite FK, got ` +
        `${String(rejection.sqlState)}. Message: ${rejection.message}`,
    ).toBe(FOREIGN_KEY_VIOLATION)
    expect(
      rejection.constraintName,
      'the rejection did not name dr_parent_fk, so this test is not evidence that the ' +
        'composite FK is what rejected the row',
    ).toBe(PARENT_FK)
    // If this were 42501 the test would be re-measuring the policy from test 1
    // and the composite FK could have been dropped without anything noticing.
    expect(rejection.sqlState).not.toBe(PERMISSION_DENIED)

    expect(await countAs(USER_B, COUNT_REVISION_BY_ID, FK_REVISION_ID)).toBe(0)
    expect(await countAs(USER_A, COUNT_REVISION_BY_ID, FK_REVISION_ID)).toBe(0)

    // POSITIVE CONTROL: the same statement, the same identity, the same
    // ownership claim — only the parent changes, to one B owns.
    await runAsUser(USER_B, (db) =>
      db.queryAffectingOne(
        INSERT_REVISION,
        revisionParams(FK_CONTROL_REVISION_ID, B_DECISION_ID, USER_B, 1, FK_CONTROL_TOKEN),
      ),
    )
    expect(await countAs(USER_B, COUNT_REVISION_BY_ID, FK_CONTROL_REVISION_ID)).toBe(1)
  })

  // -------------------------------------------------------------------------
  // 4. The two halves are distinct controls, stated as a difference.
  // -------------------------------------------------------------------------
  it('[FR-04] [NFR-01] the forged-owner and foreign-parent cases report different SQLSTATEs, so neither control is standing in for the other', async () => {
    // Same table, same role, same column list, same revision_no, same identity
    // in the connection. The ONLY difference between the two attempts is which
    // user_id the row claims. If the WITH CHECK were weakened to
    // `app.require_user_id() is not null`, the first attempt would stop raising
    // 42501 (it would either succeed or fall through to the FK) and this
    // assertion fails along with test 1 — from a different direction.
    const forgedOwner = await rejectionOf(() =>
      runAsUser(USER_B, (db) =>
        db.query(
          INSERT_REVISION,
          revisionParams(
            'cccccccc-0000-0000-0000-00000000f005',
            A_DECISION_ID,
            USER_A,
            8, // a free revision_no: see test 3 on why reuse would raise 23505 first
            'eeeeeeee-0000-0000-0000-00000000f005',
          ),
        ),
      ),
    )
    const foreignParent = await rejectionOf(() =>
      runAsUser(USER_B, (db) =>
        db.query(
          INSERT_REVISION,
          revisionParams(
            'cccccccc-0000-0000-0000-00000000f006',
            A_DECISION_ID,
            USER_B,
            9,
            'eeeeeeee-0000-0000-0000-00000000f006',
          ),
        ),
      ),
    )

    expect(forgedOwner.sqlState).toBe(PERMISSION_DENIED)
    expect(foreignParent.sqlState).toBe(FOREIGN_KEY_VIOLATION)
    expect(forgedOwner.sqlState).not.toBe(foreignParent.sqlState)
  })
})
