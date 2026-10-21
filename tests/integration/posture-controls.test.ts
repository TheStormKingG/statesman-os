/**
 * Posture controls for the rules that had none.   [NFR-01] [NFR-02]
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * `posture.test.ts` controls rules 1, 2, 4, 5, 6 and 8 of canon §4.8. An
 * adversarial pass then mutated the remaining rules one at a time and re-ran
 * the suite:
 *
 *   M5  rule 3 OWNERSHIP made unmatchable
 *       (`pg_get_userbyid(c.relowner) = '__never_a_role__'`)      -> 44/44 green
 *   M6  rule 7 NO TRUNCATE made unreachable (`if false then`)     -> 44/44 green
 *   M8  rules 9 SENTINELS and 10 NOT NULL were not implemented at all, and
 *       nothing asserted their presence.
 *
 * A guard whose removal leaves the suite green is not protecting anything the
 * suite can see. This file is the missing half: rules 3, 7, 9 and 10 each get a
 * control that introduces the violation the rule exists to catch, inside a
 * transaction that is rolled back, and asserts ST099 **naming that rule's own
 * text** — never merely "it raised", which is satisfied by a checker whose body
 * is `raise exception ... using errcode = 'ST099'`. The clean schema, probed
 * through the same helper before and after, is what excludes that.
 *
 * Rules 9 and 10 are implemented in `migrations/0005_verify_security_posture.sql`
 * (inline, as rules 9 and 10 of the same function — see that file's header for
 * why they are not a separate migration).
 *
 * ---------------------------------------------------------------------------
 * THE HELPER IS A SECOND COPY, DELIBERATELY, AND IT IS NOT THE SAME HELPER
 * ---------------------------------------------------------------------------
 * `posture.test.ts` does not export its `probePosture`, and it belongs to
 * another agent's file. More to the point, it could not have served rule 3
 * unchanged: `probePosture` connects as `statesman_migrator` and `SET ROLE`s to
 * `statesman_owner`, and MEASURED on this cluster
 *
 *     set role statesman_owner;
 *     alter table public.pc_probe_owner owner to statesman_app;
 *     ERROR:  42501: must be able to SET ROLE "statesman_app"
 *
 * `ALTER TABLE … OWNER TO` requires membership in the *target* role, and
 * `statesman_owner` is deliberately not a member of `statesman_app` — that
 * asymmetry is part of the posture being tested, and granting the membership
 * would be a cluster-level change outside any transaction. So the rule 3
 * control runs through `probeAsAdmin`, as the bootstrap superuser, inside one
 * rolled-back transaction. Everything else runs through `probeAsOwner`, which
 * is the role the migration path itself uses.
 *
 * One consequence is recorded rather than hidden: as a superuser, RLS is
 * bypassed entirely, so rule 9's row counts under `probeAsAdmin` do not
 * exercise the identity-context swap that rule 9 needs under the owner. That is
 * why the rule 9 controls below use `probeAsOwner` — the same role, and the same
 * RLS exposure, as `scripts/migrate.sh`.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  ensureWorkerDatabase,
  harnessEnv,
  migratorRole,
  ownerQuery,
  queryRows,
  workerDatabaseName,
} from './support/db'
import { SENTINEL_USER_ID } from './support/sentinels'

/** What the function did, as data rather than as a thrown error. */
interface PostureProbe {
  readonly sqlstate: string
  readonly message: string
}

/** plpgsql's `successful_completion`. */
const CLEAN = '00000'
const POSTURE_FAILED = 'ST099'

/**
 * Every rule's own message fragment, so each control can assert both what IS
 * reported and what is NOT.
 *
 * The `absent` half is what makes a control attributable. Several violations
 * trip more than one rule — an ungranted table with no RLS trips rule 2, a
 * GRANTed one trips 1 AND 2 — and a control that only checks its own fragment
 * would pass just as happily on a checker where some unrelated rule did all the
 * work. Each control below therefore asserts the absence of EVERY other rule's
 * fragment, which was verified by running the six setups and reading the full
 * messages back: each produced exactly one rule's text.
 */
const FRAGMENT = {
  rule1: 'reachable without forced RLS + policy',
  rule2: 'not forced-RLS and not exempt',
  rule3: 'owned by statesman_app',
  rule4: 'EXECUTE granted to PUBLIC',
  rule5: 'view without security_invoker',
  rule6: 'is not STABLE',
  rule7: 'holds TRUNCATE on',
  rule8: 'policy not scoped by require_user_id()',
  rule9: 'sentinel rows in',
  rule9NoColumn: 'protected table has no user_id column',
  /**
   * Rule 9 failing to EVALUATE rather than measuring a wrong count. This is the
   * most important `absent` entry in the file: rule 9 has to set the identity
   * context to read the rows at all (the owner is subject to FORCE, and a
   * context-free count raises 28000, not 0), so a rule 9 that reported this
   * string would be a broken instrument reporting a violation it never measured.
   */
  rule9Broken: 'sentinel rule could not be evaluated',
  rule10: 'user_id column is nullable',
} as const

