/**
 * [NFR-01] [NFR-02] app.verify_security_posture() — the checker, and whether it can fail.
 *
 * Canon §4.8 and §8.7: the posture function runs at the end of every migration run in
 * every environment AND as integration test number one. This file is that test.
 *
 * ── Why six positive controls and one negative one ───────────────────────────────────
 *
 * `select app.verify_security_posture()` returning void proves almost nothing on its own.
 * A checker whose loops never match anything returns void too, and so does a checker
 * whose queries are syntactically fine and semantically empty. The adversarial pass that
 * produced canon §8 found 56 gates of exactly that kind. So each rule is exercised by
 * introducing the violation it is supposed to catch, inside a transaction that is rolled
 * back, and asserting that the function raises ST099 **naming that specific violation** —
 * not merely that it raised, because "it raised" is satisfied by a checker that always
 * raises. The negative control (the unmodified schema passes) is what excludes that.
 *
 * Each control therefore has two halves:
 *   - the violation produces ST099 and a message containing that rule's own text;
 *   - the clean schema, probed immediately afterwards through the same helper, passes.
 *
 * ── What NFR-02 does and does not get from this file ─────────────────────────────────
 *
 * NFR-02 is "TLS in transit, encryption at rest, protected secrets, least privilege and
 * basic security testing". This file covers the least-privilege and no-PUBLIC-EXECUTE
 * legs. It does NOT cover encryption at rest: canon open item O1 records that Postgres
 * has no TDE and that the obligation is discharged only by a named deployment-posture
 * record (canon §12.3, docs/decisions.md D6). Nothing here should be read as evidence for
 * that leg, and no test in this file asserts it — an assertion that cannot fail would be
 * worse than the acknowledged gap.
 *
 * ── Tagging ──────────────────────────────────────────────────────────────────────────
 *
 * As in state-machine.test.ts: the structural tag channel of
 * requirements-traceability.md §2 does not exist yet, so the tags are literals in STATIC
 * describe titles and no `it.each` appears in this file.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { ensureWorkerDatabase, ownerQuery } from './support/db'

/** What the function raised, as data rather than as a thrown error. */
interface PostureProbe {
  readonly sqlstate: string
  readonly message: string
}

/** The SQLSTATE a clean run reports. plpgsql's `successful_completion`. */
const CLEAN = '00000'
const POSTURE_FAILED = 'ST099'

/**
 * Run `app.verify_security_posture()` after `setupSql`, inside a rolled-back transaction,
 * and report what it did.
 *
 * Why the result comes back as a ROW and not as a rejection: letting the exception escape
 * would abort the psql script, so the explicit `rollback` would never execute and the
 * teardown would rest on the connection closing. More importantly, the assertions want to
 * read the message — a checker that raises ST099 for the wrong reason has not been shown
 * to catch anything. The `do` block's EXCEPTION clause rolls back to its own implicit
 * savepoint before the handler body runs, so the two `set_config` calls in the handler
 * survive to be read by the following SELECT.
 *
 * Newlines and pipes are stripped from SQLERRM because psql is invoked with `-A -t
 * -F '|'`: a value containing either would be parsed as extra rows or extra columns.
 *
 * The function is owned by statesman_owner and has no EXECUTE grant to anyone else (rule
 * 4 forbids PUBLIC), so this goes through `ownerQuery`, which connects as the migrator and
 * SET ROLEs to the owner.
 */
async function probePosture(setupSql: string): Promise<PostureProbe> {
  const rows = await ownerQuery(
    `begin;
${setupSql}
do $posture$ begin
  perform app.verify_security_posture();
  perform set_config('probe.sqlstate', '00000', true);   -- successful_completion, = CLEAN
  perform set_config('probe.message', '', true);
exception when others then
  perform set_config('probe.sqlstate', sqlstate, true);
  perform set_config('probe.message',
                     replace(replace(SQLERRM, E'\\n', ' '), '|', '/'), true);
end $posture$;
select 'probe',
       coalesce(current_setting('probe.sqlstate', true), '<unset>'),
       coalesce(current_setting('probe.message',  true), '<unset>');
rollback;`,
  )

  const row = rows.find((r) => r[0] === 'probe')
  const sqlstate = row?.[1]
  if (row === undefined || sqlstate === undefined) {
    throw new Error(
      'the posture probe returned no labelled row — the script did not reach its SELECT',
    )
  }
  return { sqlstate, message: row[2] ?? '' }
}

/**
 * The six violations, each with the text its rule emits.
 *
 * `absent` is what makes a control discriminating rather than merely loud. Several
 * violations trip more than one rule — an ungranted table with no RLS trips rule 2 only,
 * while a GRANTed one trips rules 1 AND 2 — so the pair is told apart by what is NOT in
 * the message. Without that, controls 2 and 3 would be the same test written twice.
 */
interface PostureControl {
  readonly name: string
  readonly rule: string
  readonly setup: string
  readonly expect: string
  readonly absent: readonly string[]
}

const PROBE_PREFIX = 'pp_posture_'

