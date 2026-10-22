/**
 * Controls for app.verify_rest_exposure() — the four rules that make exposing schema `app`
 * to PostgREST safe.                                                    [NFR-01] [NFR-02]
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * 20261022160000 exposes schema `app` over HTTP. Before it, the lifecycle write path was
 * unreachable from the browser — MEASURED against the live project as
 * `PGRST106 Invalid schema: app`, with the control that the same call without
 * `Content-Profile` returned a different code — so `app.submit_decision`,
 * `app.append_revision` and `app.stamp_milestone` could not be called at all and every
 * submit would have failed. Nothing in this suite would have noticed: the integration tests
 * speak to Postgres directly and never cross PostgREST.
 *
 * Fixing that widened the public surface, and `app.verify_rest_exposure()` is what keeps it
 * narrow. This file is the proof that the keeper works. `migrate.sh` printing
 * "rest exposure OK" against a correct schema demonstrates nothing: a function whose body
 * were `begin return; end` prints exactly the same thing. Each rule below is therefore
 * violated deliberately, one at a time, and must report ITS OWN text.
 *
 * ---------------------------------------------------------------------------
 * EVERY CONTROL ASSERTS ITS OWN FRAGMENT **AND** THE ABSENCE OF THE OTHERS
 * ---------------------------------------------------------------------------
 * Copied deliberately from posture-controls.test.ts, for the reason stated there: "it
 * raised ST097" is satisfied by a checker that always raises, and by one rule's control
 * passing on another rule's violation. Attribution is the whole value.
 *
 * ---------------------------------------------------------------------------
 * ROLE STATE IS CLUSTER-WIDE, SO EVERY SETUP IS ROLLED BACK
 * ---------------------------------------------------------------------------
 * Rule E1 reads `pg_roles.rolconfig` for `authenticator`, and E2 reads schema USAGE. Those
 * live in the catalogue the whole cluster shares, not in this worker's database, so a
 * committed setup here would fail the gate in every other worker at once — the exact
 * cross-worker failure posture-controls.test.ts records having been MEASURED. Both are
 * transactional, an uncommitted catalogue row is invisible to other sessions, and
 * `afterAll` reads the state back to prove nothing escaped.
 *
 * Rule E1's setup needs the bootstrap superuser: `pgrst.db_schemas` is a custom GUC
 * placeholder and PostgreSQL 17 restricts `ALTER ROLE … SET` on a placeholder to a
 * superuser. That is the same privilege the emulated `postgres` lacks and the live
 * project's `postgres` has through `supabase_privileged_role`, and it is why the migration
 * carries an exception handler rather than assuming the statement can run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureWorkerDatabase, ownerQuery, queryRows, workerDatabaseName } from './support/db'

interface Probe {
  readonly sqlstate: string
  readonly message: string
  readonly rows: readonly string[][]
}

const CLEAN = '00000'
const REST_FAILED = 'ST097'

/**
 * The fragments the four rules actually emit, read back from messages the function
 * produced rather than transcribed from its source.
 */
const FRAGMENT = {
  e1: 'rule E1: authenticator has no pgrst.db_schemas naming schema app',
  e2: 'holds USAGE on schema app',
  e3: 'which is not in public.posture_rest_allow',
  e3b: 'rule E3b: public.posture_rest_allow registers',
  e4: 'can reach relation app.',
} as const

const ALL_FRAGMENTS: readonly string[] = Object.values(FRAGMENT)

const PROBE_SCRIPT = `do $rest$ begin
  perform app.verify_rest_exposure();
  perform set_config('probe.sqlstate', '00000', true);
  perform set_config('probe.message', '', true);
exception when others then
  perform set_config('probe.sqlstate', sqlstate, true);
  perform set_config('probe.message',
                     replace(replace(SQLERRM, E'\\n', ' '), '|', '/'), true);
end $rest$;
select 'probe',
       coalesce(current_setting('probe.sqlstate', true), '<unset>'),
       coalesce(current_setting('probe.message',  true), '<unset>');`

