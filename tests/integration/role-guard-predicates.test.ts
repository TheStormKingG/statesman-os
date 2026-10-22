/**
 * [NFR-01] [NFR-02] The privileged-role rule, after ADR-0015 changed the privilege model.
 *
 * ===========================================================================
 * WHY THIS FILE IS A REWRITE AND NOT A RENAME
 * ===========================================================================
 * The pre-port file asserted that the production role guard refused each kind of
 * privileged role, and its value was that it checked PROPERTIES rather than names: it
 * proved the catch came from the ownership-reachability clause by asserting the message
 * did NOT mention SUPERUSER or BYPASSRLS. That discipline is kept. Everything the
 * properties were measured against has changed:
 *
 *   statesman_app       -> `authenticated`
 *   statesman_owner     -> `postgres`, WITH A DIFFERENT ATTRIBUTE SET
 *   statesman_migrator  -> NOTHING. Supabase has no non-bypassrls owner role.
 *
 * A search-and-replace would have produced a green file that enforces nothing, in three
 * separate ways, each measured here rather than assumed:
 *
 *  1. `statesman_owner` was `rolbypassrls = false` (V34). `postgres` is
 *     `rolbypassrls = TRUE` while `rolsuper` is FALSE, so it reads as a restricted role
 *     and is the role the CLI and the dashboard SQL editor use by default. Renaming the
 *     old "refuses statesman_migrator for OWNERSHIP ONLY" baseline would have kept a
 *     passing test whose entire claim — that the catch was attributable to the ownership
 *     clause — had become false, because `postgres` trips BYPASSRLS, OWNS_PUBLIC_RELATION,
 *     CREATEROLE and CREATEDB simultaneously. MEASURED below, as an exact reason set.
 *
 *  2. The carriers are gone. The old file ALTERed `statesman_owner` to hold CREATEROLE and
 *     GRANTed `pg_read_all_data` to `statesman_migrator`, because the predefined `pg_*`
 *     roles cannot be altered. Neither role has a Supabase equivalent that may be mutated:
 *     `postgres` and `service_role` are platform-mandated and allowlisted by posture rule
 *     11, and mutating `authenticated` is what the old file itself forbade.
 *
 *  3. There is no production guard left to point at. ADR-0015 retires `src/server/db/**`;
 *     `assertUnprivilegedOnce` and the rule it reads now live under
 *     `tests/support/scoped-pg/`, TEST-ONLY. What survives of the property is posture
 *     rules 11 and 12 (database-side, controlled in posture-controls.test.ts) and the
 *     harness guard `assertTestConnectionIdentity` (mutation M22). This file covers the
 *     RULE both guards are built from, plus the guards' accept/refuse behaviour.
 *
 * ===========================================================================
 * WHY EVERY MUTATION HERE IS EITHER ROLLED BACK OR POSTURE-INVISIBLE
 * ===========================================================================
 * Role state is CLUSTER-WIDE and posture rules 11 and 12 enumerate it, so a committed
 * scratch role with BYPASSRLS or with `pg_read_all_data` membership fails
 * `app.verify_security_posture()` in EVERY database at once — including the clean-schema
 * instrument tests in posture.test.ts, posture-controls.test.ts and
 * scenario-content.test.ts, which run in other Vitest workers at the same time.
 *
 * This is not a precaution. MEASURED on the pre-port version of this file, in the baseline
 * run that preceded this rewrite: while it held `grant pg_write_all_data to
 * statesman_migrator`, a concurrent worker's "instrument: both probes report CLEAN"
 * assertion failed with `rule 12: role statesman_migrator holds pg_write_all_data by
 * membership and is not allowlisted`. The old file's own comment anticipated exactly this
 * hazard for `statesman_app` and the port's new rules widened it to every role.
 *
 * So the properties are split by what they cost to observe:
 *
 *   ROLLED BACK (the rule, in one transaction, as the bootstrap superuser). Scratch roles
 *   are created, measured and dropped inside a transaction that is rolled back. Another
 *   session cannot see an uncommitted role, so there is no window in which a sibling
 *   worker's posture check can see one. This is how BYPASSRLS, PG_READ_ALL_DATA and
 *   PG_WRITE_ALL_DATA are exercised, because a committed carrier for those three IS a
 *   posture violation by design.
 *
 *   COMMITTED, THEN DROPPED (the guards, end to end, through the real `withUser`). A role
 *   holding CREATEROLE or CREATEDB, or owning one table in this worker's own database,
 *   trips NO posture rule and is reachable by nobody but the scratch login role it is
 *   granted to — so it is invisible to every other worker, and a real connection can be
 *   opened as it. `pg_hba` is `trust` locally, which is why connecting as an arbitrary
 *   role works at all (V1) and is itself the hazard this guard exists to catch.
 *
 * ===========================================================================
 * WHAT IS STILL A COPY, AND WHAT PROVES THE COPY
 * ===========================================================================
 * The predicate and its reason codes are IMPORTED from
 * `tests/support/scoped-pg/privileged-role.ts`, so the SQL under test here is the same SQL
 * both guards run and a weakened predicate fails these assertions (mutations M9-M13).
 * The one line this file restates is `pg_has_role(…, 'USAGE') or pg_has_role(…, 'MEMBER')`
 * — the reachability clause, which pool.ts and db.ts each spell out for `current_user`.
 * It is restated for an arbitrary candidate role, and the end-to-end refusal of `postgres`
 * below is what proves the REAL clause behaves the same way: `postgres` holds
 * `service_role` with `inherit_option = false`, so `pg_has_role(…,'USAGE')` is FALSE and
 * only the MEMBER leg can report it — and the real guard does report it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  EXPECTED_APP_ROLE,
  appDatabaseUrl,
  harnessEnv,
  migratorDatabaseUrl,
  migratorRole,
  ensureWorkerDatabase,
  ownerQuery,
  queryRows,
  releaseProductionPools,
  workerDatabaseName,
} from './support/db'
import { enterIdentityContext } from '../support/scoped-pg/session'
import { PrivilegeAssertionError, withUser } from '../support/scoped-pg'
import {
  PRIVILEGE_REASON_CODES,
  privilegedRolePredicateSql,
  privilegedRoleReasonTextSql,
} from '../support/scoped-pg/privileged-role'

/** An identity for `withUser`. It owns nothing; no leg of this file reaches user data. */
const USER_A = 'aaaaaaaa-0000-0000-0000-0000000c9a01'

