/**
 * Controls for the posture rules that `posture.test.ts` does not cover.   [NFR-01] [NFR-02]
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS, AND WHY THE PORT MADE IT LOAD-BEARING
 * ---------------------------------------------------------------------------
 * `posture.test.ts` controls rules 1a, 2, 4, 5, 6 and 8. An adversarial pass then mutated
 * the remaining rules one at a time and re-ran the suite:
 *
 *   M5  rule 3 OWNERSHIP made unmatchable                            -> 44/44 green
 *   M6  rule 7 NO TRUNCATE made unreachable (`if false then`)        -> 44/44 green
 *   M8  rules 9 SENTINELS and 10 NOT NULL were not implemented at all
 *
 * A guard whose removal leaves the suite green is not protecting anything the suite can
 * see. This file is the missing half. ADR-0015 then raised the stakes: the server boundary
 * and the grant model are gone, RLS is the only wall left, and "the posture check and the
 * mutation gate stop being good practice and become the only thing standing between a
 * policy typo and the journal."
 *
 * ---------------------------------------------------------------------------
 * WHAT THE PORT CHANGED HERE, BEYOND ROLE NAMES
 * ---------------------------------------------------------------------------
 * A rename would have left four controls passing while testing something else:
 *
 *   RULE 3 is no longer "owned by statesman_app". On Supabase `public` belongs to
 *   `pg_database_owner` and our relations to `postgres`, so the old rule could not be
 *   ported literally. It is restated as its intent — no relation may be owned by a role a
 *   BROWSER CLIENT can become (`anon`, `authenticated`, `service_role`) — so the probe
 *   table is handed to `authenticated`, which is the role the published page resolves to.
 *
 *   RULE 9 no longer skips `posture_exempt_table`, so a forced-RLS probe table now needs
 *   its own sentinel row or rule 9a fires alongside the rule under test and the control
 *   stops being attributable. MEASURED: without the seeded sentinel the rule-3 setup
 *   reports rule 9a as well.
 *
 *   RULE 9 SPLIT INTO 9a/9b, and 9b is the gap the port closed: the five reference tables
 *   of 20261021140700 carried sentinels that NOTHING CHECKED, waived out of the old rule 9
 *   by an exemption row. Three controls cover it here — a deleted reference sentinel, a
 *   registry row naming a column that does not exist, and an unregistered protected table —
 *   and none has an analogue in the pre-port file, because the rule they exercise did not
 *   exist.
 *
 *   RULES 11 AND 12 ARE NEW. Rule 11 allowlists the four roles Supabase mandates BY NAME
 *   with a reason each and flags any other role that is, or can become, BYPASSRLS; rule 12
 *   does the same for `pg_read_all_data` / `pg_write_all_data` membership, which carry no
 *   BYPASSRLS and so slip past rule 11 entirely (V34 recorded each slipping through an
 *   attribute-only predicate separately).
 *
 *   RULE 6 now covers `auth.uid()` as well as the two `app` accessors, and that leg can
 *   only be set up by the cluster superuser — see the control's own comment.
 *
 * ---------------------------------------------------------------------------
 * EVERY CONTROL IS INSIDE A ROLLED-BACK TRANSACTION, AND FOR RULES 11/12 THAT IS NOT
 * HYGIENE
 * ---------------------------------------------------------------------------
 * Rules 11 and 12 enumerate CLUSTER-WIDE role state, so a committed scratch role with
 * BYPASSRLS or `pg_read_all_data` membership fails `app.verify_security_posture()` in every
 * database at once — including the clean-schema instrument of this very file running in
 * another Vitest worker. MEASURED in the baseline run that preceded this rewrite: the
 * pre-port role-guard file held `grant pg_write_all_data to statesman_migrator` while a
 * concurrent worker's "both probes report CLEAN" assertion failed with
 * `rule 12: role statesman_migrator holds pg_write_all_data by membership and is not
 * allowlisted`. Role DDL is transactional and another session cannot see an uncommitted
 * role, so creating the scratch roles INSIDE the probe transaction reduces that window to
 * nothing. `afterAll` reads the catalogue back to prove none escaped.
 *
 * ---------------------------------------------------------------------------
 * EVERY ASSERTION NAMES ITS RULE'S OWN TEXT, NEVER BARE ST099
 * ---------------------------------------------------------------------------
 * "It raised ST099" is satisfied by a checker whose body is
 * `raise exception ... using errcode = 'ST099'`, and — worse — by one rule's control
 * passing on a different rule's violation. So each control asserts the fragment its own
 * rule emits AND the absence of every other rule's fragment, and the clean schema is
 * probed through the same helper before and after. The fragments below were read back from
 * the messages the function actually produced; each of the fourteen setups was executed and
 * reported exactly one rule's text.
 *
 * ---------------------------------------------------------------------------
 * THE TWO PROBE CONNECTIONS
 * ---------------------------------------------------------------------------
 * `probeAsPostgres` is the role `scripts/migrate.sh` runs the check as. `probeAsAdmin` is
 * the bootstrap superuser, needed where the setup itself is impossible for `postgres`:
 * CREATE ROLE with BYPASSRLS, `ALTER TABLE ... OWNER TO authenticated` (ownership transfer
 * requires membership in the TARGET role, and `postgres` holds `authenticated` only
 * NOINHERIT), and redefining `auth.uid()`, which the emulation deliberately makes
 * impossible for our own migrations (port finding P9: the `auth` schema is platform-owned).
 *
 * Both are BYPASSRLS, so rule 9's row counts here are unfiltered. That is a property of the
 * CALLER, not of the rule: the function sets the sentinel claim precisely so that a
 * non-bypassrls caller counts the same rows. The instrument test below checks both
 * connections, because an instrument is only validated in the configuration it is used in.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  EXPECTED_APP_ROLE,
  ensureWorkerDatabase,
  harnessEnv,
  migratorRole,
  ownerQuery,
  queryRows,
  workerDatabaseName,
} from './support/db'
import { SENTINEL_USER_ID } from './support/sentinels'
import { SEEDED_SCENARIO_VERSION_ID } from './support/scenario-fixtures'

/** What the function did, as data rather than as a thrown error. */
interface PostureProbe {
  readonly sqlstate: string
  readonly message: string
  /** Every row the script emitted, so a setup can publish its own measurements. */
  readonly rows: readonly string[][]
}

