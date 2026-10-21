/**
 * The decision lifecycle — integration.
 *
 * Covers the §4.4 / §4.6b invariants end to end against a real cloned database, through
 * the real `withUser` seam (`runAsUser`), as `statesman_app`.
 *
 * TAG MAPPING (docs/PRD.md §FR table), stated rather than implied:
 *   FR-03  structured response + draft saving; incomplete drafts reopen without loss
 *          -> the draft state, the frozen-draft rule and its unsubmitted control.
 *   FR-04  immutable submitted version; edits create a NEW revision, not a replacement
 *          -> submit, idempotency, append-only, append_revision, the grant model.
 *   FR-05  confidence 0-100 plus a stated expected outcome and timeframe
 *          -> the database-layer validation of confidence / forecast / horizon.
 *   FR-12  reassessment; BOTH attempts remain visible
 *          -> revision 2 alongside revision 1, and the milestone progression that
 *             carries a decision through reflection to closure.
 *
 * TWO RULES THIS FILE IS WRITTEN TO
 *
 * 1. NO GATE WITHOUT A POSITIVE CONTROL (canon §8). Every rejection below is paired
 *    with a statement that is identical in shape and differs only in the one variable
 *    under test, run by the same role against a row proven reachable. The reason is
 *    V18/V19: "0 rows" and "it threw" are the same observation for a working guard, a
 *    failed fixture, a typo'd uuid and an empty table. The frozen-draft pair is the
 *    sharpest case — V31 records a version of that guard that was *unreachable* for the
 *    submitted row because an early return preceded it, and the only thing that
 *    distinguishes "guard fires" from "guard is dead code that nothing reaches" is the
 *    unsubmitted control succeeding in the same breath.
 *
 * 2. A ROW COUNT OF 0 IS NEVER A SUCCESS SIGNAL (V7), and neither is a bare error. Where
 *    two different faults can raise the same class, the SQLSTATE is asserted, not just
 *    the type: `RowCountError` is raised BOTH by `app.stamp_milestone`'s
 *    `get diagnostics` assertion (sqlState ST005) and by the client-side `queryOne`
 *    guard (sqlState undefined). Asserting only `kind === 'row_count'` would pass if the
 *    database check were deleted, so every such assertion reads `.sqlState`.
 *
 * Each test builds its own decisions. Users are shared because `app_user` rows are inert
 * containers here; every row that carries lifecycle state is per-test, so no test can
 * leave a state another test reads.
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MILESTONES,
  StatesmanError,
  appendRevision,
  stampMilestone,
  submitDecision,
} from '../../src/server/db'
import type { MilestoneName, RevisionInput, UserScopedClient } from '../../src/server/db'
import {
  ensureWorkerDatabase,
  ownerQuery,
  parseBoolean,
  releaseProductionPools,
  runAsUser,
} from './support/db'
import { assertSentinelIntegrity } from './support/sentinels'

/* ------------------------------------------------------------------ *
 * Shapes read back from the database
 * ------------------------------------------------------------------ */

type DecisionRow = {
  state: string
  draft_payload: Record<string, unknown>
  submitted_at: string | null
  challenged_at: string | null
  closed_at: string | null
  draft_updated_at: string | null
}

type RevisionRow = {
  id: string
  user_id: string
  revision_no: number
  content: Record<string, unknown>
  confidence: number
  forecast: string
  horizon: string
  rationale: string
}

const READ_DECISION_SQL =
  'select state::text as state, draft_payload, submitted_at::text as submitted_at, ' +
  'challenged_at::text as challenged_at, closed_at::text as closed_at, ' +
  'draft_updated_at::text as draft_updated_at ' +
  'from public.decision where id = $1::uuid'

const INSERT_DECISION_SQL =
  'insert into public.decision (user_id, draft_payload) values ($1::uuid, $2::jsonb) returning id'

const UPDATE_DRAFT_SQL =
  'update public.decision set draft_payload = $2::jsonb where id = $1::uuid'

const UPDATE_SUBMITTED_AT_SQL =
  'update public.decision set submitted_at = now() where id = $1::uuid'