const CONTROLS: readonly PostureControl[] = [
  {
    name: 'a function created with the default PUBLIC EXECUTE',
    rule: 'rule 4 NO PUBLIC EXEC (V2, V30)',
    // V30: there is no structural default that protects a function added later —
    // ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ... FROM PUBLIC is a silent no-op. A
    // function created and not explicitly REVOKEd is executable by PUBLIC, which is how
    // V2's cross-user deletion was reproduced. This control is the posture check standing
    // in for a protection that does not exist.
    setup: `create function public.${PROBE_PREFIX}fn() returns integer
              language sql immutable as $fn$ select 1 $fn$;`,
    expect: `EXECUTE granted to PUBLIC: ${PROBE_PREFIX}fn()`,
    absent: ['not forced-RLS and not exempt', 'view without security_invoker'],
  },
  {
    name: 'a table reachable by statesman_app without RLS enabled',
    rule: 'rule 1 REACHABILITY',
    setup: `create table public.${PROBE_PREFIX}reach (
              id uuid primary key, user_id uuid not null);
            grant select on public.${PROBE_PREFIX}reach to statesman_app;`,
    expect: `reachable without forced RLS + policy: ${PROBE_PREFIX}reach`,
    absent: ['view without security_invoker', 'is not STABLE'],
  },
  {
    name: 'a public table that is neither forced-RLS nor in posture_exempt_table',
    rule: 'rule 2 ENUMERATION',
    // No grants at all, so rule 1 cannot see it: this is the "a new table fails by
    // default" leg, and the `absent` entry is what distinguishes it from the control
    // above rather than duplicating it.
    setup: `create table public.${PROBE_PREFIX}unprot (id uuid primary key);`,
    expect: `not forced-RLS and not exempt: ${PROBE_PREFIX}unprot`,
    absent: ['reachable without forced RLS + policy'],
  },
  {
    name: 'a view over decision created WITHOUT security_invoker=true',
    rule: 'rule 5 VIEWS (V11)',
    // V11: a view over an RLS table runs with the VIEW OWNER's privileges by default, so
    // a view owned by statesman_owner is a tenancy bypass with a SQL interface.
    setup: `create view public.${PROBE_PREFIX}view as select id from public.decision;`,
    expect: `view without security_invoker=true: ${PROBE_PREFIX}view`,
    // relkind 'v' is outside rules 1-3, which enumerate 'r' and 'p' only.
    absent: ['reachable without forced RLS + policy', 'not forced-RLS and not exempt'],
  },
  {
    name: 'app.require_user_id() redefined as IMMUTABLE',
    rule: 'rule 6 VOLATILITY',
    // An IMMUTABLE identity accessor may be constant-folded and cached across prepared
    // statements, so one session's user id can be planned into another's query.
    setup: `create or replace function app.require_user_id() returns uuid
              language plpgsql immutable set search_path = pg_catalog as $rui$
            declare v text := current_setting('app.current_user_id', true);
            begin
              if v is null or v = '' then
                raise exception 'no user context' using errcode = '28000';
              end if;
              return v::uuid;
            end $rui$;`,
    expect: 'app.require_user_id() is not STABLE',
    absent: ['reachable without forced RLS + policy', 'view without security_invoker'],
  },
  {
    name: 'a policy with USING (true)',
    rule: 'rule 8 POLICY SHAPE (V20)',
    // V20: pg_policies.qual is NULL for INSERT-only policies, so a soundness query that
    // reads only `qual` flags every INSERT policy and aborts. Rule 8 reads both columns,
    // which is why this control has to assert the named policy and not just "it raised".
    setup: `create policy ${PROBE_PREFIX}bad on public.decision using (true);`,
    expect: `policy not scoped by require_user_id(): public.decision.${PROBE_PREFIX}bad`,
    absent: ['reachable without forced RLS + policy', 'is not STABLE'],
  },
]

/**
 * Functions in schema app or public that PUBLIC can execute. The primary control for the
 * V30 hazard; see the test below for why it cannot be delegated to a default privilege.
 */
const PUBLIC_EXECUTE_QUERY = `select 'offenders',
         count(*)::text,
         coalesce(string_agg(n.nspname || '.' || p.proname, ',' order by p.proname),
                  '<none>')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('app', 'public')
     and has_function_privilege('public', p.oid, 'EXECUTE');`

beforeAll(async () => {
  // Charge CREATE DATABASE ... TEMPLATE to the hook's 120 s budget, not a test's 30 s.
  await ensureWorkerDatabase()
}, 120_000)