function readProbe(rows: readonly string[][]): Probe {
  const row = rows.find((r) => r[0] === 'probe')
  const sqlstate = row?.[1]
  if (row === undefined || sqlstate === undefined) {
    throw new Error(
      'the rest-exposure probe returned no labelled row — the script never reached its ' +
        'SELECT. A missing label is a harness failure and is never a pass.',
    )
  }
  return { sqlstate, message: row[2] ?? '', rows }
}

/** As `postgres`, the role migrate.sh runs the gate as. */
async function probeAsPostgres(setupSql: string): Promise<Probe> {
  return readProbe(await ownerQuery(`begin;\n${setupSql}\n${PROBE_SCRIPT}\nrollback;`))
}

/** As the bootstrap superuser, for setups `postgres` cannot perform. */
async function probeAsAdmin(setupSql: string): Promise<Probe> {
  await ensureWorkerDatabase()
  return readProbe(
    await queryRows(`begin;\n${setupSql}\n${PROBE_SCRIPT}\nrollback;`, {
      db: workerDatabaseName(),
    }),
  )
}

/**
 * Assert exactly one rule fired. `absent` is the half that makes the control attributable.
 */
function expectOnly(probe: Probe, expected: string): void {
  expect(probe.sqlstate, `expected ST097, got ${probe.sqlstate}: ${probe.message}`).toBe(
    REST_FAILED,
  )
  expect(probe.message).toContain(expected)
  for (const other of ALL_FRAGMENTS) {
    if (other === expected) continue
    expect(
      probe.message,
      `this control must report ONLY its own rule, but also reported: ${other}`,
    ).not.toContain(other)
  }
}

