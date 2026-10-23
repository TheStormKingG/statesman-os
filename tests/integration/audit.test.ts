/**
 * audit_event: append-only, actor-and-subject, and free of journal text.
 *                                                       [NFR-03] [FR-16] [FR-04]
 *
 * Implementation plan task 3.7.
 *
 * ── THE THREE CLAIMS, AND WHY EACH NEEDS ITS OWN LEG ────────────────────────
 *
 *   APPEND-ONLY is two mechanisms, not one. `authenticated` holds SELECT and
 *   nothing else, so a client is stopped by the ABSENT GRANT (42501) and never
 *   reaches a trigger. The triggers exist for the OWNER, which grants do not
 *   bind — V32 recorded that `dr_no_update` raises ST001 for the table owner
 *   too, and that is what makes "append-only" true of migrations and definer
 *   functions rather than only of clients. Testing one would leave the other
 *   free to be deleted.
 *
 *   TRUNCATE is a third mechanism. It bypasses row-level triggers entirely
 *   (V15), so a `BEFORE TRUNCATE ... FOR EACH STATEMENT` trigger is the only
 *   thing that catches it, and a test that checked UPDATE and DELETE alone
 *   would pass against a table anyone could empty in one statement.
 *
 *   NO JOURNAL TEXT cannot be proven by reading the functions, because the
 *   point is to catch the function that stops being careful. So the leg below
 *   submits a decision whose rationale is a string nothing else could contain,
 *   then reads EVERY audit row as the owner — not as the user, whose policy
 *   would hide rows and turn a leak into an empty result.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { submitDecision, stampMilestone } from '../support/scoped-pg'
import { StatesmanError } from '../support/scoped-pg'
import { ensureWorkerDatabase, ownerQuery, releaseProductionPools, runAsUser } from './support/db'
import { freshScenarioVersion } from './support/scenario-fixtures'

const PERMISSION_DENIED = '42501'
const APPEND_ONLY = 'ST001'

/** A string that cannot occur by accident anywhere else in the database. */
const SECRET_RATIONALE = `rationale-canary-${randomUUID()}-do-not-log`

const INSERT_DECISION =
  'insert into public.decision (id, user_id, draft_payload, scenario_version_id) ' +
  'values ($1::uuid, $2::uuid, $3::jsonb, $4::uuid)'

async function seedUser(): Promise<string> {
  const id = randomUUID()
  await ownerQuery(
    'insert into auth.users (id, email, created_at, updated_at) ' +
      "values (:'id', :'email', now(), now()) on conflict (id) do nothing; " +
      'insert into public.profile (user_id, display_name) ' +
      "values (:'id', :'email') on conflict (user_id) do nothing;",
    { id, email: `audit+${id}@statesman.invalid` },
  )
  return id
}

async function rejectionOf(fn: () => Promise<unknown>): Promise<StatesmanError> {
  try {
    await fn()
  } catch (error: unknown) {
    if (error instanceof StatesmanError) return error
    throw error
  }
  throw new Error('the call under test SUCCEEDED; an append-only guard was not exercised')
}

let user = ''
let decisionId = ''