/**
 * Scratch roles are named after this worker's database, so two workers can never pick the
 * same name even though the catalogue they are created in is shared.
 */
const SCRATCH_PREFIX = 'rgp_'
/** `\_` escapes the LIKE wildcard; standard_conforming_strings keeps the backslash. */
const SCRATCH_LIKE = String.raw`rgp\_%`

const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/

function scratch(kind: string): string {
  const name = `${SCRATCH_PREFIX}${kind}_${workerDatabaseName()}`
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`derived scratch role name is not a safe identifier: ${name}`)
  }
  return name
}

/**
 * The guard's reachability question, asked about an arbitrary role instead of
 * `current_user`.
 *
 * The predicate and the reason text come from the shared module; only the
 * `USAGE or MEMBER` clause is restated — see this file's header for what proves it.
 */
function reachabilitySql(candidate: string, label: string): string {
  if (!SAFE_IDENTIFIER.test(candidate)) {
    throw new Error(`reachabilitySql: '${candidate}' is not a safe role name`)
  }
  return `select 'reach', '${label}',
            coalesce(string_agg(p.rolname || ' [' || ${privilegedRoleReasonTextSql('p')} || ']',
                                ', ' order by p.rolname), '')
       from pg_roles p
      where p.rolname <> '${candidate}'
        and ${privilegedRolePredicateSql('p')}
        and (pg_has_role('${candidate}', p.oid, 'USAGE')
          or pg_has_role('${candidate}', p.oid, 'MEMBER'));`
}

// ---------------------------------------------------------------------------
// One rolled-back measurement of the rule against every property it names
// ---------------------------------------------------------------------------

const ROLE = {
  bypass: scratch('bypass'),
  createrole: scratch('createrole'),
  createdb: scratch('createdb'),
  owner: scratch('owner'),
  viewowner: scratch('viewowner'),
  member: scratch('member'),
  readall: scratch('readall'),
  writeall: scratch('writeall'),
} as const

const PROBE_TABLE = `rgp_owned_${workerDatabaseName()}`
const PROBE_VIEW = `rgp_ownedv_${workerDatabaseName()}`

interface RuleMeasurement {
  /** role name -> the `+`-joined reason codes the shared rule reports. */
  readonly reasons: ReadonlyMap<string, string>
  /** label -> what a connection as that candidate could SET ROLE to. */
  readonly reach: ReadonlyMap<string, string>
  /** `pg_has_role(member, service_role, 'USAGE' | 'MEMBER')`. */
  readonly memberUsage: boolean
  readonly memberMember: boolean
  /** Scratch roles still present AFTER the explicit DROPs, inside the transaction. */
  readonly remainingInTransaction: string
}

let measurement: Promise<RuleMeasurement> | undefined

/**
 * Create one scratch role per property, measure the shared rule against all of them, drop
 * them explicitly, and roll the whole thing back.
 *
 * Both halves of the teardown are deliberate. The explicit DROPs prove the file cleans up
 * after itself rather than relying on the rollback; `remainingInTransaction` reads the
 * catalogue back to prove the DROPs took effect, which `DROP ROLE` returning successfully
 * does not (V7: a statement that reports success is not a measurement). The ROLLBACK is
 * what keeps the window in which a sibling worker could observe a bypassrls role at zero.
 */