const ALL_FRAGMENTS: readonly string[] = Object.values(FRAGMENT)

/** The posture call, wrapped so the SQLSTATE and message come back as a ROW. */
const PROBE_SCRIPT = `do $posture$ begin
  perform app.verify_security_posture();
  perform set_config('probe.sqlstate', '00000', true);
  perform set_config('probe.message', '', true);
exception when others then
  perform set_config('probe.sqlstate', sqlstate, true);
  perform set_config('probe.message',
                     replace(replace(SQLERRM, E'\\n', ' '), '|', '/'), true);
end $posture$;
select 'probe',
       coalesce(current_setting('probe.sqlstate', true), '<unset>'),
       coalesce(current_setting('probe.message',  true), '<unset>');`

/**
 * Letting the exception escape would abort the psql script before the explicit
 * `rollback`, leaving teardown to the connection closing. Reading the message
 * also matters: a checker that raises ST099 for the wrong reason has not been
 * shown to catch anything. The `do` block's EXCEPTION clause rolls back to its
 * own implicit savepoint before the handler runs, so the two `set_config` calls
 * in the handler survive to be read by the following SELECT.
 *
 * Newlines and pipes are stripped from SQLERRM because psql runs with
 * `-A -t -F '|'`: either character would parse as extra rows or columns.
 */
function readProbe(rows: readonly string[][]): PostureProbe {
  const row = rows.find((r) => r[0] === 'probe')
  const sqlstate = row?.[1]
  if (row === undefined || sqlstate === undefined) {
    throw new Error('the posture probe returned no labelled row — the script did not reach its SELECT')
  }
  return { sqlstate, message: row[2] ?? '' }
}

/**
 * Run the posture check after `setupSql`, as `statesman_owner` (via the
 * migrator, which is a member of it — the owner itself is NOLOGIN), inside a
 * rolled-back transaction. The function has no EXECUTE grant to anyone else;
 * rule 4 forbids PUBLIC.
 */
async function probeAsOwner(setupSql: string): Promise<PostureProbe> {
  return readProbe(await ownerQuery(`begin;\n${setupSql}\n${PROBE_SCRIPT}\nrollback;`))
}

/**
 * The same, as the bootstrap superuser. Needed only where the setup itself is
 * impossible for the owner — see this file's header for the measured error.
 */
async function probeAsAdmin(setupSql: string): Promise<PostureProbe> {
  await ensureWorkerDatabase()
  return readProbe(
    await queryRows(`begin;\n${setupSql}\n${PROBE_SCRIPT}\nrollback;`, {
      db: workerDatabaseName(),
    }),
  )
}

const PROBE_PREFIX = 'pc_posture_'

interface Control {
  readonly name: string
  readonly rule: string
  readonly mutation: string
  readonly setup: string
  readonly probe: (setupSql: string) => Promise<PostureProbe>
  /** Fragments this control's message MUST contain. */
  readonly expect: readonly string[]
}