describe('app.verify_rest_exposure() — the REST surface gate', () => {
  beforeAll(async () => {
    await ensureWorkerDatabase()
  })

  /**
   * THE INSTRUMENT. Every control below reads "the gate fired"; this one reads "the gate is
   * silent when nothing is wrong". Without it, a function that raised unconditionally would
   * make all nine controls pass.
   */
  it('[NFR-01] is silent on the unmodified schema, as postgres AND as the superuser', async () => {
    const asPostgres = await probeAsPostgres('')
    expect(
      asPostgres.sqlstate,
      `the gate failed on an unmodified schema: ${asPostgres.message}`,
    ).toBe(CLEAN)

    const asAdmin = await probeAsAdmin('')
    expect(asAdmin.sqlstate, `as superuser: ${asAdmin.message}`).toBe(CLEAN)
  })

  /**
   * E1. The failure this whole migration exists to prevent: the exposure silently absent,
   * which on the live project meant every submit answering PGRST106.
   */
  it('[NFR-01] E1 fires when pgrst.db_schemas stops naming app', async () => {
    const probe = await probeAsAdmin(
      "alter role authenticator set pgrst.db_schemas = 'public, graphql_public';",
    )
    expectOnly(probe, FRAGMENT.e1)
    // The recorded value is echoed, so the message says what it found and not only that it
    // was unhappy.
    expect(probe.message).toContain('public, graphql_public')
  })

  it('[NFR-01] E1 fires when pgrst.db_schemas is absent entirely, and says so', async () => {
    const probe = await probeAsAdmin('alter role authenticator reset pgrst.db_schemas;')
    expectOnly(probe, FRAGMENT.e1)
    expect(probe.message).toContain('<unset>')
  })

  /**
   * E1's NEGATIVE control, and it is not redundant with the instrument test. A rule that
   * fired on any value at all would pass both tests above. This asserts that a list which
   * names `app` among others is accepted — i.e. the rule reads membership, not equality.
   */
  it('[NFR-01] E1 accepts app among other schemas, so it tests membership not equality', async () => {
    const probe = await probeAsAdmin(
      "alter role authenticator set pgrst.db_schemas = 'public, graphql_public, app, storage';",
    )
    expect(probe.sqlstate, `expected clean, got: ${probe.message}`).toBe(CLEAN)
  })

  /** E2, both roles, because the rule enumerates two and a loop can be wrong for one. */
  it('[NFR-02] E2 fires when anon is granted USAGE on schema app', async () => {
    const probe = await probeAsPostgres('grant usage on schema app to anon;')
    expectOnly(probe, FRAGMENT.e2)
    expect(probe.message).toContain('anon holds USAGE on schema app')
  })

  it('[NFR-02] E2 fires when service_role is granted USAGE on schema app', async () => {
    const probe = await probeAsPostgres('grant usage on schema app to service_role;')
    expectOnly(probe, FRAGMENT.e2)
    expect(probe.message).toContain('service_role holds USAGE on schema app')
  })

  /**
   * E3. A new definer function in `app` with a careless grant is an internet-reachable
   * endpoint the moment the schema is exposed, and this is the rule that notices.
   */
  it('[NFR-02] E3 fires on an app function granted to a client role but unregistered', async () => {
    const probe = await probeAsPostgres(`
      create function app.re_probe_unregistered() returns int
        language sql immutable set search_path = pg_catalog as $f$ select 1 $f$;
      grant execute on function app.re_probe_unregistered() to authenticated;`)
    expectOnly(probe, FRAGMENT.e3)
    expect(probe.message).toContain('app.re_probe_unregistered()')
    expect(probe.message).toContain('authenticated')
  })

  /**
   * E3b, the other direction. A registry allowed to carry rows for grants that no longer
   * exist becomes a place to put whatever is currently failing — and, worse, it hides the
   * case where the application's own grant was lost and the product is broken.
   */
  it('[NFR-02] E3b fires when a registered entry point loses its grant', async () => {
    const probe = await probeAsPostgres(
      'revoke execute on function app.stamp_milestone(uuid,text) from authenticated;',
    )
    expectOnly(probe, FRAGMENT.e3b)
    expect(probe.message).toContain('stamp_milestone')
  })

  /**
   * E4. The hole the exposure actually opened: posture rule 1 scans `public` ONLY, so a
   * table added to `app` would be served as a REST collection with no rule requiring RLS on
   * it. Verified here as a real gap, not a hypothetical one.
   */
  it('[NFR-02] E4 fires on a client-reachable relation in schema app', async () => {
    const probe = await probeAsPostgres(`
      create table app.re_probe_table (id int primary key);
      grant select on app.re_probe_table to authenticated;`)
    expectOnly(probe, FRAGMENT.e4)
    expect(probe.message).toContain('app.re_probe_table')
  })

  /**
   * E4's positive control: an owner-only table in `app` is NOT a violation. PostgREST hides
   * a relation from a role that cannot read it, so forbidding every relation outright would
   * be stricter than the property that matters — and a rule stricter than its own rationale
   * gets relaxed by whoever trips it next.
   */
  it('[NFR-02] E4 permits an owner-only relation in app, which PostgREST cannot serve', async () => {
    const probe = await probeAsPostgres(
      'create table app.re_probe_internal (id int primary key);',
    )
    expect(
      probe.sqlstate,
      `an owner-only app table must not trip E4, but got: ${probe.message}`,
    ).toBe(CLEAN)
  })

  afterAll(async () => {
    // Nothing above may have escaped its transaction. Role state is cluster-wide, so a
    // leaked ALTER ROLE or GRANT would fail this gate in every other database.
    const rows = await ownerQuery(`select 'state',
        coalesce((select substring(cfg from '^pgrst[.]db_schemas=(.*)$')
                    from pg_roles r, unnest(coalesce(r.rolconfig,'{}'::text[])) cfg
                   where r.rolname='authenticator' and cfg like 'pgrst.db_schemas=%'
                   limit 1), '<unset>'),
        has_schema_privilege('anon','app','USAGE')::text,
        has_schema_privilege('service_role','app','USAGE')::text,
        (select count(*)::text from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='app' and c.relname like 're_probe_%');`)
    const row = rows.find((r) => r[0] === 'state')
    expect(row, 'the teardown readback produced no row').toBeDefined()
    expect(row?.[1], 'pgrst.db_schemas was left modified by a control').toContain('app')
    expect(row?.[2], 'a control leaked USAGE on app to anon').toBe('false')
    expect(row?.[3], 'a control leaked USAGE on app to service_role').toBe('false')
    expect(row?.[4], 'a control leaked a probe relation into schema app').toBe('0')
  })
})