/** plpgsql's `successful_completion`. */
const CLEAN = '00000'
const POSTURE_FAILED = 'ST099'

/**
 * Every rule's own message fragment, so each control can assert both what IS reported and
 * what is NOT.
 *
 * The `absent` half is what makes a control attributable. Several violations trip more than
 * one rule — a new table with grants trips 1a AND 2, a forced probe table with no sentinel
 * trips the rule under test AND 9a — and a control that only checked its own fragment would
 * pass just as happily on a checker where some unrelated rule did all the work.
 */
const FRAGMENT = {
  rule1a: 'reachable by authenticated without forced RLS + policy',
  rule1b: 'there is no anonymous path in this product',
  rule2: 'not forced-RLS and not exempt',
  rule3: 'owned by a client-reachable role',
  rule4: 'EXECUTE granted to',
  rule5: 'view without security_invoker=true',
  rule6: '() is missing or not STABLE',
  rule7: 'holds TRUNCATE on a truncate-guarded table',
  rule8: 'policy not scoped by auth.uid()',
  rule9a: 'rule 9a: sentinel rows in',
  rule9bUnregistered: 'has no user_id column and no',
  rule9bColumn: 'registers sentinel column',
  rule9bCount: 'rule 9b: sentinel rows in',
  /**
   * Rule 9 failing to EVALUATE rather than measuring a wrong count. This is the most
   * important `absent` entry in the file: rule 9 swaps the identity claim to the sentinel so
   * that a non-bypassrls caller reads the same rows, and a rule 9 that reported this string
   * would be a broken instrument reporting a violation it never measured.
   */
  rule9Broken: 'sentinel rule could not be evaluated',
  rule10: 'user_id column is nullable',
  rule11: 'is or can become BYPASSRLS',
  rule12: 'by membership and is not allowlisted',
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
 * Letting the exception escape would abort the psql script before the explicit `rollback`,
 * leaving teardown to the connection closing. Reading the message also matters: a checker
 * that raises ST099 for the wrong reason has not been shown to catch anything. The `do`
 * block's EXCEPTION clause rolls back to its own implicit savepoint before the handler runs,
 * so the two `set_config` calls in the handler survive to be read by the following SELECT.
 *
 * Newlines and pipes are stripped from SQLERRM because psql runs with `-A -t -F '|'`: either
 * character would parse as extra rows or columns.
 */
function readProbe(rows: readonly string[][]): PostureProbe {
  const row = rows.find((r) => r[0] === 'probe')
  const sqlstate = row?.[1]
  if (row === undefined || sqlstate === undefined) {
    throw new Error(
      'the posture probe returned no labelled row — the script did not reach its SELECT. ' +
        'A missing label is a harness failure and is never a pass.',
    )
  }
  return { sqlstate, message: row[2] ?? '', rows }
}

/** Run the posture check after `setupSql`, as `postgres`, inside a rolled-back transaction. */
async function probeAsPostgres(setupSql: string): Promise<PostureProbe> {
  return readProbe(await ownerQuery(`begin;\n${setupSql}\n${PROBE_SCRIPT}\nrollback;`))
}

/** The same, as the bootstrap superuser. See this file's header for when that is required. */
async function probeAsAdmin(setupSql: string): Promise<PostureProbe> {
  await ensureWorkerDatabase()
  return readProbe(
    await queryRows(`begin;\n${setupSql}\n${PROBE_SCRIPT}\nrollback;`, {
      db: workerDatabaseName(),
    }),
  )
}

const PROBE_PREFIX = 'pc_posture_'

/**
 * Scratch roles for rules 11 and 12, named after this worker's database so two workers
 * cannot pick the same name in the catalogue they share. Rolled back, never committed.
 */
const SCRATCH_PREFIX = 'pcr_'
const SCRATCH_LIKE = String.raw`pcr\_%`

function scratchRole(kind: string): string {
  const name = `${SCRATCH_PREFIX}${kind}_${workerDatabaseName()}`
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`derived scratch role name is not a safe identifier: ${name}`)
  }
  return name
}