const CONTROLS: readonly Control[] = [
  {
    name: 'a public table owned by statesman_app',
    rule: 'rule 3 OWNERSHIP (V4)',
    mutation: 'M5',
    // V4: table OWNERSHIP bypasses RLS under ENABLE independently of rolsuper
    // and rolbypassrls, so an app-owned table is a tenancy bypass that no role
    // attribute check can see. The probe table is forced-RLS, carries a
    // require_user_id() policy, has a NOT NULL user_id and is registered as
    // exempt — so rules 1, 2, 8, 9 and 10 are all satisfied and rule 3 is the
    // only thing left that can fire. Without that, this control would pass on
    // rule 2 alone and rule 3 could stay unmatchable (which is exactly what M5
    // made it).
    setup: `create table public.${PROBE_PREFIX}own (
              id uuid primary key, user_id uuid not null);
            alter table public.${PROBE_PREFIX}own enable row level security;
            alter table public.${PROBE_PREFIX}own force  row level security;
            create policy ${PROBE_PREFIX}own_tenancy on public.${PROBE_PREFIX}own
              using (user_id = app.require_user_id())
              with check (user_id = app.require_user_id());
            insert into public.posture_exempt_table (table_name, reason)
              values ('${PROBE_PREFIX}own', 'rolled-back posture control');
            alter table public.${PROBE_PREFIX}own owner to statesman_app;`,
    probe: probeAsAdmin,
    expect: [`${FRAGMENT.rule3}: ${PROBE_PREFIX}own`],
  },
  {
    name: 'TRUNCATE granted to statesman_app on decision_revision',
    rule: 'rule 7 NO TRUNCATE (V15)',
    mutation: 'M6',
    // V15: TRUNCATE bypasses row-level BEFORE UPDATE/DELETE triggers, so the
    // append-only triggers on decision_revision do not cover it and the absent
    // grant is the real control. Rule 7 is what notices the grant coming back.
    setup: 'grant truncate on public.decision_revision to statesman_app;',
    probe: probeAsOwner,
    expect: [`${FRAGMENT.rule7} decision_revision`],
  },
  {
    name: 'the sentinel rows deleted',
    rule: 'rule 9 SENTINELS (V18)',
    mutation: 'M8',
    // Deleting a sentinel needs three brackets at once, and each one is a
    // measured fact rather than caution:
    //   - FORCE makes an owner-run DELETE … WHERE affect zero rows and raise
    //     nothing (V8), so the delete would silently do nothing and this
    //     control would prove that rule 9 cannot fail;
    //   - decision_revision's append-only triggers fire for the table OWNER as
    //     well (V32), so the row cannot be deleted while they are enabled;
    //   - the revision has to go first, because `dr_parent_fk` cascades and the
    //     cascade would hit those same triggers.
    // FORCE and the triggers are restored BEFORE the posture call, so rules 1,
    // 2 and 7 see the schema they expect and rule 9 is the only rule that can
    // fire. The ALTERs are transactional, so the rollback restores them even if
    // an assertion throws.
    setup: `alter table public.decision          no force row level security;
            alter table public.decision_revision no force row level security;
            alter table public.decision_revision disable trigger user;
            delete from public.decision_revision where user_id = '${SENTINEL_USER_ID}';
            delete from public.decision          where user_id = '${SENTINEL_USER_ID}';
            alter table public.decision_revision enable  trigger user;
            alter table public.decision          force row level security;
            alter table public.decision_revision force row level security;`,
    probe: probeAsOwner,
    expect: [
      `${FRAGMENT.rule9} decision: 0, expected exactly 1`,
      `${FRAGMENT.rule9} decision_revision: 0, expected exactly 1`,
    ],
  },
  {
    name: 'a SECOND row owned by the sentinel',
    rule: 'rule 9 SENTINELS — "exactly one", in the other direction',
    mutation: 'M8',
    // `>= 1` would be satisfied by a table that had quietly accumulated rows
    // under the reserved identity, which is how a sentinel stops being a
    // control: assertSentinelIntegrity() asserts `= 1`, and a rule that only
    // checked presence would let the suite's own premise rot.
    setup: `alter table public.decision no force row level security;
            insert into public.decision (id, user_id, draft_payload, created_at)
              values ('00000000-0000-0000-0000-00000000de99', '${SENTINEL_USER_ID}',
                      '{}'::jsonb, now());
            alter table public.decision force row level security;`,
    probe: probeAsOwner,
    expect: [`${FRAGMENT.rule9} decision: 2, expected exactly 1`],
  },
  {
    name: 'a nullable user_id column',
    rule: 'rule 10 NOT NULL',
    mutation: 'M8',
    // A nullable user_id makes `user_id = app.require_user_id()` evaluate to
    // NULL rather than false, so the row sits outside every policy in both
    // directions. The probe table is registered as exempt so that rule 2 cannot
    // fire, and has no grants so that rule 1 cannot: rule 10 is the only rule
    // left, which is what distinguishes this control from "a new table".
    setup: `create table public.${PROBE_PREFIX}null (id uuid primary key, user_id uuid);
            insert into public.posture_exempt_table (table_name, reason)
              values ('${PROBE_PREFIX}null', 'rolled-back posture control');`,
    probe: probeAsOwner,
    expect: [`${FRAGMENT.rule10}: ${PROBE_PREFIX}null`],
  },
  {
    name: 'a protected table with no user_id column at all',
    rule: 'rule 9 SENTINELS — fails closed when it cannot be evaluated',
    mutation: 'M8',
    // Canon §4.8 warns that rules 1 and 2 must be column-name independent,
    // because an `attname='user_id'` selector misses app_user (whose owner
    // column is `id`). Rules 9 and 10 cannot be column-independent — they are
    // about that column. So a protected, non-exempt table without one is
    // REPORTED rather than skipped: a new indirectly-scoped table has to be
    // given a sentinel or registered as exempt, and cannot pass by being
    // unreadable to the rule.
    setup: `create table public.${PROBE_PREFIX}nouid (id uuid primary key);
            alter table public.${PROBE_PREFIX}nouid enable row level security;
            alter table public.${PROBE_PREFIX}nouid force  row level security;
            create policy ${PROBE_PREFIX}nouid_t on public.${PROBE_PREFIX}nouid
              using (id = app.require_user_id())
              with check (id = app.require_user_id());`,
    probe: probeAsOwner,
    expect: [`${FRAGMENT.rule9NoColumn}, so rule 9 cannot be evaluated: ${PROBE_PREFIX}nouid`],
  },
]