function measureRule(): Promise<RuleMeasurement> {
  measurement ??= (async () => {
    await ensureWorkerDatabase()
    const admin = harnessEnv().TEST_ADMIN_ROLE
    const named = [
      EXPECTED_APP_ROLE,
      'anon',
      'postgres',
      'service_role',
      'pg_read_all_data',
      'pg_write_all_data',
      admin,
      ...Object.values(ROLE),
    ]
    const inList = named.map((r) => `'${r}'`).join(', ')

    const rows = await queryRows(
      `begin;
       create role ${ROLE.bypass}     nologin bypassrls;
       create role ${ROLE.createrole} nologin createrole;
       create role ${ROLE.createdb}   nologin createdb;
       create role ${ROLE.owner}      nologin;
       create role ${ROLE.viewowner}  nologin;
       create role ${ROLE.member}     nologin;
       create role ${ROLE.readall}    nologin;
       create role ${ROLE.writeall}   nologin;
       -- V3's shape exactly: the membership is NOINHERIT, so the attribute half of the
       -- rule sees nothing while SET ROLE still succeeds.
       grant service_role      to ${ROLE.member}   with inherit false;
       grant pg_read_all_data  to ${ROLE.readall};
       grant pg_write_all_data to ${ROLE.writeall};
       -- Ownership, for V4 (a table) and V11 (a view, whose owner lends it their rights).
       create table public.${PROBE_TABLE} (id uuid primary key, user_id uuid not null);
       alter table public.${PROBE_TABLE} owner to ${ROLE.owner};
       create view public.${PROBE_VIEW} with (security_invoker=true) as select 1 as x;
       alter view public.${PROBE_VIEW} owner to ${ROLE.viewowner};

       select 'reasons', r.rolname, ${privilegedRoleReasonTextSql('r')}
         from pg_roles r where r.rolname in (${inList}) order by r.rolname;

       ${reachabilitySql(EXPECTED_APP_ROLE, 'authenticated')}
       ${reachabilitySql(ROLE.member, 'member')}
       ${reachabilitySql(ROLE.readall, 'readall')}
       ${reachabilitySql(ROLE.writeall, 'writeall')}

       select 'v3',
              pg_has_role('${ROLE.member}', 'service_role', 'USAGE')::text,
              pg_has_role('${ROLE.member}', 'service_role', 'MEMBER')::text;

       drop view  public.${PROBE_VIEW};
       drop table public.${PROBE_TABLE};
       revoke service_role      from ${ROLE.member};
       revoke pg_read_all_data  from ${ROLE.readall};
       revoke pg_write_all_data from ${ROLE.writeall};
       drop role ${Object.values(ROLE).join(', ')};
       select 'remaining',
              coalesce(string_agg(rolname, ',' order by rolname), '<none>')
         from pg_roles where rolname like '${SCRATCH_LIKE}';
       rollback;`,
      { db: workerDatabaseName() },
    )

    const reasons = new Map<string, string>()
    const reach = new Map<string, string>()
    let v3: string[] | undefined
    let remaining: string | undefined
    for (const row of rows) {
      if (row[0] === 'reasons' && row[1] !== undefined) reasons.set(row[1], row[2] ?? '')
      if (row[0] === 'reach' && row[1] !== undefined) reach.set(row[1], row[2] ?? '')
      if (row[0] === 'v3') v3 = row
      if (row[0] === 'remaining') remaining = row[1]
    }
    if (v3 === undefined || remaining === undefined) {
      throw new Error(
        `the rule measurement did not run to completion: ${JSON.stringify(rows)}. A ` +
          'missing label means the script aborted before its SELECTs, which is a harness ' +
          'failure and never a pass.',
      )
    }
    return {
      reasons,
      reach,
      memberUsage: v3[1] === 'true',
      memberMember: v3[2] === 'true',
      remainingInTransaction: remaining,
    }
  })().catch((error: unknown) => {
    measurement = undefined
    throw error
  })
  return measurement
}

/** The reason set the shared rule reports for `role`, asserted to have been measured. */
function reasonsFor(m: RuleMeasurement, role: string): string {
  const value = m.reasons.get(role)
  if (value === undefined) {
    throw new Error(
      `no reason row was measured for role '${role}'. An ABSENT row is not an empty ` +
        'reason set: it means the role does not exist, and reading it as "not privileged" ' +
        'is how a control stops being able to fail.',
    )
  }
  return value
}

// ---------------------------------------------------------------------------
// Driving the real guard
// ---------------------------------------------------------------------------

/** A URL for this worker's database naming `role`, from the configured host and port. */
function urlAsRole(role: string): string {
  if (!SAFE_IDENTIFIER.test(role)) {
    throw new Error(`urlAsRole: '${role}' is not a safe role name`)
  }
  const url = new URL(harnessEnv().TEST_APP_DATABASE_URL_BASE)
  url.username = role
  url.pathname = `/${workerDatabaseName()}`
  return url.toString()
}

/**
 * Drive the REAL `withUser` against an arbitrary connection URL and report what happened.
 *
 * The transaction preamble is NOT reimplemented — `withUser` does all of it — so this
 * cannot pass while the guard's own sequencing is broken. `ran` reports whether the
 * callback was reached: a guard that rejects only after the callback has touched user data
 * has protected nothing.
 */
