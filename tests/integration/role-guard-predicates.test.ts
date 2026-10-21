/**
 * Controls for the FOUR predicates the production role guard was missing.
 *
 * ── What was wrong ───────────────────────────────────────────────────────────
 * The production guard (`POSTURE_SQL` in src/server/db/pool.ts, reached through
 * `assertUnprivilegedOnce`) and the harness guard (`assertTestConnectionIdentity`
 * in ./support/db.ts) are supposed to state the same rule. They were two
 * hand-written copies and they had DRIFTED: the harness tested `rolcreaterole`,
 * `rolcreatedb` and membership of `pg_read_all_data` / `pg_write_all_data`, and
 * production tested none of them.
 *
 * The harness holding the STRICTER rule is the worst possible direction for that
 * drift, because the suite's whole job is to notice a weakness on the production
 * side. A production app role that had acquired CREATEROLE, or membership of
 * `pg_read_all_data`, was refused by the tests and ACCEPTED by the application.
 *
 * Both now build their predicate from `src/server/db/privileged-role.ts`, so the
 * rule exists once and neither can be weakened without weakening the other.
 *
 * ── Why these tests assert on the REASON, not just on the rejection ──────────
 * Pointing a pool at `statesman_migrator` ALREADY fails, and did before this
 * change: the migrator is a member of `statesman_owner`, which owns every public
 * relation, and ownership bypasses RLS (V4). So "a PrivilegeAssertionError was
 * thrown" is worth nothing here — it is satisfied by the pre-existing ownership
 * predicate and would stay green with all four new predicates deleted.
 *
 * The guard therefore reports each reachable role WITH the reason codes that
 * matched, and each test below asserts the specific code. `baseline` is the
 * control on the controls: with no carrier mutation in place, NONE of the four
 * codes appears, which is what makes their appearance in the other tests
 * evidence rather than decoration.
 *
 * ── Why these carrier roles ──────────────────────────────────────────────────
 * Each predicate needs a role that (a) has the property, and (b) is reachable
 * from the connecting role. No role is created or dropped: every test grants to,
 * or alters, a role that already exists, and reverts in `finally`.
 *
 *   PG_READ_ALL_DATA  / PG_WRITE_ALL_DATA
 *       GRANTed to `statesman_migrator`. These are RESERVED role names —
 *       `ALTER ROLE pg_read_all_data …` is refused by the server ("Cannot alter
 *       reserved roles"), measured — so membership is the only way to acquire
 *       them, which is exactly the path the reachability test covers.
 *   CREATEROLE / CREATEDB
 *       ALTERed onto `statesman_owner`, which `statesman_migrator` already
 *       reaches. The predefined `pg_*` roles cannot carry these attributes (same
 *       reserved-role refusal), and `statesman_owner` is the only other role the
 *       migrator reaches.
 *
 * NOTHING HERE TOUCHES `statesman_app`. That is deliberate and load-bearing: the
 * integration suite runs up to 4 worker processes against one cluster, role
 * state is cluster-wide, and `assertTestConnectionIdentity` reads precisely
 * `statesman_app`'s own reachability. A test that temporarily gave the app role a
 * privilege would make a CONCURRENT worker's harness guard fail for a reason that
 * has nothing to do with that worker. `statesman_app` is not a member of
 * `statesman_owner` or of the migrator (measured: its reachable set is empty), so
 * mutating those two is invisible to it.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  appDatabaseUrl,
  ensureWorkerDatabase,
  harnessEnv,
  migratorDatabaseUrl,
  queryRows,
  releaseProductionPools,
  workerDatabaseName,
} from './support/db'
import { enterIdentityContext } from '../../src/server/session/resolve'
import { PrivilegeAssertionError, withUser } from '../../src/server/db'

const USER_A = 'aaaaaaaa-0000-0000-0000-0000000c9a01'

/** Every reason code the guard can report, so a typo in one cannot pass. */
const NEW_CODES = ['CREATEROLE', 'CREATEDB', 'PG_READ_ALL_DATA', 'PG_WRITE_ALL_DATA'] as const

/**
 * Run DDL as the cluster admin, against the admin database.
 *
 * Role state is cluster-wide, so these statements are issued on the admin
 * database rather than the worker clone; `GRANT <role>` and `ALTER ROLE` are
 * catalogue-wide either way. This goes through the harness's own psql helper, so
 * no `pg` connection is opened outside `src/server/db/**` (§6.1).
 */
async function admin(sql: string): Promise<void> {
  await queryRows(sql, { db: harnessEnv().TEST_ADMIN_DB })
}