const SCRATCH = {
  bypass: scratchRole('bypass'),
  member: scratchRole('member'),
  readall: scratchRole('readall'),
  writeall: scratchRole('writeall'),
} as const

/**
 * The reference sentinel rule 9b locates through `public.posture_sentinel_row`.
 *
 * `scenario_claim` is the leaf of the reference graph — nothing has a foreign key to it and
 * it carries no BEFORE UPDATE/DELETE trigger (those are on `scenario_version` and
 * `rubric_version`) — so deleting its sentinel exercises rule 9b and nothing else. Its
 * registry row is keyed on `scenario_version_id` rather than an `id`, because claim handles
 * are unique only within a version; that is the registry earning its existence.
 */
const REFERENCE_SENTINEL = {
  table: 'scenario_claim',
  column: 'scenario_version_id',
  id: '00000000-0000-0000-0000-000000080003',
} as const

interface Control {
  readonly name: string
  readonly rule: string
  /** The registered mutation this control catches, or the rule it guards when none exists. */
  readonly mutation: string
  readonly setup: string
  readonly probe: (setupSql: string) => Promise<PostureProbe>
  /** Fragments this control's message MUST contain. */
  readonly expect: readonly string[]
  /** Extra strings the message must NOT contain, beyond every other rule's fragment. */
  readonly absentText?: readonly string[]
}