async function withUserAgainst(url: string): Promise<{ ran: boolean; error: unknown }> {
  process.env['APP_DATABASE_URL'] = url
  await releaseProductionPools()
  let ran = false
  let error: unknown
  try {
    await enterIdentityContext(USER_A, () =>
      withUser(async (db) => {
        ran = true
        await db.queryOne('select 1 as reached')
      }),
    )
  } catch (caught: unknown) {
    error = caught
  }
  return { ran, error }
}

/**
 * The guard's VIOLATION phrases, as it writes them.
 *
 * Asserting the absence of a bare code word does not work and is the kind of assertion
 * that cannot fail in the other direction either: every refusal ends with "The application
 * must connect as a non-owner role without BYPASSRLS.", so `not.toContain('BYPASSRLS')`
 * is false for every message the guard can produce. MEASURED — this file's first run
 * failed three legs on exactly that. The attribution has to be made against the phrase the
 * guard emits per violation, and against the bracketed reason code inside its reachability
 * list, which is where the per-role reasons appear.
 */
const VIOLATION = {
  superuser: 'the role is a SUPERUSER',
  bypassrls: 'the role has BYPASSRLS',
  owns: 'relation(s) in schema public',
  reachable: 'can SET ROLE to',
} as const

/** The guard's refusal message for a connection as `role`, asserted to exist. */
async function refusalFor(url: string): Promise<string> {
  const { ran, error } = await withUserAgainst(url)
  expect(error).toBeInstanceOf(PrivilegeAssertionError)
  expect(ran, 'the callback RAN before the guard refused the connection').toBe(false)
  return (error as PrivilegeAssertionError).message
}

/**
 * Create cluster state, run `fn`, and drop the state again.
 *
 * Only used for carriers that trip NO posture rule (CREATEROLE, CREATEDB, and ownership of
 * a table in this worker's own database), because this state IS committed and therefore
 * visible to every other session for the duration of one test. See the file header.
 */
async function withCommitted<T>(setup: string, teardown: string, fn: () => Promise<T>): Promise<T> {
  await queryRows(setup, { db: workerDatabaseName() })
  try {
    return await fn()
  } finally {
    // Close the pool that is connected AS the scratch role before dropping it, so the
    // teardown is not racing an idle connection.
    await releaseProductionPools()
    await queryRows(teardown, { db: workerDatabaseName() })
  }
}

/** A carrier role holding one attribute, reachable by SET ROLE only (NOINHERIT). */
function carrierSetup(login: string, carrier: string, attribute: string): string {
  return `create role ${carrier} nologin ${attribute};
          create role ${login} login;
          grant ${carrier} to ${login} with inherit false;`
}

function carrierTeardown(login: string, carrier: string): string {
  return `revoke ${carrier} from ${login};
          drop role if exists ${login};
          drop role if exists ${carrier};`
}

beforeAll(async () => {
  await ensureWorkerDatabase()
  // A scratch role left behind by a crashed run would make `create role` fail with a name
  // collision three tests later, so it is reported here rather than diagnosed there. The
  // names embed this worker's database, so a leftover can only come from another run.
  const stale = await queryRows(
    `select 'stale', coalesce(string_agg(rolname, ',' order by rolname), '<none>')
       from pg_roles where rolname like '${SCRATCH_LIKE}'`,
    { db: harnessEnv().TEST_ADMIN_DB },
  )
  const names = stale.find((r) => r[0] === 'stale')?.[1]
  if (names !== undefined && names !== '<none>') {
    throw new Error(
      `scratch roles from an earlier run are still in the cluster: ${names}. Every leg of ` +
        'this file drops its own roles, so a survivor means a run was killed mid-test. ' +
        `Drop them (\`drop role ${names.split(',').join(', ')}\`) and re-run.`,
    )
  }
}, 120_000)

afterAll(async () => {
  process.env['APP_DATABASE_URL'] = appDatabaseUrl()
  await releaseProductionPools()
})