describe('[NFR-01] [NFR-02] the security posture checker', () => {
  it('passes against the clean migrated schema (the negative control)', async () => {
    // This is not a formality. Without it, every "it raised ST099" below is satisfied by
    // a checker that raises unconditionally, and the six controls would all pass against
    // a function whose body were `raise exception ... using errcode = 'ST099'`.
    const clean = await probePosture('')
    expect(
      clean.sqlstate,
      `app.verify_security_posture() failed on the unmodified schema: ${clean.message}`,
    ).toBe(CLEAN)
    expect(clean.message).toBe('')
  })

  for (const control of CONTROLS) {
    it(`raises ST099 for ${control.name} — ${control.rule}`, async () => {
      const violated = await probePosture(control.setup)

      expect(
        violated.sqlstate,
        `the posture check reported ${violated.sqlstate} rather than ${POSTURE_FAILED} ` +
          `for ${control.name}. Message: ${violated.message}`,
      ).toBe(POSTURE_FAILED)

      // The message must name THIS violation. A checker that raises for some other
      // reason, or a control whose setup silently did nothing, is caught here and not by
      // the SQLSTATE.
      expect(
        violated.message,
        `${control.rule} did not report the violation it exists to catch. ` +
          `Message: ${violated.message}`,
      ).toContain(control.expect)

      // ... and must NOT name the ones it is being distinguished from, so two controls
      // cannot both be passing on the strength of a single rule firing.
      for (const fragment of control.absent) {
        expect(
          violated.message,
          `${control.rule}: the message also reported '${fragment}', so this control is ` +
            'not attributable to the rule it names',
        ).not.toContain(fragment)
      }

      // The violation was introduced inside a transaction that the helper rolled back.
      // Re-probing the clean schema afterwards is the evidence: if the rollback had not
      // taken, this would now carry the same ST099 and the remaining tests in this worker
      // would be measuring a contaminated database.
      const after = await probePosture('')
      expect(
        after.sqlstate,
        `the ${control.rule} control leaked out of its rolled-back transaction: ` +
          after.message,
      ).toBe(CLEAN)
    })
  }

  it('still passes after every control has run', async () => {
    // Vitest may run the file's tests in order, but the ordering is not the assertion —
    // the per-control re-probe above is. This is the end-state check for the worker
    // database that the rest of the suite shares (isolate: false).
    const final = await probePosture('')
    expect(final.sqlstate, final.message).toBe(CLEAN)
    expect(final.message).toBe('')
  })
})

describe('[NFR-02] no function in schema app or public is executable by PUBLIC', () => {
  /**
   * This assertion is the PRIMARY control, not a backstop.
   *
   * V30, measured: `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`
   * is a silent no-op. Issued by the owner role in the canonical form against a single
   * schema, `pg_default_acl` stayed empty and a function created afterwards still had
   * `proacl = NULL` with `has_function_privilege('public', oid, 'execute') = true`. The
   * instrument was validated the only way it can be: an explicit REVOKE on the same
   * function flipped the privilege to false and wrote `{sp_owner=X/sp_owner}`.
   *
   * The reason is structural. REVOKE only deletes rows from `pg_default_acl`; there is no
   * representation for a NEGATIVE default, so the built-in PUBLIC EXECUTE default cannot
   * be removed. (By contrast the GRANT form does apply, and the ACL it writes carries the
   * leading `=X` — PUBLIC — straight in from that same built-in default.)
   *
   * So there is no structural protection to lean on, and "every migration ends with an
   * explicit REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ... FROM PUBLIC" is a convention
   * that a future migration can forget. This query, and posture rule 4, are what catch
   * that — which is why the control below matters: a query that can never find an
   * offender is indistinguishable from a schema that has none.
   */
  it('finds no offender, and finds one as soon as a function is created', async () => {
    const clean = await ownerQuery(PUBLIC_EXECUTE_QUERY)
    const cleanRow = clean.find((r) => r[0] === 'offenders')
    expect(cleanRow, 'the offender query returned no labelled row').toBeDefined()
    expect(
      cleanRow?.[2],
      'a function in schema app or public is executable by PUBLIC. V2 reproduced ' +
        'cross-user deletion through exactly this, and V30 proved there is no default ' +
        'privilege that would have prevented it.',
    ).toBe('<none>')
    expect(cleanRow?.[1]).toBe('0')

    // THE POSITIVE CONTROL, in a rolled-back transaction. The same query, the same role,
    // the same database — the only change is one newly created function, which by V2
    // carries proacl = NULL and is therefore executable by PUBLIC. If the query cannot
    // see it, the clean result above is not evidence of anything.
    const probed = await ownerQuery(
      `begin;
       create function public.${PROBE_PREFIX}control() returns integer
         language sql immutable as $ctl$ select 1 $ctl$;
       ${PUBLIC_EXECUTE_QUERY}
       rollback;`,
    )
    const probedRow = probed.find((r) => r[0] === 'offenders')
    expect(probedRow, 'the offender query returned no labelled row under the control')
      .toBeDefined()
    expect(
      probedRow?.[2],
      'a freshly created function was NOT reported as PUBLIC-executable, so this query ' +
        'cannot detect the violation it is the primary control for (V30)',
    ).toBe(`public.${PROBE_PREFIX}control`)
    expect(probedRow?.[1]).toBe('1')

    // And the control did not survive its rollback.
    const after = await ownerQuery(PUBLIC_EXECUTE_QUERY)
    expect(after.find((r) => r[0] === 'offenders')?.[2]).toBe('<none>')
  })
})
