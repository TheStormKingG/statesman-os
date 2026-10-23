/**
 * The scenario linkage added by `20261022170000`.      [FR-02] [FR-04] [FR-12]
 *
 * Implementation plan tasks 3.1 and 3.3, which Slice 1 did not implement and
 * which nothing noticed because there were no screens: no code path ever needed
 * to get from a case to a draft or back.
 *
 * ── THE TWO PROPERTIES, AND WHY THEY ARE NOT INTERCHANGEABLE ────────────────
 *
 *   dr_scenario_fk   a revision cannot be grounded in a different case than the
 *                    decision it answers. This is ADR-0008's grounding rule: a
 *                    citation is valid because the key PINS the claim and the
 *                    thing citing it to one `scenario_version_id`, not because
 *                    something checked at write time. M16 proves the analogous
 *                    hole is closed for `scenario_claim`; leaving it open one
 *                    table over would make that mutation a demonstration about
 *                    nothing.
 *
 *   decision_one_open_draft_per_scenario
 *                    one open draft per user per case. FR-03's "incomplete
 *                    drafts may be reopened without loss" presumes there is ONE
 *                    draft to reopen; two would make "the draft" undefined and
 *                    the Desk would have to guess.
 *
 * ── EVERY LEG HAS ITS POSITIVE CONTROL IN THE SAME TEST ─────────────────────
 *
 * A constraint that rejected EVERYTHING would satisfy the refusal halves below
 * and break the product completely. So each refusal is asserted beside the
 * nearest legal write that must still succeed, and the SQLSTATE and constraint
 * name are both asserted: "an error was raised" is satisfied by a typo.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { submitDecision } from '../support/scoped-pg'
import { StatesmanError } from '../support/scoped-pg'
import { ensureWorkerDatabase, ownerQuery, releaseProductionPools, runAsUser } from './support/db'
import { freshScenarioVersion } from './support/scenario-fixtures'

const FOREIGN_KEY_VIOLATION = '23503'
const UNIQUE_VIOLATION = '23505'
const SCENARIO_FK = 'dr_scenario_fk'
const OPEN_DRAFT_INDEX = 'decision_one_open_draft_per_scenario'

const INSERT_DECISION =
  'insert into public.decision (id, user_id, draft_payload, scenario_version_id) ' +
  'values ($1::uuid, $2::uuid, $3::jsonb, $4::uuid)'

const INSERT_REVISION =
  'insert into public.decision_revision ' +
  '  (decision_id, user_id, scenario_version_id, revision_no, content, confidence, ' +
  '   forecast, horizon, rationale, idempotency_token) ' +
  'values ($1::uuid, $2::uuid, $3::uuid, $4::int, $5::jsonb, 50, ' +
  "        'fixture forecast', 'fixture horizon', 'fixture rationale', $6::uuid)"

async function seedUser(): Promise<string> {
  const id = randomUUID()
  await ownerQuery(
    'insert into auth.users (id, email, created_at, updated_at) ' +
      "values (:'id', :'email', now(), now()) on conflict (id) do nothing; " +
      'insert into public.profile (user_id, display_name) ' +
      "values (:'id', :'email') on conflict (user_id) do nothing;",
    { id, email: `linkage+${id}@statesman.invalid` },
  )
  return id
}

/*
 * There is deliberately no local `runAsUser` here. `withUser` takes NO session argument
 * (ADR-0006): an identity arriving as a parameter type-checks perfectly when handed a
 * victim's id, and RLS then faithfully enforces the attacker's choice. The harness's
 * `runAsUser` enters the same ambient identity context the real authentication path would.
 */

async function rejectionOf(fn: () => Promise<unknown>): Promise<StatesmanError> {
  try {
    await fn()
  } catch (error: unknown) {
    if (error instanceof StatesmanError) return error
    throw error
  }
  throw new Error(
    'the call under test SUCCEEDED. A constraint test whose write is accepted has not ' +
      'demonstrated the constraint, and reporting it as a pass would be the exact failure ' +
      'ADR-0009 exists to prevent.',
  )
}