describe('[NFR-01] [NFR-02] the privileged-role rule: every property, against scratch roles', () => {
  it('instrument: every scratch role was created, measured, and dropped inside the transaction', async () => {
    const m = await measureRule()
    // Without this, every "the rule reports X for role R" below could be satisfied by a
    // transaction that never created R: an absent row would read as an empty reason set.
    for (const role of Object.values(ROLE)) {
      expect(
        m.reasons.has(role),
        `no measurement for scratch role ${role} — the setup did not create it`,
      ).toBe(true)
    }
    expect(
      m.remainingInTransaction,
      'the explicit DROP ROLE statements did not remove every scratch role, read back ' +
        'from the catalogue rather than taken from DROP ROLE reporting success',
    ).toBe('<none>')
  })

  it('positive control: authenticated and anon are ORDINARY data roles — the rule reports nothing', async () => {
    const m = await measureRule()
    // THE CONTROL ON THE CONTROLS. Every assertion below says the rule reports a specific
    // code; this is what makes those assertions evidence rather than decoration, because a
    // predicate that were accidentally always-true (mutation M13 does exactly that to the
    // CREATEROLE clause) fails here.
    expect(reasonsFor(m, EXPECTED_APP_ROLE)).toBe('')
    expect(reasonsFor(m, 'anon')).toBe('')
    // ...and nothing privileged is reachable from the role the suite connects as, so the
    // reachability half is not silently reporting the whole cluster.
    expect(m.reach.get('authenticated')).toBe('')
  })

  it('postgres is reported for BYPASSRLS, ownership, CREATEROLE and CREATEDB — and NOT for SUPERUSER', async () => {
    const m = await measureRule()
    // The port's central fact, stated as an exact reason set rather than as prose.
    // `rolsuper` is FALSE on Supabase's `postgres`, so a guard written against SUPERUSER
    // would wave it through; BYPASSRLS is the attribute that catches it. The equality is
    // what asserts SUPERUSER is absent.
    expect(reasonsFor(m, 'postgres')).toBe(
      'BYPASSRLS+OWNS_PUBLIC_RELATION+CREATEROLE+CREATEDB',
    )
    expect(migratorRole(), 'the fixture-setup role is `postgres`, as ADR-0015 §4.1 says').toBe(
      'postgres',
    )
  })

  it('service_role is reported for BYPASSRLS alone, and the cluster superuser for SUPERUSER', async () => {
    const m = await measureRule()
    // `service_role` is NOLOGIN and owns nothing: bypassrls is its only property, so this
    // is the attribute clause in isolation on a real platform role.
    expect(reasonsFor(m, 'service_role')).toBe('BYPASSRLS')

    // The local cluster superuser exists on no Supabase project, but it is where a
    // mis-set TEST_APP_DATABASE_URL_BASE lands by accident (V1, `trust`), so the SUPERUSER
    // clause is still load-bearing locally.
    const admin = reasonsFor(m, harnessEnv().TEST_ADMIN_ROLE)
    expect(admin.startsWith('SUPERUSER'), `admin reasons were '${admin}'`).toBe(true)
    expect(admin).toContain('BYPASSRLS')
  })

  it('BYPASSRLS: a scratch role carrying the attribute is reported for BYPASSRLS alone', async () => {
    const m = await measureRule()
    expect(reasonsFor(m, ROLE.bypass)).toBe('BYPASSRLS')
  })

  it('CREATEROLE and CREATEDB are two predicates: each scratch role is reported for its own, not its neighbour', async () => {
    const m = await measureRule()
    // Kept as two assertions on two roles rather than one role with both attributes: a
    // single carrier would be reported as 'CREATEROLE+CREATEDB' and neither clause could
    // then be removed without the other noticing.
    expect(reasonsFor(m, ROLE.createrole)).toBe('CREATEROLE')
    expect(reasonsFor(m, ROLE.createdb)).toBe('CREATEDB')
  })

  it('OWNS_PUBLIC_RELATION: a table owner is reported for ownership ALONE, naming neither SUPERUSER nor BYPASSRLS', async () => {
    const m = await measureRule()
    // THE ASSERTION THE PRE-PORT FILE EXISTED FOR, and the one `postgres` can no longer
    // make: V4 says ownership bypasses RLS under ENABLE with no role attribute set, so a
    // guard built only from attributes misses it entirely. The scratch role has no
    // attributes at all, so an exact-equality here is the proof that the ownership clause
    // did the catching.
    expect(reasonsFor(m, ROLE.owner)).toBe('OWNS_PUBLIC_RELATION')
  })

  it('OWNS_PUBLIC_RELATION covers a VIEW owner as well as a table owner (V11)', async () => {
    const m = await measureRule()
    // V11: a view over an RLS table runs with the VIEW OWNER's privileges unless
    // security_invoker is set, so owning the view is owning the data it exposes. The probe
    // view is created WITH security_invoker=true, so this leg cannot be passing on the
    // strength of a misconfigured view — only on relkind 'v' being in the clause.
    expect(reasonsFor(m, ROLE.viewowner)).toBe('OWNS_PUBLIC_RELATION')
  })

  // V34 recorded `pg_read_all_data` and `pg_write_all_data` slipping through an
  // attribute-only predicate SEPARATELY, which is why the shared rule keeps them as two
  // reasons rather than one `rolname in (…)` — and why these are two tests rather than
  // one. With a single combined assertion, either clause could be removed and the other
  // would report the failure, so neither would have a control of its own. The predefined
  // roles are RESERVED (`ALTER ROLE pg_read_all_data …` is refused by the server), so the
  // rule matches them by name and membership is the only way to acquire them. Each
  // exact-equality is also what asserts the other code is absent.
  it('PG_READ_ALL_DATA is its own predicate (V34), reported for pg_read_all_data alone', async () => {
    const m = await measureRule()
    expect(reasonsFor(m, 'pg_read_all_data')).toBe('PG_READ_ALL_DATA')
  })

  it('PG_WRITE_ALL_DATA is its own predicate (V34), reported for pg_write_all_data alone', async () => {
    const m = await measureRule()
    expect(reasonsFor(m, 'pg_write_all_data')).toBe('PG_WRITE_ALL_DATA')
  })

  it('V3: a MEMBER of a bypassrls role has NO privileged attribute — the attribute half of the rule misses it and the reachability half is what catches it', async () => {
    const m = await measureRule()
    // This is the most instructive leg in the file. The scratch role was granted
    // `service_role` WITH INHERIT FALSE, which is precisely how the platform grants
    // `service_role` to `authenticator`.
    expect(
      reasonsFor(m, ROLE.member),
      'a role that can SET ROLE to a bypassrls role was reported by the ATTRIBUTE rule, ' +
        'which would mean this leg is no longer distinguishing the two halves',
    ).toBe('')
    expect(m.memberUsage, 'pg_has_role(member, service_role, USAGE)').toBe(false)
    expect(m.memberMember, 'pg_has_role(member, service_role, MEMBER)').toBe(true)
    // So a guard asking only 'USAGE' would report NOTHING for this role. The reachability
    // question, asked with MEMBER, reports the carrier and the reason it matched.
    expect(m.reach.get('member')).toBe('service_role [BYPASSRLS]')
  })

  it('reachability names the blanket-data role a scratch role reached, and not its neighbour', async () => {
    const m = await measureRule()
    expect(m.reach.get('readall')).toBe('pg_read_all_data [PG_READ_ALL_DATA]')
    expect(m.reach.get('writeall')).toBe('pg_write_all_data [PG_WRITE_ALL_DATA]')
  })

  it('every reason code in the shared rule is exercised by a control in this file', () => {
    // A new predicate added to privileged-role.ts strengthens both guards and must ship
    // with a control (canon §8.6b). Without this assertion it could ship with none, and
    // the file would still be green.
    const exercised = [
      'SUPERUSER',
      'BYPASSRLS',
      'OWNS_PUBLIC_RELATION',
      'CREATEROLE',
      'CREATEDB',
      'PG_READ_ALL_DATA',
      'PG_WRITE_ALL_DATA',
    ]
    expect([...PRIVILEGE_REASON_CODES].sort()).toEqual([...exercised].sort())
  })
})