/**
 * Drive the REAL `withUser` against an arbitrary connection URL and report what
 * happened.
 *
 * `runAsUser` cannot be used: it repoints `APP_DATABASE_URL` at the worker's own
 * app-role URL, which would undo the point of the test. So the URL is set here,
 * the cached verdict and the pools are dropped so the next acquire reads it, and
 * the same ambient identity context the authentication middleware opens is
 * entered. The transaction preamble is NOT reimplemented — `withUser` does all of
 * it — so this cannot pass while production's own sequencing is broken.
 *
 * `ran` reports whether the callback was reached. A guard that rejects only after
 * the callback has touched user data has protected nothing.
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

/** The guard's message for a connection as `statesman_migrator`, asserted to exist. */
async function migratorRefusalMessage(): Promise<string> {
  const { ran, error } = await withUserAgainst(migratorDatabaseUrl())
  expect(error).toBeInstanceOf(PrivilegeAssertionError)
  expect(ran).toBe(false)
  return (error as PrivilegeAssertionError).message
}

describe('production role guard: the four predicates it was missing', () => {
  beforeAll(async () => {
    await ensureWorkerDatabase()
  })

  afterEach(async () => {
    // Put the worker's own URL back and drop the cached verdict, which is keyed to
    // nothing and would otherwise survive as "role already verified" against a
    // connection that is gone.
    process.env['APP_DATABASE_URL'] = appDatabaseUrl()
    await releaseProductionPools()
  })

  it('positive control: the statesman_app connection is ACCEPTED and the callback runs', async () => {
    const { ran, error } = await withUserAgainst(appDatabaseUrl())
    expect(error).toBeUndefined()
    expect(ran).toBe(true)
  })

  it('baseline: statesman_migrator is refused for OWNERSHIP ONLY — none of the four new codes appears', async () => {
    const message = await migratorRefusalMessage()

    // The pre-existing predicate, still doing its job.
    expect(message).toContain('statesman_owner')
    expect(message).toContain('OWNS_PUBLIC_RELATION')
    expect(message).toContain(workerDatabaseName())

    // THE CONTROL ON THE CONTROLS. With no carrier mutation applied, not one of
    // the four new codes is reported. Every test below asserts one of these codes
    // appears; this is what proves such an assertion is not vacuous.
    for (const code of NEW_CODES) expect(message).not.toContain(code)
  })

  it('CREATEROLE: refuses a connection that can SET ROLE to a role holding CREATEROLE', async () => {
    await admin('alter role statesman_owner createrole;')
    try {
      const message = await migratorRefusalMessage()
      expect(message).toContain('CREATEROLE')
      expect(message).toContain('statesman_owner')
      // Not confused with its neighbour in the reason list.
      expect(message).not.toContain('CREATEDB')
    } finally {
      await admin('alter role statesman_owner nocreaterole;')
    }
  })

  it('CREATEDB: refuses a connection that can SET ROLE to a role holding CREATEDB', async () => {
    await admin('alter role statesman_owner createdb;')
    try {
      const message = await migratorRefusalMessage()
      expect(message).toContain('CREATEDB')
      expect(message).toContain('statesman_owner')
      expect(message).not.toContain('CREATEROLE')
    } finally {
      await admin('alter role statesman_owner nocreatedb;')
    }
  })

  it('PG_READ_ALL_DATA: refuses a connection with membership of pg_read_all_data', async () => {
    await admin('grant pg_read_all_data to statesman_migrator;')
    try {
      const message = await migratorRefusalMessage()
      expect(message).toContain('pg_read_all_data')
      expect(message).toContain('PG_READ_ALL_DATA')
      expect(message).not.toContain('PG_WRITE_ALL_DATA')
    } finally {
      await admin('revoke pg_read_all_data from statesman_migrator;')
    }
  })

  it('PG_WRITE_ALL_DATA: refuses a connection with membership of pg_write_all_data', async () => {
    await admin('grant pg_write_all_data to statesman_migrator;')
    try {
      const message = await migratorRefusalMessage()
      expect(message).toContain('pg_write_all_data')
      expect(message).toContain('PG_WRITE_ALL_DATA')
      expect(message).not.toContain('PG_READ_ALL_DATA')
    } finally {
      await admin('revoke pg_write_all_data from statesman_migrator;')
    }
  })

  it('leaves the cluster exactly as it found it', async () => {
    // The carrier roles are cluster-wide state. If a `finally` above ever stopped
    // running, every later run would measure a cluster that is already mutated —
    // and the CREATEROLE/CREATEDB tests would then pass without their own ALTER.
    const rows = await queryRows(
      `select rolname, rolcreaterole::text, rolcreatedb::text
         from pg_roles
        where rolname in ('statesman_app','statesman_owner','statesman_migrator')
        order by rolname`,
      { db: harnessEnv().TEST_ADMIN_DB },
    )
    expect(rows).toEqual([
      ['statesman_app', 'false', 'false'],
      ['statesman_migrator', 'false', 'false'],
      ['statesman_owner', 'false', 'false'],
    ])

    const members = await queryRows(
      `select g.rolname
         from pg_auth_members am
         join pg_roles m on m.oid = am.member
         join pg_roles g on g.oid = am.roleid
        where m.rolname = 'statesman_migrator'
        order by g.rolname`,
      { db: harnessEnv().TEST_ADMIN_DB },
    )
    expect(members).toEqual([['statesman_owner']])
  })
})