describe('[FR-02][FR-04] a decision and its revisions are pinned to one scenario version', () => {
  beforeAll(async () => {
    await ensureWorkerDatabase()
  }, 120_000)

  afterAll(async () => {
    await releaseProductionPools()
  })

  it('[FR-04] dr_scenario_fk refuses a revision grounded in a different case, and accepts the matching one', async () => {
    const user = await seedUser()
    const ownCase = await freshScenarioVersion('linkage-own')
    const otherCase = await freshScenarioVersion('linkage-other')
    const decisionId = randomUUID()

    await runAsUser(user, (db) =>
      db.queryAffectingOne(INSERT_DECISION, [
        decisionId,
        db.userId,
        JSON.stringify({ fixture: 'linkage' }),
        ownCase,
      ]),
    )

    // THE REFUSAL. Same parent, same owner, same everything — only the case is
    // another one, which is precisely the cross-grounding ADR-0008 forbids.
    const rejection = await rejectionOf(() =>
      runAsUser(user, (db) =>
        db.query(INSERT_REVISION, [
          decisionId,
          db.userId,
          otherCase,
          1,
          JSON.stringify({ leg: 'cross-case' }),
          randomUUID(),
        ]),
      ),
    )
    expect(rejection.sqlState, rejection.message).toBe(FOREIGN_KEY_VIOLATION)
    expect(
      rejection.constraintName,
      'the rejection did not name dr_scenario_fk, so this is not evidence that the ' +
        'composite grounding key is what refused the row',
    ).toBe(SCENARIO_FK)

    // THE POSITIVE CONTROL, in the same test: the identical statement with the
    // parent's own case must be accepted. Without it, a constraint that rejected
    // every revision would pass the assertion above.
    await runAsUser(user, (db) =>
      db.queryAffectingOne(INSERT_REVISION, [
        decisionId,
        db.userId,
        ownCase,
        1,
        JSON.stringify({ leg: 'matching' }),
        randomUUID(),
      ]),
    )
  })

  it('[FR-03] one open draft per user per case: a second is refused, another case is allowed', async () => {
    const user = await seedUser()
    const caseOne = await freshScenarioVersion('linkage-draft-1')
    const caseTwo = await freshScenarioVersion('linkage-draft-2')

    await runAsUser(user, (db) =>
      db.queryAffectingOne(INSERT_DECISION, [randomUUID(), db.userId, '{}', caseOne]),
    )

    const rejection = await rejectionOf(() =>
      runAsUser(user, (db) =>
        db.query(INSERT_DECISION, [randomUUID(), db.userId, '{}', caseOne]),
      ),
    )
    expect(rejection.sqlState, rejection.message).toBe(UNIQUE_VIOLATION)
    expect(rejection.message).toContain(OPEN_DRAFT_INDEX)

    // POSITIVE CONTROL: a different case is a different draft, which is the
    // product rule rather than a loophole.
    await runAsUser(user, (db) =>
      db.queryAffectingOne(INSERT_DECISION, [randomUUID(), db.userId, '{}', caseTwo]),
    )
  })

  it('[FR-03][FR-04] the index is PARTIAL, so a new draft is allowed once the first is submitted', async () => {
    const user = await seedUser()
    const theCase = await freshScenarioVersion('linkage-partial')
    const firstId = randomUUID()

    await runAsUser(user, (db) =>
      db.queryAffectingOne(INSERT_DECISION, [firstId, db.userId, '{}', theCase]),
    )
    await runAsUser(user, (db) =>
      submitDecision(db, {
        decisionId: firstId,
        idempotencyToken: randomUUID(),
        content: { fixture: 'partial-index' },
        confidence: 50,
        forecast: 'fixture forecast',
        horizon: 'fixture horizon',
        rationale: 'fixture rationale',
      }),
    )

    // `where submitted_at is null` is the definition of open, so the submitted
    // decision no longer occupies the slot. FR-04 requires the earlier record to
    // survive a second attempt at the same case, which this is what permits.
    await runAsUser(user, (db) =>
      db.queryAffectingOne(INSERT_DECISION, [randomUUID(), db.userId, '{}', theCase]),
    )
  })

  it('[FR-02][FR-12] submit_decision PINS the parent case, derived rather than passed', async () => {
    const user = await seedUser()
    const theCase = await freshScenarioVersion('linkage-derived')
    const decisionId = randomUUID()

    await runAsUser(user, (db) =>
      db.queryAffectingOne(INSERT_DECISION, [decisionId, db.userId, '{}', theCase]),
    )
    const result = await runAsUser(user, (db) =>
      submitDecision(db, {
        decisionId,
        idempotencyToken: randomUUID(),
        content: { fixture: 'derived' },
        confidence: 60,
        forecast: 'fixture forecast',
        horizon: 'fixture horizon',
        rationale: 'fixture rationale',
      }),
    )

    // The function takes NO scenario parameter. It reads the value from the
    // `decision` row it already locks, which is canon §4.6's identity rule
    // applied to grounding: a `p_scenario_version_id` argument would type-check
    // perfectly while naming a different case, and the composite FK would then
    // faithfully pin the revision to the caller's choice.
    const rows = await runAsUser(user, (db) =>
      db.query<{ scenario_version_id: string }>(
        'select scenario_version_id from public.decision_revision where id = $1::uuid',
        [result.revisionId],
      ),
    )
    expect(rows.rows).toHaveLength(1)
    expect(
      rows.rows[0]?.scenario_version_id,
      'the revision was not pinned to its parent case, so the scenario is not being ' +
        'derived from the locked row',
    ).toBe(theCase)
  })
})