const CONTROLS: readonly Control[] = [
  {
    name: `a public table owned by ${EXPECTED_APP_ROLE}`,
    rule: 'rule 3 OWNERSHIP (V4)',
    mutation: 'M5',
    // V4: table OWNERSHIP bypasses RLS under ENABLE independently of rolsuper and
    // rolbypassrls, so a client-owned table is a tenancy bypass that no role attribute check
    // can see. ADR-0015 restates the rule as "no relation owned by a role a browser can
    // become", so the probe table is handed to `authenticated` — the role the published
    // GitHub Page resolves to with the publishable key.
    //
    // The table is forced-RLS, carries an auth.uid() policy, has a NOT NULL user_id AND A
    // SEEDED SENTINEL, so rules 1a, 2, 8, 9a and 10 are all satisfied and rule 3 is the only
    // thing left that can fire. The sentinel is the port's addition: rule 9 no longer skips
    // exempt tables, and MEASURED without it this setup reports rule 9a as well.
    //
    // probeAsAdmin, because `ALTER TABLE ... OWNER TO` requires membership in the TARGET role
    // and `postgres` holds `authenticated` only NOINHERIT.
    setup: `create table public.${PROBE_PREFIX}own (
              id uuid primary key, user_id uuid not null);
            alter table public.${PROBE_PREFIX}own enable row level security;
            alter table public.${PROBE_PREFIX}own force  row level security;
            create policy ${PROBE_PREFIX}own_tenancy on public.${PROBE_PREFIX}own
              using (user_id = auth.uid())
              with check (user_id = auth.uid());
            insert into public.${PROBE_PREFIX}own (id, user_id)
              values ('00000000-0000-0000-0000-0000000000c1', '${SENTINEL_USER_ID}');
            alter table public.${PROBE_PREFIX}own owner to ${EXPECTED_APP_ROLE};`,
    probe: probeAsAdmin,
    expect: [`${FRAGMENT.rule3} (${EXPECTED_APP_ROLE}): ${PROBE_PREFIX}own`],
  },
  {
    name: `TRUNCATE granted to ${EXPECTED_APP_ROLE} on decision_revision`,
    rule: 'rule 7 NO TRUNCATE (V15)',
    mutation: 'M6',
    // V15: TRUNCATE bypasses row-level BEFORE UPDATE/DELETE triggers, so the append-only
    // triggers on decision_revision do not cover it and the absent grant is the real control.
    // The port generalised rule 7 from one hardcoded table to every table carrying a BEFORE
    // TRUNCATE trigger, which is why the grant is made to the CLIENT role: `authenticated` is
    // who PostgREST resolves a signed-in browser to.
    setup: `grant truncate on public.decision_revision to ${EXPECTED_APP_ROLE};`,
    probe: probeAsPostgres,
    expect: [`${FRAGMENT.rule7}: decision_revision`],
  },
  {
    name: 'the sentinel rows deleted',
    rule: 'rule 9a SENTINELS (V18)',
    mutation: 'M8',
    // Deleting a sentinel needs three brackets at once, and each is a measured fact:
    //   - decision_revision's append-only triggers fire for the table OWNER as well (V32),
    //     so the row cannot be deleted while they are enabled;
    //   - the revision has to go first, because `dr_parent_fk` cascades and the cascade
    //     would hit those same triggers;
    //   - FORCE makes an owner-run DELETE ... WHERE affect zero rows and raise nothing (V8).
    //     The probe connection is `postgres`, which is BYPASSRLS and therefore not
    //     FORCE-sensitive, so the NO FORCE bracket is redundant TODAY — and it is kept
    //     anyway, because depending on the probe role's `rolbypassrls` for the control's own
    //     validity is the dependency ADR-0015 calls the port's most dangerous fact. Pointed
    //     at a merely-owning role, the delete would silently affect nothing and this control
    //     would prove that rule 9 cannot fail.
    // FORCE and the triggers are restored BEFORE the posture call, so rules 1a, 2 and 7 see
    // the schema they expect and rule 9a is the only rule that can fire.
    setup: `alter table public.decision          no force row level security;
            alter table public.decision_revision no force row level security;
            alter table public.decision_revision disable trigger user;
            delete from public.decision_revision where user_id = '${SENTINEL_USER_ID}';
            delete from public.decision          where user_id = '${SENTINEL_USER_ID}';
            alter table public.decision_revision enable  trigger user;
            alter table public.decision          force row level security;
            alter table public.decision_revision force row level security;`,
    probe: probeAsPostgres,
    expect: [
      `${FRAGMENT.rule9a} decision: 0, expected exactly 1`,
      `${FRAGMENT.rule9a} decision_revision: 0, expected exactly 1`,
    ],
    // `profile` is the third owner-keyed protected table and its sentinel was NOT touched, so
    // rule 9a must not report it. Without this, a rule 9a that counted zero for EVERY table —
    // because the claim swap had stopped working, say — would pass this control.
    absentText: ['sentinel rows in profile'],
  },
  {
    name: 'a SECOND row owned by the sentinel',
    rule: 'rule 9a SENTINELS — "exactly one", in the other direction',
    mutation: 'M8',
    // `>= 1` would be satisfied by a table that had quietly accumulated rows under the
    // reserved identity, which is how a sentinel stops being a control:
    // assertSentinelIntegrity() asserts `= 1`, and a rule that only checked presence would
    // let the suite's own premise rot.
    setup: `alter table public.decision no force row level security;
            insert into public.decision (id, user_id, draft_payload, created_at,
                                        scenario_version_id)
              values ('00000000-0000-0000-0000-00000000de99', '${SENTINEL_USER_ID}',
                      '{}'::jsonb, now(), '${SEEDED_SCENARIO_VERSION_ID}'::uuid);
            alter table public.decision force row level security;`,
    probe: probeAsPostgres,
    expect: [`${FRAGMENT.rule9a} decision: 2, expected exactly 1`],
  },
  {
    name: 'a reference sentinel deleted',
    rule: 'rule 9b SENTINELS — the gap the port closed',
    mutation: 'M20',
    // THE CONTROL WITH NO PRE-PORT ANALOGUE. The old rule 9 skipped any table listed in
    // `posture_exempt_table`, and 20261021140700 used that to waive its five reference tables
    // because their sentinels are keyed by `id`, not `user_id`. The sentinels were seeded and
    // the comment argued at length that the evidence requirement was met — but NOTHING
    // CHECKED THEM. Five protected tables carried an unenforced sentinel: true the day it was
    // written, with nothing to notice when it stopped being true.
    //
    // Rule 9b counts the row the registry points at. This is the half that proves the count
    // is real: delete that row and the rule must notice.
    setup: `alter table public.${REFERENCE_SENTINEL.table} no force row level security;
            delete from public.${REFERENCE_SENTINEL.table}
             where ${REFERENCE_SENTINEL.column} = '${REFERENCE_SENTINEL.id}';
            alter table public.${REFERENCE_SENTINEL.table} force row level security;`,
    probe: probeAsPostgres,
    expect: [
      `${FRAGMENT.rule9bCount} ${REFERENCE_SENTINEL.table} ` +
        `where ${REFERENCE_SENTINEL.column} = ${REFERENCE_SENTINEL.id}: 0, expected exactly 1`,
    ],
    // The other four reference tables keep their sentinels, so exactly one 9b count may fail.
    absentText: ['rule 9b: sentinel rows in rubric_version', 'rule 9b: sentinel rows in source'],
  },
  {
    name: 'a registry row naming a column that does not exist',
    rule: 'rule 9b SENTINELS — the registry is catalog-checked',
    // M29, not M20. M20 disables rule 9b's sentinel COUNT leg, which this branch never
    // reaches — it validates the REGISTRY against pg_attribute first. Tagging it M20 made it
    // look proven by a mutation that cannot touch it.
    mutation: 'M29',
    // The registry holds identifiers, interpolated through format('%I'). If a registered
    // column stopped existing — a rename, a dropped column — a rule that trusted the registry
    // would raise 42703 from inside its own EXECUTE and be reported as "could not be
    // evaluated", which reads as a harness fault rather than as a missing sentinel. Rule 9b
    // checks the column against pg_attribute FIRST and reports the registry row, which is why
    // `rule9Broken` being absent matters for this control in particular.
    setup: `update public.posture_sentinel_row
               set id_column = 'no_such_col' where table_name = 'rubric_version';`,
    probe: probeAsPostgres,
    expect: [`${FRAGMENT.rule9bColumn} no_such_col, which does not exist`],
  },
  {
    name: 'a protected table with no user_id column at all',
    rule: 'rule 9b SENTINELS — unregistered is a failure, not a skip',
    // M30, not M20, for the same reason: this is the `reg_col is null` branch and it never
    // reaches the count leg either.
    mutation: 'M30',
    // Canon section 4.8 warns that rules 1 and 2 must be column-name independent, because an
    // `attname='user_id'` selector misses an indirectly scoped table. Rules 9 and 10 cannot
    // be column-independent — they are ABOUT that column — so a protected table without one
    // is REPORTED rather than skipped, and the port removed the escape hatch that
    // `posture_exempt_table` used to provide. The policy is written with auth.uid() so rule 8
    // cannot be the thing that fires.
    setup: `create table public.${PROBE_PREFIX}nouid (id uuid primary key);
            alter table public.${PROBE_PREFIX}nouid enable row level security;
            alter table public.${PROBE_PREFIX}nouid force  row level security;
            create policy ${PROBE_PREFIX}nouid_t on public.${PROBE_PREFIX}nouid
              for select using (auth.uid() is not null);`,
    probe: probeAsPostgres,
    expect: [`${FRAGMENT.rule9bUnregistered} public.posture_sentinel_row entry`],
  },
  {
    name: 'a nullable user_id column',
    rule: 'rule 10 NOT NULL',
    mutation: 'M8',
    // A nullable user_id makes `user_id = auth.uid()` evaluate to NULL rather than false, so
    // the row sits outside every policy in BOTH directions — invisible to its owner and
    // unprotected by the predicate meant to scope it. The probe table is registered as exempt
    // so rule 2 cannot fire, has no grants so rule 1a cannot, and is not forced so rule 9
    // does not enumerate it: rule 10 is the only rule left, which is what distinguishes this
    // control from "a new table".
    setup: `create table public.${PROBE_PREFIX}null (id uuid primary key, user_id uuid);
            insert into public.posture_exempt_table (table_name, reason)
              values ('${PROBE_PREFIX}null', 'rolled-back posture control');`,
    probe: probeAsPostgres,
    expect: [`${FRAGMENT.rule10}: ${PROBE_PREFIX}null`],
  },
  {
    name: 'anon granted SELECT on a public table',
    rule: 'rule 1b REACHABILITY — `anon` must hold nothing',
    mutation: 'M21',
    // NEW IN THE PORT, and the normal failure here rather than an exotic one: a stock Supabase
    // project ships `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO
    // postgres, anon, authenticated, service_role`, so a table is readable and writable by the
    // role the published page resolves to THE INSTANT IT EXISTS. There is no anonymous path in
    // this product: every table is either a user's private journal (FR-14) or content for a
    // signed-in user. `decision` is already forced-RLS with a policy, so rules 1a and 2 are
    // satisfied and rule 1b is the only one that can fire.
    setup: 'grant select on public.decision to anon;',
    probe: probeAsPostgres,
    expect: [`anon holds SELECT on decision (${FRAGMENT.rule1b}`],
  },
  {
    name: 'a BYPASSRLS role that can reach a table',
    rule: 'rule 11 BYPASSRLS — the attribute case',
    mutation: 'M19',
    // ADR-0015's keystone. A bypassrls role reads every row of every table regardless of
    // policy, and Supabase ships four such roles by platform requirement, so "none exist" is
    // not an available posture — the only available one is "every one of them is named, with a
    // reason, in public.posture_bypassrls_allow". The rule is deliberately NOT "which tables
    // can it reach": a bypassrls role reaches everything by definition, so a table-level test
    // would report the symptom and miss the cause. The SELECT grant is here so the reported
    // reach is 1 rather than 0, which a hardcoded count could not be.
    setup: `create role ${SCRATCH.bypass} nologin bypassrls;
            grant select on public.decision to ${SCRATCH.bypass};`,
    probe: probeAsAdmin,
    expect: [
      `rule 11: role ${SCRATCH.bypass} ${FRAGMENT.rule11} (via ${SCRATCH.bypass})`,
      'holds direct SELECT on 1 public tables',
    ],
  },
  {
    name: 'a role that is a MEMBER of a bypassrls role',
    rule: 'rule 11 BYPASSRLS — the membership case (V3)',
    mutation: 'M19',
    // V3 measured a role with `rolbypassrls = false` that was a MEMBER of a BYPASSRLS role: it
    // passed an attribute check while `SET ROLE` to it succeeded. That is why rule 11 tests
    // `pg_has_role(..., 'MEMBER')` and not `'USAGE'`. The grant is made WITH INHERIT FALSE,
    // which is exactly how the platform grants `service_role` to `authenticator`, and it is
    // what makes this leg distinguishable from the attribute case above: the scratch role's
    // own `rolbypassrls` is FALSE and `pg_has_role(...,'USAGE')` is FALSE, so only the MEMBER
    // predicate can report it. Both are measured by the setup's own labelled row and asserted
    // in a test of their own below.
    setup: `create role ${SCRATCH.member} nologin;
            grant service_role to ${SCRATCH.member} with inherit false;
            select 'v3',
                   (select r.rolbypassrls::text from pg_roles r
                     where r.rolname = '${SCRATCH.member}'),
                   pg_has_role('${SCRATCH.member}', 'service_role', 'USAGE')::text,
                   pg_has_role('${SCRATCH.member}', 'service_role', 'MEMBER')::text;`,
    probe: probeAsAdmin,
    expect: [`rule 11: role ${SCRATCH.member} ${FRAGMENT.rule11} (via service_role)`],
    // `service_role` itself IS allowlisted, so it must not be reported alongside the member —
    // otherwise this control would pass on a rule that ignores the allowlist.
    absentText: ['rule 11: role service_role'],
  },
  {
    name: 'a role holding pg_read_all_data by membership',
    rule: 'rule 12 BROAD GRANTS (V34)',
    mutation: 'rule 12',
    // pg_read_all_data carries NO BYPASSRLS, so rule 11 misses it and RLS does still apply —
    // but it confers SELECT on everything that exists AND everything added later, which
    // defeats the per-table reasoning rules 1 and 2 are built on. The predefined roles are
    // RESERVED (`ALTER ROLE pg_read_all_data ...` is refused by the server), so membership is
    // the only way to acquire them, which is what this control grants.
    setup: `create role ${SCRATCH.readall} nologin;
            grant pg_read_all_data to ${SCRATCH.readall};`,
    probe: probeAsAdmin,
    expect: [`rule 12: role ${SCRATCH.readall} holds pg_read_all_data ${FRAGMENT.rule12}`],
    // V34 recorded the two slipping through SEPARATELY, so a control that allowed the other
    // name to appear would not distinguish one predicate from a pair.
    absentText: ['pg_write_all_data'],
  },
  {
    name: 'a role holding pg_write_all_data by membership',
    rule: 'rule 12 BROAD GRANTS (V34)',
    mutation: 'rule 12',
    setup: `create role ${SCRATCH.writeall} nologin;
            grant pg_write_all_data to ${SCRATCH.writeall};`,
    probe: probeAsAdmin,
    expect: [`rule 12: role ${SCRATCH.writeall} holds pg_write_all_data ${FRAGMENT.rule12}`],
    absentText: ['pg_read_all_data'],
  },
  {
    name: 'auth.uid() redefined as IMMUTABLE',
    rule: 'rule 6 VOLATILITY — the platform accessor',
    mutation: 'rule 6',
    // An IMMUTABLE identity accessor may be constant-folded and cached across prepared
    // statements, so one session's user id can be planned into another's query. The port
    // extended rule 6 from `app.require_user_id()` to `app.current_user_id()` AND
    // `auth.uid()`, and docs/supabase-target.md section 1 measured the real `auth.uid()` at
    // provolatile='s' — so this control is what notices an emulation shim that diverges from
    // the platform.
    //
    // probeAsAdmin is REQUIRED here, not convenient: the `auth` schema is platform-owned and
    // `postgres` cannot redefine `auth.uid()` at all ("permission denied for schema auth",
    // port finding P9). That is a property worth keeping — nothing in our migration set can
    // weaken the platform's identity accessor even by accident — and it means the only role
    // that can set up this violation is the cluster superuser, which exists on no Supabase
    // project.
    setup: `create or replace function auth.uid() returns uuid
              language sql immutable set search_path = pg_catalog as $u$
              select coalesce(
                nullif(current_setting('request.jwt.claim.sub', true), ''),
                nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
              )::uuid $u$;`,
    probe: probeAsAdmin,
    expect: [`auth.uid${FRAGMENT.rule6}`],
  },
]