describe('[NFR-03] audit_event', () => {
  beforeAll(async () => {
    await ensureWorkerDatabase()
    user = await seedUser()
    decisionId = randomUUID()
    const theCase = await freshScenarioVersion('audit')
    await runAsUser(user, (db) =>
      db.queryAffectingOne(INSERT_DECISION, [decisionId, db.userId, '{}', theCase]),
    )
    await runAsUser(user, (db) =>
      submitDecision(db, {
        decisionId,
        idempotencyToken: randomUUID(),
        content: { fixture: 'audit' },
        confidence: 70,
        forecast: 'audit fixture forecast',
        horizon: 'audit fixture horizon',
        rationale: SECRET_RATIONALE,
      }),
    )
  }, 120_000)

  afterAll(async () => {
    await releaseProductionPools()
  })

  it('[NFR-03] a submission writes one event carrying the subject AND a non-null actor', async () => {
    const rows = await runAsUser(user, (db) =>
      db.query<{ action: string; user_id: string; actor_user_id: string | null; detail: string }>(
        'select action, user_id::text, actor_user_id::text, detail::text ' +
          'from public.audit_event where decision_id = $1::uuid order by occurred_at',
        [decisionId],
      ),
    )
    expect(rows.rows).toHaveLength(1)
    const row = rows.rows[0]
    expect(row?.action).toBe('submission')
    expect(row?.user_id, 'the SUBJECT must be the journal owner').toBe(user)
    expect(
      row?.actor_user_id,
      'actor_user_id is null, so the row records that something happened but not that a ' +
        'person did it — which is the half of NFR-03 a created_at column cannot supply',
    ).toBe(user)
    // Ids and a number only.
    expect(row?.detail).toContain('revision_no')
    expect(row?.detail).toContain('revision_id')
  })

  it('[NFR-03] a milestone writes its own event, and a REPLAY writes none', async () => {
    const before = await countEvents()
    await runAsUser(user, (db) =>
      stampMilestone(db, { decisionId, milestone: 'challenged' }),
    )
    expect(await countEvents(), 'the milestone did not record an event').toBe(before + 1)

    // A replayed submission is the SAME event, already recorded. A second row would turn
    // "submitted once" into a history of two submissions.
    const token = randomUUID()
    const second = randomUUID()
    const otherCase = await freshScenarioVersion('audit-replay')
    await runAsUser(user, (db) =>
      db.queryAffectingOne(INSERT_DECISION, [second, db.userId, '{}', otherCase]),
    )
    const input = {
      decisionId: second,
      idempotencyToken: token,
      content: { fixture: 'replay' },
      confidence: 50,
      forecast: 'f',
      horizon: 'h',
      rationale: 'r',
    }
    await runAsUser(user, (db) => submitDecision(db, input))
    const afterFirst = await countEvents()
    const replay = await runAsUser(user, (db) => submitDecision(db, input))
    expect(replay.replayed, 'the second call was not treated as a replay').toBe(true)
    expect(await countEvents(), 'a replay wrote a second audit row').toBe(afterFirst)
  })

  it('[NFR-03] no audit row contains any part of the decision rationale', async () => {
    // Read as the OWNER, not as the user: a tenancy policy would hide rows and turn a
    // leak in someone else's row into an empty result.
    const rows = await ownerQuery(
      "select 'audit', coalesce(string_agg(a.detail::text || ' ' || a.action, ' '), '') " +
        'from public.audit_event a;',
    )
    const blob = rows.find((r) => r[0] === 'audit')?.[1] ?? ''
    expect(blob.length, 'the audit table was empty, so this proves nothing').toBeGreaterThan(0)
    expect(
      blob,
      'an audit row contains the decision rationale. CLAUDE.md §6 forbids logging journal ' +
        'content, and the audit table is the easiest place to break that by accident.',
    ).not.toContain(SECRET_RATIONALE)
    // The canary really is in the database, so the assertion above had something to find.
    // Scoped by owner as well as by the canary text. A whole-table count on an
    // RLS-protected table is a claim about every other test's rows too, which is what
    // tests/unit/no-unscoped-counts.test.ts refuses — and it refused this line, correctly.
    const check = await ownerQuery(
      "select 'rev', count(*)::text from public.decision_revision " +
        "where rationale = :'r' and user_id = :'u';",
      { r: SECRET_RATIONALE, u: user },
    )
    expect(
      check.find((r) => r[0] === 'rev')?.[1],
      'the canary rationale is not in decision_revision, so the leak test was vacuous',
    ).toBe('1')
  })

  it('[FR-16] the app role is stopped by the ABSENT GRANT, and the owner by the TRIGGER', async () => {
    const id = await anyEventId()

    // Leg 1: the client. No UPDATE or DELETE grant exists, so it never reaches a trigger.
    const u = await rejectionOf(() =>
      runAsUser(user, (db) =>
        db.query('update public.audit_event set action = $2 where id = $1::uuid', [
          id,
          'milestone',
        ]),
      ),
    )
    expect(u.sqlState, u.message).toBe(PERMISSION_DENIED)
    const d = await rejectionOf(() =>
      runAsUser(user, (db) =>
        db.query('delete from public.audit_event where id = $1::uuid', [id]),
      ),
    )
    expect(d.sqlState, d.message).toBe(PERMISSION_DENIED)

    // Leg 2: the owner, which grants do not bind. Each statement is probed separately
    // inside its own rolled-back transaction so one failure cannot mask another.
    for (const [label, sql] of [
      ['update', `update public.audit_event set action = 'milestone' where id = '${id}'`],
      ['delete', `delete from public.audit_event where id = '${id}'`],
      ['truncate', 'truncate public.audit_event'],
    ] as const) {
      // `begin; … rollback;` is NOT hygiene here, it is the only reason the probe can be
      // read back. `set_config(…, true)` is the LOCAL form, and ownerQuery runs psql in
      // autocommit, so without an explicit transaction the DO block commits and the
      // following SELECT runs in a new one where the setting is already gone — which is
      // how both legs of this test first returned an empty string instead of a SQLSTATE.
      // The rollback also means the probe cannot actually delete anyone's history.
      const probe = await ownerQuery(
        `begin;
         do $p$ begin
           ${sql};
           perform set_config('probe.state', '00000', true);
         exception when others then
           perform set_config('probe.state', sqlstate, true);
         end $p$;
         select 'probe', coalesce(current_setting('probe.state', true), '<unset>');
         rollback;`,
      )
      expect(
        probe.find((r) => r[0] === 'probe')?.[1],
        `${label} by the OWNER was not refused. Absent grants do not bind the owner, so ` +
          'the trigger is the only thing standing between a migration and a rewritten history.',
      ).toBe(APPEND_ONLY)
    }
  })

  it('[NFR-03] no UPDATE or DELETE policy exists on audit_event', async () => {
    // A permissive UPDATE policy would not by itself grant anything, but its presence
    // would mean someone intended the table to be mutable and the next grant would open it.
    const rows = await ownerQuery(
      "select 'pol', polname, polcmd::text from pg_policy " +
        "where polrelid = 'public.audit_event'::regclass order by polname;",
    )
    const policies = rows.filter((r) => r[0] === 'pol')
    expect(policies.length, 'audit_event has no policy at all, so FORCE RLS denies everything').toBeGreaterThan(0)
    for (const p of policies) {
      expect(
        p[2],
        `policy ${String(p[1])} covers ${String(p[2])}; only ALL or SELECT is acceptable ` +
          'on an append-only table written solely by definer functions',
      ).toMatch(/^[*r]$/)
    }
  })

  it('[NFR-03] detail rejects any key outside the allowed set', async () => {
    // The structural half of "no journal text": a future function that stuffed prose under
    // a new key fails to INSERT rather than being caught in review.
    // Same transaction requirement as the leg above, and here the rollback also restores
    // FORCE if the DO block raises before reaching the closing ALTER.
    const probe = await ownerQuery(
      `begin;
       alter table public.audit_event no force row level security;
       do $p$ begin
         insert into public.audit_event (user_id, decision_id, action, detail)
         values ('${user}', '${decisionId}', 'submission', jsonb_build_object('text', 'leak'));
         perform set_config('probe.state', '00000', true);
       exception when others then
         perform set_config('probe.state', sqlstate, true);
       end $p$;
       select 'probe', coalesce(current_setting('probe.state', true), '<unset>');
       rollback;`,
    )
    expect(
      probe.find((r) => r[0] === 'probe')?.[1],
      'a row carrying an unexpected detail key was accepted, so the constraint is not ' +
        'what keeps journal text out of the audit table',
    ).toBe('23514')
  })
})

async function countEvents(): Promise<number> {
  const rows = await ownerQuery("select 'n', count(*)::text from public.audit_event;")
  return Number.parseInt(rows.find((r) => r[0] === 'n')?.[1] ?? '-1', 10)
}

async function anyEventId(): Promise<string> {
  const rows = await ownerQuery(
    "select 'id', id::text from public.audit_event where user_id <> " +
      "'00000000-0000-0000-0000-00000000dead' limit 1;",
  )
  const id = rows.find((r) => r[0] === 'id')?.[1]
  if (id === undefined) throw new Error('no audit event to probe')
  return id
}