describe('[NFR-01] [NFR-02] the guards themselves, end to end', () => {
  afterEach(async () => {
    // Put the worker's own URL back and drop the cached verdict, which is keyed to nothing
    // and would otherwise survive as "role already verified" for a connection that is gone.
    process.env['APP_DATABASE_URL'] = appDatabaseUrl()
    await releaseProductionPools()
  })

  it('positive control: a connection as `authenticated` is ACCEPTED and the callback runs', async () => {
    // Without this the whole file proves only that something gets refused, which is also
    // true of a guard that refuses everything.
    const { ran, error } = await withUserAgainst(appDatabaseUrl())
    expect(error).toBeUndefined()
    expect(ran).toBe(true)
  })

  it('positive control: the harness guard accepts that same connection and reports the facts ADR-0015 requires', async () => {
    const identity = await ensureWorkerDatabase()
    expect(identity.currentUser).toBe(EXPECTED_APP_ROLE)
    expect(identity.isSuperuser).toBe(false)
    expect(identity.bypassesRls).toBe(false)
    expect(identity.publicTablesOwned).toBe(0)
    expect(identity.reachablePrivilegedRoles).toEqual([])
    expect(identity.holdsTempOnDatabase).toBe(false)
    // The identity path, which post-port fails SILENTLY in both directions: a claimless
    // `auth.uid()` must be NULL and must raise nothing, and the claim must actually arrive.
    expect(identity.uidWithoutClaim).toBeUndefined()
    expect(identity.claimObserved).toBeDefined()
    expect(identity.uidWithClaim).toBe(identity.claimObserved)
  })

  it('postgres — the role the Supabase CLI and dashboard use by default — is REFUSED, and not for being a superuser', async () => {
    const message = await refusalFor(migratorDatabaseUrl())

    expect(message).toContain('postgres')
    expect(message).toContain(workerDatabaseName())
    expect(message).toContain(VIOLATION.bypassrls)
    expect(message).toMatch(/owns \d+ relation\(s\) in schema public/)
    // The reachability clause reporting the carrier AND the reason it matched.
    expect(message).toContain('service_role [BYPASSRLS]')
    // `rolsuper` is FALSE here, so a SUPERUSER-only guard would have accepted this
    // connection. The absence of that violation is the attribution.
    expect(message).not.toContain(VIOLATION.superuser)

    // ...and the reachability report above can only have come from the MEMBER leg: the
    // platform grants `service_role` to `postgres` NOINHERIT, so USAGE is false.
    const probe = await queryRows(
      `select 'v3', pg_has_role('postgres','service_role','USAGE')::text,
                    pg_has_role('postgres','service_role','MEMBER')::text`,
      { db: workerDatabaseName() },
    )
    const row = probe.find((r) => r[0] === 'v3')
    expect(row?.[1], 'pg_has_role(postgres, service_role, USAGE)').toBe('false')
    expect(row?.[2], 'pg_has_role(postgres, service_role, MEMBER)').toBe('true')
  })

  it('CREATEROLE: refuses a connection that can SET ROLE to a role holding CREATEROLE', async () => {
    const login = scratch('cr_login')
    const carrier = scratch('cr_carrier')
    const message = await withCommitted(
      carrierSetup(login, carrier, 'createrole'),
      carrierTeardown(login, carrier),
      () => refusalFor(urlAsRole(login)),
    )
    expect(message).toContain(login)
    expect(message).toContain(`${carrier} [CREATEROLE]`)
    // Not confused with its neighbour, and not catching for a reason the carrier does not
    // have: the login role itself is an ordinary role, so only the reachability clause can
    // have fired.
    expect(message).not.toContain('CREATEDB')
    expect(message).not.toContain('[BYPASSRLS]')
    expect(message).not.toContain(VIOLATION.bypassrls)
    expect(message).not.toContain(VIOLATION.superuser)
    expect(message).not.toContain(VIOLATION.owns)
  })

  it('CREATEDB: refuses a connection that can SET ROLE to a role holding CREATEDB', async () => {
    const login = scratch('cd_login')
    const carrier = scratch('cd_carrier')
    const message = await withCommitted(
      carrierSetup(login, carrier, 'createdb'),
      carrierTeardown(login, carrier),
      () => refusalFor(urlAsRole(login)),
    )
    expect(message).toContain(`${carrier} [CREATEDB]`)
    expect(message).not.toContain('CREATEROLE')
    expect(message).not.toContain('[BYPASSRLS]')
    expect(message).not.toContain(VIOLATION.bypassrls)
    expect(message).not.toContain(VIOLATION.superuser)
    expect(message).not.toContain(VIOLATION.owns)
  })

  it('OWNERSHIP: refuses a connection that owns one public table, naming ownership and nothing else', async () => {
    // The end-to-end counterpart of the rolled-back ownership leg. `postgres` cannot make
    // this point — it trips four clauses at once — so a role whose ONLY property is
    // owning one relation is the only way to show the ownership clause refusing a real
    // connection on its own.
    const login = scratch('ow_login')
    const table = `rgp_e2e_${workerDatabaseName()}`
    const message = await withCommitted(
      `create role ${login} login;
       create table public.${table} (id uuid primary key, user_id uuid not null);
       alter table public.${table} owner to ${login};`,
      `drop table if exists public.${table};
       drop role if exists ${login};`,
      () => refusalFor(urlAsRole(login)),
    )
    expect(message).toContain('owns 1 relation(s) in schema public')
    expect(message).not.toContain(VIOLATION.bypassrls)
    expect(message).not.toContain(VIOLATION.superuser)
    expect(message).not.toContain(VIOLATION.reachable)
  })

  it('leaves the cluster exactly as it found it: not one scratch role survives', async () => {
    // Role state is cluster-wide. If a teardown above ever stopped running, a later run
    // would measure a cluster that is already mutated — and, for a bypassrls or
    // pg_*_all_data carrier, every other worker's posture check would fail with it.
    const rows = await queryRows(
      `select 'left', coalesce(string_agg(rolname, ',' order by rolname), '<none>')
         from pg_roles where rolname like '${SCRATCH_LIKE}'`,
      { db: harnessEnv().TEST_ADMIN_DB },
    )
    expect(rows.find((r) => r[0] === 'left')?.[1]).toBe('<none>')
  })
})

