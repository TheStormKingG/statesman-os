import { ownerQuery } from './db'

/**
 * The scenario versions the integration fixtures seed decisions against.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * `20261022170000` added `decision.scenario_version_id NOT NULL`, so every
 * fixture that creates a decision now has to say which case it answers. There
 * are eight such sites across the suite. Eight copies of a literal uuid is
 * eight places to edit when the seed changes and eight chances for one of them
 * to end up pointing at the sentinel case by accident — which would still pass,
 * because the FK only cares that the row exists.
 *
 * So the ids live here once, named, with what they are.
 */

/**
 * `DEMO-PH-001` version 1, seeded and PUBLISHED by `20261021140800`.
 *
 * This is the right default for a fixture: it is the case a real user would be
 * answering, it is published, and it carries a rubric. A fixture seeded against
 * the sentinel version would be exercising a row that exists only so that
 * "0 rows" can be distinguished from "denied" (V18).
 */
export const SEEDED_SCENARIO_VERSION_ID = '00000000-0000-0000-0000-000000090003'

/**
 * The rule-9b sentinel scenario version, seeded by `20261021140600`. Unpublished
 * by design.
 *
 * Exported so a test that needs a SECOND open draft for the SAME user has a
 * second case to put it against: `decision_one_open_draft_per_scenario` is
 * unique on `(user_id, scenario_version_id) where submitted_at is null`, so two
 * open drafts for one user are only legal across two different cases. That is
 * the product rule, not an obstacle to work around.
 */
export const SENTINEL_SCENARIO_VERSION_ID = '00000000-0000-0000-0000-000000080003'

/**
 * Create a fresh, UNPUBLISHED scenario version and return its id.
 *
 * ── WHY A FIXTURE NEEDS THIS AT ALL ─────────────────────────────────────────
 *
 * `20261022170000` added
 *
 *   create unique index decision_one_open_draft_per_scenario
 *     on public.decision (user_id, scenario_version_id) where submitted_at is null
 *
 * which is plan task 3.1's product rule: one open draft per user per case. Before
 * it existed, fixtures freely gave one user several open drafts against the same
 * case, and 32 assertions across six files depended on being able to. They were
 * not testing that; they just needed "another draft". The index made the shortcut
 * illegal, which is the index working — a user who could hold two open drafts for
 * one case has no answer to FR-03's "reopen the draft without loss", because
 * there would be two.
 *
 * So a fixture that wants a second open draft for the same user asks for another
 * CASE, which is legal and realistic.
 *
 * ── WHY THE FORCE-RLS BRACKET, AND WHY IT IS INSIDE THE TRANSACTION ─────────
 *
 * `public.scenario_version` is `force row level security` with a SELECT-only
 * policy, so even its owner cannot INSERT while FORCE is on: there is no
 * permissive policy for the write and the `with check` fails. Canon §4.3's
 * `no force` / `force` bracket is the sanctioned way through.
 *
 * The bracket sits INSIDE `begin`/`commit` deliberately. ALTER TABLE is
 * transactional in PostgreSQL, so if the insert raises, the rollback restores
 * FORCE as well. A bracket opened outside a transaction would leave the table
 * unprotected in this worker's database on any failure, and a test harness that
 * can silently disable RLS is worse than one that cannot insert.
 */
export async function freshScenarioVersion(label = 'fixture'): Promise<string> {
  const rows = await ownerQuery(
    `begin;
     alter table public.scenario_version no force row level security;
     insert into public.scenario_version
       (scenario_id, version_no, content, is_fiction, as_of_date)
     values ((select scenario_id from public.scenario_version
               where id = '${SEEDED_SCENARIO_VERSION_ID}'),
             -- A RESERVED RANGE, not max+1. scenario_version_no_uq is unique on
             -- (scenario_id, version_no), and scenario-content.test.ts publishes a
             -- SECOND version of the seeded scenario as version_no 2. A global max+1
             -- would take 2 first and that test would then fail with 23505 on a
             -- constraint it is not testing. Fixtures therefore live at 1000 and above,
             -- where nothing authored by a migration or by another test reaches.
             (select greatest(1000, coalesce(max(version_no), 0) + 1)
                from public.scenario_version),
             jsonb_build_object('fixture', $$${label}$$), true, '2026-03-06')
     returning 'svid', id::text;
     alter table public.scenario_version force row level security;
     commit;`,
  )
  const row = rows.find((r) => r[0] === 'svid')
  const id = row?.[1]
  if (id === undefined || id.length === 0) {
    throw new Error(
      `freshScenarioVersion(${label}): the insert returned no labelled row. A fixture that ` +
        'cannot create a case must fail loudly rather than fall back to a shared one, which ' +
        'would reintroduce the open-draft collision this helper exists to avoid.',
    )
  }
  return id
}