const LIST_REVISIONS_SQL =
  'select id, user_id::text as user_id, revision_no, content, confidence, forecast, ' +
  'horizon, rationale from public.decision_revision where decision_id = $1::uuid ' +
  'order by revision_no'

const UPDATE_REVISION_SQL =
  'update public.decision_revision set rationale = $2::text where id = $1::uuid'

const DELETE_REVISION_SQL = 'delete from public.decision_revision where id = $1::uuid'

/**
 * The definer calls, spelled out here as well as in `scoped.ts`.
 *
 * This duplication is deliberate and is the point of §FR-05's test: the production
 * wrapper validates `confidence` with Zod BEFORE the call, so `submitDecision(db, {
 * confidence: -1 })` never reaches Postgres and proves nothing about the database's own
 * `check (confidence between 0 and 100)`. Reaching the column constraint requires
 * issuing the call the wrapper would refuse. Both layers are then asserted separately.
 *
 * The casts pin overload resolution exactly as production does, and every value is a
 * parameter — nothing is interpolated (rule 4).
 */
const RAW_DEFINER_ARGS = '$1::uuid, $2::uuid, $3::jsonb, $4::smallint, $5::text, $6::text, $7::text'
const RAW_SUBMIT_SQL = `select revision_id, revision_no, replayed from app.submit_decision(${RAW_DEFINER_ARGS})`

/**
 * The owner-side append-only probe, as a rolled-back script.
 *
 * `statesman_app` holds no UPDATE or DELETE grant on `decision_revision`, so the app
 * role is stopped by privilege checking and never reaches the trigger. That leaves the
 * trigger itself unproven from the app role's seat, which matters because the trigger is
 * what V32 says is role-independent. This script runs as the schema owner with the FORCE
 * bracket off — the same bracket `sentinels.ts` and `0006` use — so a candidate row
 * actually reaches `app.forbid_mutation()`.
 *
 * It is safe despite touching RLS: the `alter table` is inside the transaction, so
 * whether the DELETE raises (psql aborts under ON_ERROR_STOP and the session ends, which
 * rolls back) or unexpectedly succeeds (the explicit `rollback` runs), FORCE is restored
 * either way. The test re-reads `pg_class` afterwards rather than trusting that argument.
 */
const OWNER_DELETE_REVISION_SQL =
  'begin;\n' +
  'alter table public.decision_revision no force row level security;\n' +
  "delete from public.decision_revision where id = :'rid';\n" +
  'rollback;'

const READ_REVISION_RLS_SQL =
  'select c.relrowsecurity::text, c.relforcerowsecurity::text ' +
  'from pg_class c join pg_namespace n on n.oid = c.relnamespace ' +
  "where n.nspname = 'public' and c.relname = 'decision_revision'"

const INSERT_APP_USER_SQL =
  'insert into public.app_user (id, email, password_hash, algo_ver) ' +
  "values (:'id', :'email', :'hash', 1);"

/**
 * Not a valid argon2 encoding, for the same reason `0006` uses one: no credential can
 * ever verify against it, so a fixture user cannot be signed in as.
 */
const UNUSABLE_HASH = '!not-a-hash:lifecycle-fixture-cannot-authenticate'

/* ------------------------------------------------------------------ *
 * Error inspection
 * ------------------------------------------------------------------ */

/**
 * psql prints `ERROR:  ST001: decision_revision is append-only` because `db.ts` runs it
 * with VERBOSITY=verbose; the default verbosity omits the code entirely, which would
 * make a SQLSTATE assertion unsatisfiable rather than false.
 */
const PG_ERROR_WITH_CODE = /\bERROR:\s+([0-9A-Z]{5}):/

function psqlSqlstateOf(error: unknown): string | undefined {
  const text = error instanceof Error ? error.message : String(error)
  return PG_ERROR_WITH_CODE.exec(text)?.[1]
}