describe('[NFR-01] [NFR-02] posture rule 11s BYPASSRLS allowlist: what it actually says', () => {
  /** Supabase mandates these four; rule 11 admits them BY NAME, with a reason each. */
  const MANDATED = ['postgres', 'service_role', 'supabase_admin', 'authenticator']

  interface AllowRow {
    readonly rolname: string
    readonly reason: string
    /** Does a role of that name exist in this cluster? */
    readonly exists: boolean
    /** Is it, or can it become, BYPASSRLS? Empty when not. */
    readonly via: string
  }

  let allowlist: Promise<AllowRow[]> | undefined

  function readAllowlist(): Promise<AllowRow[]> {
    // `authenticated` cannot read this registry at all (MEASURED: 42501), which is
    // deliberate — scripts/migrate.sh runs the posture check as `postgres` for the same
    // reason — so this goes through ownerQuery. It is a catalogue read, not an enforcement
    // assertion, which is the only thing that connection may be used for.
    allowlist ??= (async () => {
      const rows = await ownerQuery(
        `select a.rolname,
                replace(a.reason, '|', '/'),
                (r.oid is not null)::text,
                coalesce((select string_agg(b.rolname, ' ' order by b.rolname)
                            from pg_roles b
                           where b.rolbypassrls
                             and pg_has_role(r.oid, b.oid, 'MEMBER')), '')
           from public.posture_bypassrls_allow a
           left join pg_roles r on r.rolname = a.rolname
          order by a.rolname`,
      )
      return rows.flatMap((row) => {
        const [rolname, reason, exists, via] = row
        if (rolname === undefined || reason === undefined || exists === undefined) return []
        return [{ rolname, reason, exists: exists === 'true', via: via ?? '' }]
      })
    })()
    return allowlist
  }

  it('names every role Supabase mandates, and gives each one a REASON', async () => {
    const rows = await readAllowlist()
    expect(rows.length, 'the allowlist is empty, so rule 11 admits nothing by name').toBeGreaterThan(
      0,
    )
    for (const name of MANDATED) {
      const row = rows.find((r) => r.rolname === name)
      expect(row, `posture rule 11 does not allowlist the mandated role ${name}`).toBeDefined()
      // "An allowlist without reasons becomes a place to put whatever is currently
      // failing" — the migration's own words. A length floor is a crude check, but a row
      // with a one-word reason is the shape being guarded against.
      expect(row?.reason.length, `${name} is allowlisted with no real reason`).toBeGreaterThan(40)
    }
    // The port's central fact is stated IN the allowlist, where someone deleting the row
    // will read it.
    const postgresRow = rows.find((r) => r.rolname === 'postgres')
    expect(postgresRow?.reason).toContain('rolbypassrls=true')
    expect(postgresRow?.reason).toContain('rolsuper=false')
  })

  it('admits no role a browser client can become', async () => {
    const rows = await readAllowlist()
    // If `anon`, `authenticated` or `service_role`-as-a-client ever appeared here, rule 11
    // would stop protecting the only roles that reach this database from the internet.
    // `service_role` is allowlisted and MUST NOT be reachable from the browser: it is the
    // service key's role, which is why the allowlist row says so.
    for (const name of ['anon', EXPECTED_APP_ROLE]) {
      expect(
        rows.some((r) => r.rolname === name),
        `${name} is in the BYPASSRLS allowlist, which would exempt the browser's own role`,
      ).toBe(false)
    }
  })

  it('admits nothing that is not actually BYPASSRLS-reachable', async () => {
    const rows = await readAllowlist()
    // A row for a role that is NOT bypassrls-reachable is a waiver with nothing to waive —
    // i.e. a pre-approved slot for a future privileged role. Rows naming a role that does
    // not exist in this cluster are skipped: `supabase_admin` is a platform role the local
    // emulation deliberately does not create.
    const spare = rows.filter((r) => r.exists && r.via === '').map((r) => r.rolname)
    expect(spare, `allowlisted but not bypassrls-reachable: ${spare.join(', ')}`).toEqual([])
    // ...and the population is non-empty, so the filter above is not passing by iterating
    // nothing (V7).
    expect(rows.filter((r) => r.exists).length).toBeGreaterThan(2)
  })

  it('admits the cluster superuser ONLY through the local-emulation concession', async () => {
    const rows = await readAllowlist()
    const admin = rows.find((r) => r.rolname === harnessEnv().TEST_ADMIN_ROLE)
    // The concession is gated on `auth.is_emulation()`, which scripts/emulate-supabase.sh
    // creates and no Supabase project has. If the marker ever stopped existing the
    // superuser would be reported by rule 11 — which is the correct behaviour there, and
    // the reason "ignore superusers" was not an option (V1/V34).
    const marker = await ownerQuery(
      `select 'emulation', exists (select 1 from pg_proc p
                                     join pg_namespace n on n.oid = p.pronamespace
                                    where n.nspname = 'auth' and p.proname = 'is_emulation')::text`,
    )
    expect(marker.find((r) => r[0] === 'emulation')?.[1]).toBe('true')
    expect(admin, 'the local cluster superuser is not admitted, so no local run can pass').toBeDefined()
    expect(admin?.reason).toContain('LOCAL EMULATION ONLY')
    // Nothing else is admitted on those grounds.
    const conceded = rows.filter((r) => r.reason.includes('LOCAL EMULATION ONLY'))
    expect(conceded.map((r) => r.rolname)).toEqual([harnessEnv().TEST_ADMIN_ROLE])
  })

  it('postgres is allowlisted to EXIST and still refused as a CONNECTION — two different questions', async () => {
    // The distinction the port turns on, asserted in one place because conflating the two
    // is the mistake that would void the suite. Rule 11 asks which bypassrls roles may
    // exist (the platform requires four). The connection guard asks whether the role
    // serving user data is one of them, and admits no allowlist at all.
    const rows = await readAllowlist()
    expect(rows.some((r) => r.rolname === 'postgres')).toBe(true)

    const message = await refusalFor(migratorDatabaseUrl())
    expect(message).toContain(VIOLATION.bypassrls)

    process.env['APP_DATABASE_URL'] = appDatabaseUrl()
    await releaseProductionPools()
  })
})