beforeAll(async () => {
  // Charge CREATE DATABASE ... TEMPLATE to the hook's 120 s budget.
  await ensureWorkerDatabase()
}, 120_000)

afterAll(async () => {
  // Rules 11 and 12 read cluster-wide state, so a scratch role that escaped its rollback
  // would fail every other worker's posture check, not only this file's. The catalogue is
  // read back rather than the ROLLBACK being trusted to have happened.
  const rows = await queryRows(
    `select 'left', coalesce(string_agg(rolname, ',' order by rolname), '<none>')
       from pg_roles where rolname like '${SCRATCH_LIKE}'`,
    { db: harnessEnv().TEST_ADMIN_DB },
  )
  const left = rows.find((r) => r[0] === 'left')?.[1]
  if (left !== '<none>') {
    throw new Error(
      `a rules 11/12 scratch role escaped its rolled-back transaction: ${String(left)}. ` +
        'Every database in this cluster now fails app.verify_security_posture().',
    )
  }
})

describe('[NFR-01] [NFR-02] posture rules 1b, 3, 6, 7, 9a, 9b, 10, 11 and 12 — the controls', () => {
  it('instrument: both probes report CLEAN against the unmodified schema', async () => {
    // Not a formality. Without it every "it raised ST099" below is satisfied by a checker that
    // raises unconditionally. Both probes are checked, because several controls use the admin
    // one and an instrument is only validated in the configuration it is used in.
    const asPostgres = await probeAsPostgres('')
    expect(asPostgres.sqlstate, `as postgres: ${asPostgres.message}`).toBe(CLEAN)
    expect(asPostgres.message).toBe('')

    const asAdmin = await probeAsAdmin('')
    expect(asAdmin.sqlstate, `as the bootstrap superuser: ${asAdmin.message}`).toBe(CLEAN)
    expect(asAdmin.message).toBe('')

    // The two probes really are different connections, which is the whole reason the second
    // one exists. Read back, not assumed (V1: pg_hba is `trust`, so a name in a URL is
    // whatever it says it is).
    expect(migratorRole()).toBe('postgres')
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

      for (const absent of control.absentText ?? []) {
        expect(
          violated.message,
          `${control.rule}: the message also reported '${absent}', which this control does ` +
            `not introduce. Message: ${violated.message}`,
        ).not.toContain(absent)
      }

      // Nothing else fired. This is what makes the control attributable to the rule it names:
      // with its mutation reinstated the message would either be empty (ST099 never raised) or
      // carry a different rule's text, and both are failures here.
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

      // The violation was introduced inside a transaction the helper rolled back. Re-probing
      // the clean schema is the evidence: if the rollback had not taken, this would now carry
      // the same ST099 and every later test in this worker would be measuring a contaminated
      // database.
      const after = await probeAsPostgres('')
      expect(
        after.sqlstate,
        `the ${control.rule} control leaked out of its rolled-back transaction: ${after.message}`,
      ).toBe(CLEAN)
    })
  }

  it('[M19] rule 11 consults the ALLOWLIST, not the mere existence of a new role', async () => {
    // THE PAIRED POSITIVE CONTROL FOR RULE 11, and what makes the two rule-11 controls above
    // mean something. Identical setup to the attribute case except for one additional row in
    // `public.posture_bypassrls_allow` — so a rule 11 that flagged every role it had not seen
    // before, or that ignored the registry altogether, fails here.
    const clean = await probeAsAdmin(
      `create role ${SCRATCH.bypass} nologin bypassrls;
       insert into public.posture_bypassrls_allow (rolname, reason)
         values ('${SCRATCH.bypass}', 'rolled-back posture control: a reason is required');`,
    )
    expect(
      clean.sqlstate,
      `an ALLOWLISTED bypassrls role was still reported: ${clean.message}`,
    ).toBe(CLEAN)
    expect(clean.message).toBe('')
  })

  it('[M19] the membership control measures its own premise: rolbypassrls false, USAGE false, MEMBER true', async () => {
    // The V3 control's premise, published by its setup rather than argued in a comment: an
    // attribute check and a USAGE check would BOTH have passed this role, so only the MEMBER
    // predicate can have produced the report the control above asserts.
    const control = CONTROLS.find((c) => c.name === 'a role that is a MEMBER of a bypassrls role')
    expect(control, 'the V3 membership control is missing from CONTROLS').toBeDefined()
    const probed = await probeAsAdmin(control?.setup ?? '')
    const v3 = probed.rows.find((r) => r[0] === 'v3')
    expect(v3, 'the membership setup did not publish its own measurements').toBeDefined()
    expect(v3?.[1], "the scratch role's own rolbypassrls").toBe('false')
    expect(v3?.[2], 'pg_has_role(scratch, service_role, USAGE)').toBe('false')
    expect(v3?.[3], 'pg_has_role(scratch, service_role, MEMBER)').toBe('true')
  })

  it('[M8] rule 10 is the attnotnull bit and not the probe table — the same table with NOT NULL passes', async () => {
    // The paired positive control for rule 10. Identical setup to its violation except for two
    // words, so a rule that flagged any newly created table (rather than the nullable column)
    // fails here.
    const clean = await probeAsPostgres(
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

  it('[M20] rule 9b counts the ROW, so re-pointing the registry does not satisfy it', async () => {
    // The other half of the 9b count control. Deleting the sentinel AND editing the registry to
    // name a different id must STILL fail — otherwise 9b could be satisfied by editing the
    // registry instead of restoring the sentinel, which is the old rule 9's failure in a new
    // costume: a waiver standing in for evidence.
    const probed = await probeAsPostgres(
      `alter table public.${REFERENCE_SENTINEL.table} no force row level security;
       delete from public.${REFERENCE_SENTINEL.table}
        where ${REFERENCE_SENTINEL.column} = '${REFERENCE_SENTINEL.id}';
       alter table public.${REFERENCE_SENTINEL.table} force row level security;
       update public.posture_sentinel_row
          set sentinel_id = '00000000-0000-0000-0000-00000000beef'
        where table_name = '${REFERENCE_SENTINEL.table}';`,
    )
    expect(probed.sqlstate, probed.message).toBe(POSTURE_FAILED)
    expect(probed.message).toContain(`${FRAGMENT.rule9bCount} ${REFERENCE_SENTINEL.table}`)
  })

  it('still passes after every control has run', async () => {
    const final = await probeAsPostgres('')
    expect(final.sqlstate, final.message).toBe(CLEAN)
    expect(final.message).toBe('')
  })
})