/**
 * The two pure functions behind rule E1 and behind the migration's append.
 *
 * These exist as functions precisely so they can be tested: the ALTER ROLE statement they
 * feed cannot run on the local emulation, so logic left inline would have been exercised
 * against the live project only — which is to say, never, in any test.
 */
describe('app.pgrst_schema_exposed() and app.pgrst_schema_list_with()', () => {
  beforeAll(async () => {
    await ensureWorkerDatabase()
  })

  it('[NFR-01] decides membership by trimmed exact match, never by substring', async () => {
    const cases: readonly { readonly recorded: string | null; readonly want: boolean }[] = [
      { recorded: null, want: false },
      { recorded: '', want: false },
      { recorded: 'public', want: false },
      { recorded: 'public, graphql_public', want: false },
      // The substring traps. An `exposed like '%app%'` implementation passes every case
      // above and fails these two, which is why they are here.
      { recorded: 'public, application', want: false },
      { recorded: 'public, app_private', want: false },
      // The accept half. Without it a function returning constant false passes everything
      // above.
      { recorded: 'app', want: true },
      { recorded: 'public, app', want: true },
      { recorded: 'public,app', want: true },
      { recorded: '  public ,  app  ', want: true },
      { recorded: 'app, public', want: true },
    ]

    const values = cases
      .map(
        (c, i) =>
          `(${i}, ${c.recorded === null ? 'null' : `'${c.recorded.replace(/'/g, "''")}'`})`,
      )
      .join(', ')
    const rows = await ownerQuery(
      `select i::text, app.pgrst_schema_exposed(rec, 'app')::text
         from (values ${values}) as v(i, rec) order by i;`,
    )
    const got = new Map(rows.filter((r) => r.length >= 2).map((r) => [r[0], r[1]]))
    cases.forEach((c, i) => {
      expect(
        got.get(String(i)),
        `pgrst_schema_exposed(${JSON.stringify(c.recorded)}, 'app')`,
      ).toBe(String(c.want))
    })
  })

  it('[NFR-01] appends without overwriting, and is idempotent when already present', async () => {
    const rows = await ownerQuery(`select 'r',
        app.pgrst_schema_list_with(null, 'app'),
        app.pgrst_schema_list_with('public, graphql_public', 'app'),
        app.pgrst_schema_list_with('public, graphql_public, app', 'app'),
        app.pgrst_schema_list_with('public, storage, graphql_public', 'app'),
        app.pgrst_schema_list_with('', 'app');`)
    const r = rows.find((x) => x[0] === 'r')
    expect(r, 'no labelled row').toBeDefined()
    // A null or empty recorded list falls back to the MEASURED platform default, which is
    // what the PGRST106 hint named, rather than to a value we invented.
    expect(r?.[1]).toBe('public, graphql_public, app')
    expect(r?.[2]).toBe('public, graphql_public, app')
    // Idempotent: already present means unchanged, not appended twice.
    expect(r?.[3]).toBe('public, graphql_public, app')
    // Non-destructive: a schema this migration did not author survives.
    expect(r?.[4]).toBe('public, storage, graphql_public, app')
    expect(r?.[5]).toBe('public, graphql_public, app')
  })
})