beforeAll(async () => {
  // Charge CREATE DATABASE ... TEMPLATE to the hook's 120 s budget.
  await ensureWorkerDatabase()
}, 120_000)

describe('[NFR-01] [NFR-02] posture rules 3, 7, 9 and 10 — the controls the mutation pass found missing', () => {
  it('instrument: both probes report CLEAN against the unmodified schema', async () => {
    // Not a formality. Without it every "it raised ST099" below is satisfied by
    // a checker that raises unconditionally. Both probes are checked, because
    // the rule 3 control uses the admin one and an instrument is only validated
    // in the configuration it is used in.
    const asOwner = await probeAsOwner('')
    expect(asOwner.sqlstate, `as statesman_owner: ${asOwner.message}`).toBe(CLEAN)
    expect(asOwner.message).toBe('')

    const asAdmin = await probeAsAdmin('')
    expect(asAdmin.sqlstate, `as the bootstrap superuser: ${asAdmin.message}`).toBe(CLEAN)
    expect(asAdmin.message).toBe('')

    // The two probes really are different connections, which is the whole
    // reason the second one exists. Read back, not assumed (V1: pg_hba is
    // `trust`, so a name in a URL is whatever it says it is).
    expect(migratorRole()).toBe('statesman_migrator')
    expect(harnessEnv().TEST_ADMIN_ROLE).not.toBe(migratorRole())
  })

  for (const control of CONTROLS) {
    it(`[${control.mutation}] raises ST099 for ${control.name} — ${control.rule}`, async () => {
      const violated = await control.probe(control.setup)

      expect(
        violated.sqlstate,
        `the posture check reported ${violated.sqlstate} rather than ${POSTURE_FAILED} ` +
          `for ${control.name}. Message: ${violated.message}`,
      ).toBe(POSTURE_FAILED)

      for (const fragment of control.expect) {
        expect(
          violated.message,
          `${control.rule} did not report the violation it exists to catch. ` +
            `Message: ${violated.message}`,
        ).toContain(fragment)
      }

      // Nothing else fired. This is what makes the control attributable to the
      // rule it names: with M5 or M6 reinstated, the message would either be
      // empty (ST099 never raised) or carry a different rule's text, and both
      // are failures here.
      const allowed = new Set(
        ALL_FRAGMENTS.filter((f) => control.expect.some((e) => e.includes(f))),
      )
      for (const fragment of ALL_FRAGMENTS) {
        if (allowed.has(fragment)) continue
        expect(
          violated.message,
          `${control.rule}: the message also reported '${fragment}', so this control is ` +
            'not attributable to the rule it names',
        ).not.toContain(fragment)
      }

      // The violation was introduced inside a transaction the helper rolled
      // back. Re-probing the clean schema is the evidence: if the rollback had
      // not taken, this would now carry the same ST099 and every later test in
      // this worker would be measuring a contaminated database.
      const after = await probeAsOwner('')
      expect(
        after.sqlstate,
        `the ${control.rule} control leaked out of its rolled-back transaction: ${after.message}`,
      ).toBe(CLEAN)
    })
  }

  it('[M8] rule 10 is the attnotnull bit and not the probe table — the same table with NOT NULL passes', async () => {
    // The paired positive control for rule 10. Identical setup to its violation
    // except for two words, so a rule that flagged any newly created table
    // (rather than the nullable column) fails here.
    const clean = await probeAsOwner(
      `create table public.${PROBE_PREFIX}null (id uuid primary key, user_id uuid not null);
       insert into public.posture_exempt_table (table_name, reason)
         values ('${PROBE_PREFIX}null', 'rolled-back posture control');`,
    )
    expect(
      clean.sqlstate,
      `a probe table whose user_id is NOT NULL was still reported: ${clean.message}`,
    ).toBe(CLEAN)
    expect(clean.message).toBe('')
  })

  it('still passes after every control has run', async () => {
    const final = await probeAsOwner('')
    expect(final.sqlstate, final.message).toBe(CLEAN)
    expect(final.message).toBe('')
  })
})