/**
 * Run `fn` through the real `withUser` and require that it be REJECTED, returning the
 * typed error for inspection.
 *
 * Each expected rejection gets its own `runAsUser`, deliberately. Postgres marks the
 * whole transaction aborted after an error, so a second statement issued inside the same
 * block would fail with 25P02 and the test would be asserting the wrong thing.
 */
async function captureRejection(
  userId: string,
  fn: (db: UserScopedClient) => Promise<unknown>,
): Promise<StatesmanError> {
  let resolved: unknown
  try {
    resolved = await runAsUser(userId, fn)
  } catch (error: unknown) {
    if (error instanceof StatesmanError) return error
    throw error
  }
  throw new Error(
    `expected the statement to be rejected, but it resolved with ${JSON.stringify(resolved) ?? 'undefined'}. ` +
      'A guard that cannot be made to fail has not been shown to work.',
  )
}

/** Same, for a psql script run as the schema owner. Returns the SQLSTATE. */
async function captureOwnerSqlstate(
  sql: string,
  vars: Readonly<Record<string, string>>,
): Promise<string> {
  try {
    await ownerQuery(sql, vars)
  } catch (error: unknown) {
    const code = psqlSqlstateOf(error)
    if (code === undefined) throw error
    return code
  }
  throw new Error('expected the owner-side statement to be rejected, but psql exited 0')
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/**
 * `app_user` carries NO grants to `statesman_app` (§4.6), so a fixture user cannot be
 * created through `withUser` at all; this is the one place the harness's owner seam is
 * the only option. Decisions, by contrast, ARE created through `withUser` (§8.3), so a
 * missing INSERT policy surfaces here instead of being bypassed by the owner.
 */
async function seedUser(): Promise<string> {
  const id = randomUUID()
  await ownerQuery(INSERT_APP_USER_SQL, {
    id,
    email: `lifecycle+${id}@statesman.invalid`, // .invalid is reserved (RFC 2606)
    hash: UNUSABLE_HASH,
  })
  return id
}

async function seedDraft(
  userId: string,
  payload: Record<string, unknown> = { title: 'fixture draft' },
): Promise<string> {
  return runAsUser(userId, async (db) => {
    const row = await db.queryOne<{ id: string }>(INSERT_DECISION_SQL, [
      db.userId,
      JSON.stringify(payload),
    ])
    return row.id
  })
}

/**
 * Read one decision as its owner.
 *
 * `queryOne` asserts exactly one row, so every call is also the positive control that
 * the row is visible to its owner — the leg that makes a later "B sees nothing"
 * attributable to the policy rather than to a fixture that never committed (V18).
 */
async function readDecision(userId: string, decisionId: string): Promise<DecisionRow> {
  return runAsUser(userId, async (db) => db.queryOne<DecisionRow>(READ_DECISION_SQL, [decisionId]))
}

async function readRevisions(userId: string, decisionId: string): Promise<RevisionRow[]> {
  return runAsUser(userId, async (db) => {
    const result = await db.query<RevisionRow>(LIST_REVISIONS_SQL, [decisionId])
    return [...result.rows]
  })
}

function revisionInput(decisionId: string, overrides: Partial<RevisionInput> = {}): RevisionInput {
  return {
    decisionId,
    idempotencyToken: randomUUID(),
    content: { position: 'fictional fixture position', dated: '2026-10-21' },
    confidence: 70,
    forecast: 'fictional fixture forecast — not a prediction',
    horizon: '90 days',
    rationale: 'fixture rationale',
    ...overrides,
  }
}

/** The state each milestone must produce. `closed` derives `reviewed_closed` (§4.4). */
const MILESTONE_STATE: Readonly<Record<MilestoneName, string>> = {
  challenged: 'challenged',
  reflected: 'reflected',
  action_recorded: 'action_recorded',
  closed: 'reviewed_closed',
}

/* ------------------------------------------------------------------ *
 * Suite
 * ------------------------------------------------------------------ */

describe('decision lifecycle', () => {
  let userA = ''
  let userB = ''

  beforeAll(async () => {
    await ensureWorkerDatabase()
    // Harness-fatal, and it is the precondition for test 12: it proves RLS is ENABLED
    // and FORCED on both protected tables in THIS worker's clone, and that a sentinel
    // row is visible as its owner and invisible under a foreign identity. Without it,
    // the cross-user assertion below is satisfied by an empty table (V18).
    await assertSentinelIntegrity()
    userA = await seedUser()
    userB = await seedUser()
  })

  afterAll(async () => {
    await releaseProductionPools()
  })

  // 1 ----------------------------------------------------------------
  it('[FR-03] a freshly created decision derives state draft', async () => {
    const decisionId = await seedDraft(userA, { title: 'untouched draft' })
    const decision = await readDecision(userA, decisionId)

    expect(decision.state).toBe('draft')
    expect(decision.submitted_at).toBeNull()
    expect(decision.draft_payload).toEqual({ title: 'untouched draft' })
    // No revision exists yet: "draft" is not a side effect of a failed insert.
    expect(await readRevisions(userA, decisionId)).toHaveLength(0)
  })

  // 2 ----------------------------------------------------------------
  it('[FR-04] statesman_app cannot write a milestone timestamp directly (42501)', async () => {
    const decisionId = await seedDraft(userA)

    const error = await captureRejection(userA, async (db) =>
      db.query(UPDATE_SUBMITTED_AT_SQL, [decisionId]),
    )
    expect(error.sqlState).toBe('42501')
    expect(error.kind).toBe('permission_denied')

    // POSITIVE CONTROL. Same role, same row, same statement shape — only the COLUMN
    // differs. `statesman_app` holds UPDATE (draft_payload) and nothing else, so this
    // succeeding is what proves the 42501 above is the column grant talking and not an
    // unreachable row, a missing table or a broken connection.
    await runAsUser(userA, async (db) => {
      await db.queryAffectingOne(UPDATE_DRAFT_SQL, [decisionId, JSON.stringify({ edited: true })])
    })

    const after = await readDecision(userA, decisionId)
    expect(after.draft_payload).toEqual({ edited: true })
    expect(after.submitted_at).toBeNull() // the refused write left nothing behind
    expect(after.draft_updated_at).not.toBeNull() // app.touch_draft() ran
    expect(after.state).toBe('draft')
  })

  // 3 ----------------------------------------------------------------
  it('[FR-04][FR-05] submit_decision writes revision 1, returns replayed=false, and the state becomes submitted', async () => {
    const decisionId = await seedDraft(userA)
    const input = revisionInput(decisionId)

    const result = await runAsUser(userA, async (db) => submitDecision(db, input))

    expect(result.revisionNo).toBe(1)
    expect(result.replayed).toBe(false)
    expect(result.revisionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

    const decision = await readDecision(userA, decisionId)
    expect(decision.state).toBe('submitted')
    expect(decision.submitted_at).not.toBeNull()

    const revisions = await readRevisions(userA, decisionId)
    expect(revisions).toHaveLength(1)
    const [revision] = revisions
    expect(revision?.id).toBe(result.revisionId)
    expect(revision?.revision_no).toBe(1)
    // Identity is DERIVED inside the definer function, never passed (§4.6b rule 1).
    expect(revision?.user_id).toBe(userA)
    expect(revision?.content).toEqual(input.content)
    expect(revision?.confidence).toBe(input.confidence)
    expect(revision?.forecast).toBe(input.forecast)
    expect(revision?.horizon).toBe(input.horizon)
    expect(revision?.rationale).toBe(input.rationale)
  })

  // 4 ----------------------------------------------------------------
  it('[FR-04] a replayed idempotency token returns the existing revision, replayed=true, and writes nothing', async () => {
    const decisionId = await seedDraft(userA)
    const first = revisionInput(decisionId)
    const original = await runAsUser(userA, async (db) => submitDecision(db, first))

    // Same token, DIFFERENT content. If the replay path wrote instead of returning, the
    // stored content would change — which is a stronger reading than the row count alone.
    const replayInput = revisionInput(decisionId, {
      idempotencyToken: first.idempotencyToken,
      content: { position: 'content that must never be stored' },
      confidence: 5,
    })
    const replay = await runAsUser(userA, async (db) => submitDecision(db, replayInput))

    expect(replay.replayed).toBe(true)
    expect(replay.revisionNo).toBe(original.revisionNo)
    expect(replay.revisionId).toBe(original.revisionId)

    const revisions = await readRevisions(userA, decisionId)
    expect(revisions).toHaveLength(1)
    expect(revisions[0]?.content).toEqual(first.content)
    expect(revisions[0]?.confidence).toBe(first.confidence)
  })

  // 5 ----------------------------------------------------------------
  it('[FR-04] a different token against an already-submitted decision raises ST010', async () => {
    const decisionId = await seedDraft(userA)
    await runAsUser(userA, async (db) => submitDecision(db, revisionInput(decisionId)))

    const error = await captureRejection(userA, async (db) =>
      submitDecision(db, revisionInput(decisionId)),
    )
    expect(error.sqlState).toBe('ST010')
    expect(error.kind).toBe('invalid_decision_state')

    // POSITIVE CONTROL. The identical call shape, with a fresh token, against a draft:
    // it succeeds, so the ST010 above is about the decision's STATE and not about a
    // malformed call, a revoked EXECUTE grant or a wrong overload.
    const freshDraft = await seedDraft(userA)
    const control = await runAsUser(userA, async (db) =>
      submitDecision(db, revisionInput(freshDraft)),
    )
    expect(control.replayed).toBe(false)
    expect(control.revisionNo).toBe(1)

    // The refused submit added nothing.
    expect(await readRevisions(userA, decisionId)).toHaveLength(1)
  })

  // 6 ----------------------------------------------------------------
  it('[FR-03][FR-04] a submitted decision freezes its draft (ST003) while an unsubmitted one still accepts edits', async () => {
    const submitted = await seedDraft(userA, { title: 'original payload' })
    await runAsUser(userA, async (db) => submitDecision(db, revisionInput(submitted)))

    const tampered = { title: 'tampered payload' }
    const error = await captureRejection(userA, async (db) =>
      db.query(UPDATE_DRAFT_SQL, [submitted, JSON.stringify(tampered)]),
    )
    expect(error.sqlState).toBe('ST003')
    expect(error.kind).toBe('frozen_draft')

    // POSITIVE CONTROL — REQUIRED, not decorative (V31). The earlier version of
    // `app.guard_decision_transition()` put the `prospective = OLD.state` early return
    // ABOVE the frozen check, which made the check unreachable for exactly this case: a
    // payload edit moves no milestone, so it took the fast path and committed. A test
    // that only asserted ST003 above would also pass if the guard rejected EVERY draft
    // edit, which is the opposite failure. Only the pair pins both sides.
    const unsubmitted = await seedDraft(userA, { title: 'original payload' })
    await runAsUser(userA, async (db) => {
      await db.queryAffectingOne(UPDATE_DRAFT_SQL, [unsubmitted, JSON.stringify(tampered)])
    })
    const editable = await readDecision(userA, unsubmitted)
    expect(editable.draft_payload).toEqual(tampered)
    expect(editable.state).toBe('draft')

    // And the rejected attempt stored nothing.
    const frozen = await readDecision(userA, submitted)
    expect(frozen.draft_payload).toEqual({ title: 'original payload' })
    expect(frozen.state).toBe('submitted')
  })

  // 7 ----------------------------------------------------------------
  it('[FR-04] decision_revision is append-only: the app role is stopped by the absent grant (42501), and the trigger raises ST001 for the owner', async () => {
    const decisionId = await seedDraft(userA)
    const submitResult = await runAsUser(userA, async (db) =>
      submitDecision(db, revisionInput(decisionId)),
    )
    const revisionId = submitResult.revisionId

    // WHICH CODE, AND WHY. `statesman_app` is granted SELECT and INSERT on
    // decision_revision and nothing else, and Postgres checks privileges BEFORE a
    // BEFORE-ROW trigger can fire. So from this seat the observable code is 42501 from
    // the absent grant — NOT ST001. The trigger is never reached, which is precisely why
    // the owner leg below exists: without it, ST001 could have been dropped from the
    // schema and this test would still be green.
    const updateError = await captureRejection(userA, async (db) =>
      db.query(UPDATE_REVISION_SQL, [revisionId, 'tampered rationale']),
    )
    expect(updateError.sqlState).toBe('42501')
    expect(updateError.kind).toBe('permission_denied')

    const deleteError = await captureRejection(userA, async (db) =>
      db.query(DELETE_REVISION_SQL, [revisionId]),
    )
    expect(deleteError.sqlState).toBe('42501')
    expect(deleteError.kind).toBe('permission_denied')

    // POSITIVE CONTROL for reachability: the same role, the same row, through the one
    // verb it does hold. A SELECT returning the row rules out "the rejection was really
    // an invisible or nonexistent row" (V19).
    const stillThere = await readRevisions(userA, decisionId)
    expect(stillThere).toHaveLength(1)
    expect(stillThere[0]?.id).toBe(revisionId)
    expect(stillThere[0]?.rationale).toBe('fixture rationale')

    // SECOND LEG (V32): role-independent. As the schema owner, with FORCE bracketed off
    // inside a transaction that is rolled back either way, a candidate row reaches
    // app.forbid_mutation() and the DELETE raises ST001.
    const ownerCode = await captureOwnerSqlstate(OWNER_DELETE_REVISION_SQL, { rid: revisionId })
    expect(ownerCode).toBe('ST001')

    // The bracket must have closed. If FORCE were left off, every tenancy assertion in
    // this worker afterwards would be vacuous, so this is asserted from the catalog
    // rather than argued from the transaction semantics.
    const rlsRow = await ownerQuery(READ_REVISION_RLS_SQL)
    expect(parseBoolean(rlsRow[0]?.[0], 'decision_revision.relrowsecurity')).toBe(true)
    expect(parseBoolean(rlsRow[0]?.[1], 'decision_revision.relforcerowsecurity')).toBe(true)

    // And the rolled-back probe did not remove the row.
    expect(await readRevisions(userA, decisionId)).toHaveLength(1)
  })

  // 8 ----------------------------------------------------------------
  it('[FR-12] stamp_milestone walks challenged -> reflected -> action_recorded -> closed, each state asserted', async () => {
    // Drift guard: the TypeScript union and the state map below must agree with the four
    // literals the SQL function checks. An ST012 at runtime means they have diverged.
    expect([...MILESTONES]).toEqual(['challenged', 'reflected', 'action_recorded', 'closed'])

    const decisionId = await seedDraft(userA)
    await runAsUser(userA, async (db) => submitDecision(db, revisionInput(decisionId)))
    expect((await readDecision(userA, decisionId)).state).toBe('submitted')

    for (const milestone of MILESTONES) {
      await runAsUser(userA, async (db) => {
        await stampMilestone(db, { decisionId, milestone })
      })
      const after = await readDecision(userA, decisionId)
      expect(after.state).toBe(MILESTONE_STATE[milestone])
    }

    const final = await readDecision(userA, decisionId)
    expect(final.state).toBe('reviewed_closed')
    expect(final.closed_at).not.toBeNull()

    // FR-12: closing the decision did not retract the revision.
    expect(await readRevisions(userA, decisionId)).toHaveLength(1)
  })

  // 9 ----------------------------------------------------------------
  it('[FR-12] stamping closed on a draft raises ST002 and leaves the state where it was', async () => {
    const decisionId = await seedDraft(userA)
    expect((await readDecision(userA, decisionId)).state).toBe('draft')

    const error = await captureRejection(userA, async (db) => {
      await stampMilestone(db, { decisionId, milestone: 'closed' })
    })
    expect(error.sqlState).toBe('ST002')
    expect(error.kind).toBe('illegal_transition')

    // The after-state read is the half that a bare "it threw" assertion misses: a guard
    // that raised AFTER writing would look identical from the error alone.
    const after = await readDecision(userA, decisionId)
    expect(after.state).toBe('draft')
    expect(after.closed_at).toBeNull()
    expect(after.submitted_at).toBeNull()

    // POSITIVE CONTROL. The identical call, for a milestone that IS legal from the
    // current state, on a decision reached the same way: it succeeds. So the ST002 above
    // is the transition whitelist and not a dead `stamp_milestone`.
    const submitted = await seedDraft(userA)
    await runAsUser(userA, async (db) => submitDecision(db, revisionInput(submitted)))
    await runAsUser(userA, async (db) => {
      await stampMilestone(db, { decisionId: submitted, milestone: 'challenged' })
    })
    expect((await readDecision(userA, submitted)).state).toBe('challenged')
  })

  // 10 ---------------------------------------------------------------
  it('[FR-04][FR-12] append_revision adds revision 2 while revision 1 stays visible, and replays idempotently', async () => {
    const decisionId = await seedDraft(userA)
    const first = revisionInput(decisionId, { content: { attempt: 1 }, confidence: 40 })
    const submitted = await runAsUser(userA, async (db) => submitDecision(db, first))
    expect(submitted.revisionNo).toBe(1)

    const second = revisionInput(decisionId, {
      content: { attempt: 2, improved: true },
      confidence: 80,
      rationale: 'reassessed after learning',
    })
    const appended = await runAsUser(userA, async (db) => appendRevision(db, second))

    expect(appended.revisionNo).toBe(2)
    expect(appended.replayed).toBe(false)
    expect(appended.revisionId).not.toBe(submitted.revisionId)

    // FR-04 and FR-12 both require the earlier attempt to survive: an edit creates a NEW
    // revision, never a replacement.
    const revisions = await readRevisions(userA, decisionId)
    expect(revisions.map((r) => r.revision_no)).toEqual([1, 2])
    expect(revisions[0]?.id).toBe(submitted.revisionId)
    expect(revisions[0]?.content).toEqual({ attempt: 1 })
    expect(revisions[0]?.confidence).toBe(40)
    expect(revisions[1]?.id).toBe(appended.revisionId)
    expect(revisions[1]?.content).toEqual({ attempt: 2, improved: true })
    expect(revisions[1]?.confidence).toBe(80)

    // Idempotent on a replayed token, with different content, so a silent write would show.
    const replay = await runAsUser(userA, async (db) =>
      appendRevision(db, revisionInput(decisionId, {
        idempotencyToken: second.idempotencyToken,
        content: { attempt: 'must not be stored' },
      })),
    )
    expect(replay.replayed).toBe(true)
    expect(replay.revisionNo).toBe(2)
    expect(replay.revisionId).toBe(appended.revisionId)

    const afterReplay = await readRevisions(userA, decisionId)
    expect(afterReplay.map((r) => r.revision_no)).toEqual([1, 2])
    expect(afterReplay[1]?.content).toEqual({ attempt: 2, improved: true })

    // The decision's own state is unchanged by a correction.
    expect((await readDecision(userA, decisionId)).state).toBe('submitted')
  })

  // 11 ---------------------------------------------------------------
  it('[FR-05] the database rejects confidence -1 and 101 and a null forecast or rationale, and accepts 0 and 100', async () => {
    const rejected = await seedDraft(userA)

    // --- The DATABASE layer. These calls bypass the Zod wrapper on purpose; see
    // RAW_SUBMIT_SQL. Each failed attempt rolls its whole transaction back, so the same
    // draft can serve every rejection and is still a draft at the end.
    const outOfRange = [-1, 101]
    for (const confidence of outOfRange) {
      const error = await captureRejection(userA, async (db) =>
        db.query(RAW_SUBMIT_SQL, [
          rejected,
          randomUUID(),
          JSON.stringify({ probe: 'confidence' }),
          confidence,
          'forecast',
          '30 days',
          'rationale',
        ]),
      )
      // 23514 check_violation, from `check (confidence between 0 and 100)` on the column.
      expect(error.sqlState).toBe('23514')
    }

    for (const nulled of ['forecast', 'rationale'] as const) {
      const error = await captureRejection(userA, async (db) =>
        db.query(RAW_SUBMIT_SQL, [
          rejected,
          randomUUID(),
          JSON.stringify({ probe: nulled }),
          50,
          nulled === 'forecast' ? null : 'forecast',
          '30 days',
          nulled === 'rationale' ? null : 'rationale',
        ]),
      )
      // 23502 not_null_violation, from `text not null` on the column.
      expect(error.sqlState).toBe('23502')
    }

    // Nothing partial survived any of the four rejections.
    expect(await readRevisions(userA, rejected)).toHaveLength(0)
    expect((await readDecision(userA, rejected)).state).toBe('draft')

    // --- POSITIVE CONTROLS for the boundary values. Same raw call, same shape, only the
    // confidence differs: 0 and 100 are legal and must be stored, or the check above
    // would be satisfied by a constraint that rejects everything.
    for (const confidence of [0, 100]) {
      const decisionId = await seedDraft(userA)
      const accepted = await runAsUser(userA, async (db) =>
        db.queryOne<{ revision_no: number; replayed: boolean }>(RAW_SUBMIT_SQL, [
          decisionId,
          randomUUID(),
          JSON.stringify({ probe: 'boundary' }),
          confidence,
          'forecast',
          '30 days',
          'rationale',
        ]),
      )
      expect(accepted.revision_no).toBe(1)
      expect(accepted.replayed).toBe(false)
      const stored = await readRevisions(userA, decisionId)
      expect(stored).toHaveLength(1)
      expect(stored[0]?.confidence).toBe(confidence)
    }

    // --- And the TypeScript boundary rejects the same value one layer earlier, so the
    // out-of-range call cannot reach the database from the production wrapper at all.
    const wrapperDraft = await seedDraft(userA)
    await expect(
      runAsUser(userA, async (db) =>
        submitDecision(db, revisionInput(wrapperDraft, { confidence: -1 })),
      ),
    ).rejects.toThrow()
    expect(await readRevisions(userA, wrapperDraft)).toHaveLength(0)
  })

  // 12 ---------------------------------------------------------------
  it('[FR-04] stamp_milestone on another user\'s decision raises ST005 instead of silently affecting zero rows', async () => {
    const victim = await seedDraft(userA, { title: "user A's decision" })
    await runAsUser(userA, async (db) => submitDecision(db, revisionInput(victim)))
    expect((await readDecision(userA, victim)).state).toBe('submitted')

    // B aims the definer function at A's decision. The function derives `me` from
    // app.require_user_id(), so its UPDATE matches no row — and the `get diagnostics`
    // assertion turns that silence into ST005 (V7). Note the SQLSTATE assertion: the
    // client-side queryOne guard raises the SAME RowCountError class with NO sqlState,
    // so `kind === 'row_count'` alone would still pass if the database check were gone.
    const error = await captureRejection(userB, async (db) => {
      await stampMilestone(db, { decisionId: victim, milestone: 'challenged' })
    })
    expect(error.sqlState).toBe('ST005')
    expect(error.kind).toBe('row_count')

    // POSITIVE CONTROL. The same call, by the same user B, in the same state, against a
    // decision B owns: it succeeds. So the ST005 above is ownership and not a broken
    // stamper, a missing EXECUTE grant or an unreachable row for user B generally.
    const own = await seedDraft(userB, { title: "user B's decision" })
    await runAsUser(userB, async (db) => submitDecision(db, revisionInput(own)))
    await runAsUser(userB, async (db) => {
      await stampMilestone(db, { decisionId: own, milestone: 'challenged' })
    })
    expect((await readDecision(userB, own)).state).toBe('challenged')

    // AFTER-STATE on the victim, read as its rightful owner: the refused stamp moved
    // nothing. A cross-user write that affected 0 rows is byte-identical to one that was
    // denied (V19), so the only evidence is the row itself.
    const victimAfter = await readDecision(userA, victim)
    expect(victimAfter.state).toBe('submitted')
    expect(victimAfter.challenged_at).toBeNull()
  })
})
