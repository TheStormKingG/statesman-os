/**
 * Integration-test database fixture.
 *
 * Isolation strategy (§8.3, V32): each Vitest worker gets its own database, cloned from
 * `statesman_test_template` with CREATE DATABASE ... TEMPLATE and dropped at teardown.
 * Not TRUNCATE and not DELETE — `decision_revision`'s append-only triggers fire for the
 * table OWNER as well (V32), so there is no role from which the table can be emptied in
 * place.
 *
 * Two deliberate shapes to note:
 *
 * 1. This module talks to Postgres through `psql`, not through `pg`. The `pg` package may
 *    be imported only inside `src/server/db/**` (§6.1), enforced by an AST check, and a
 *    test-support module that opened its own Pool would be the first hole in that
 *    boundary. Everything the fixture needs — CREATE/DROP DATABASE, catalog reads, the
 *    role guard — is DDL or catalog work that psql does as well. Application-shaped
 *    access goes through `runAsUser`, i.e. through the real `withUser`.
 *
 * 2. The role guard is not advisory. A tenancy suite that silently ran as a superuser
 *    reports green while testing nothing, so `ensureWorkerDatabase()` runs it as part of
 *    the same cached promise that creates the database. There is no code path that
 *    reaches the worker database without it, which is the same reasoning as
 *    `assertUnprivilegedOnce()` in the data path (§6.1 step 1).
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { z } from 'zod'
import { withMigrator, withUser } from '../../../src/server/db'
import type { MigratorClient, UserScopedClient } from '../../../src/server/db'
// THE ONE RULE for "is this role too privileged to serve user data". Shared with the
// production guard (POSTURE_SQL in src/server/db/pool.ts) so the two cannot drift —
// they had, and the harness was holding the stricter copy. No `pg` import is involved:
// the module is pure SQL-string construction.
import { privilegedRolePredicateSql } from '../../../src/server/db/privileged-role'
// closePools / resetPrivilegeAssertionCacheForTests are deliberately NOT part of the
// db module's public surface; its own comment says test setup imports them from here.
import { closePools, resetPrivilegeAssertionCacheForTests } from '../../../src/server/db/pool'
import { enterIdentityContext } from '../../../src/server/session/resolve'

const execFileAsync = promisify(execFile)

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * A database name reaches SQL as an IDENTIFIER and identifiers cannot be parameterised.
 * Every name this module sends is validated against this pattern first and then passed
 * through psql's `:"var"` identifier quoting. Nothing is concatenated into SQL text.
 */
const IDENTIFIER = /^[a-z][a-z0-9_]{0,50}$/

/**
 * 8-4-4-4-12 hex, matching the `uuid` column and `z.guid()`, NOT `z.uuid()`: the project's
 * own seeded identities have a `0` version nibble, which RFC 9562 validation rejects.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const envSchema = z.object({
  TEST_APP_DATABASE_URL_BASE: z
    .string()
    .min(1)
    .default('postgres://statesman_app@127.0.0.1:5432'),
  TEST_MIGRATOR_DATABASE_URL_BASE: z
    .string()
    .min(1)
    .default('postgres://statesman_migrator@127.0.0.1:5432'),
  TEST_TEMPLATE_DB: z.string().regex(IDENTIFIER).default('statesman_test_template'),
  TEST_ADMIN_DB: z.string().regex(IDENTIFIER).default('postgres'),
  /**
   * CREATE DATABASE needs rolcreatedb. Measured on this cluster: statesman_owner,
   * statesman_migrator and statesman_app all have rolcreatedb = false, so cloning runs
   * as the bootstrap superuser — the role V10 already designates for pg_dump. It is used
   * for DDL only and is never handed to a test; `assertTestConnectionIdentity()` proves
   * the connection tests use is statesman_app.
   */
  TEST_ADMIN_ROLE: z.string().min(1).default(userInfo().username),
  PGBIN: z.string().min(1).default('/opt/homebrew/opt/postgresql@17/bin'),
  LC_ALL: z.string().min(1).default('en_US.UTF-8'), // V27
})

export type HarnessEnv = z.infer<typeof envSchema>

let cachedEnv: HarnessEnv | undefined
export function harnessEnv(): HarnessEnv {
  if (cachedEnv === undefined) {
    const parsed = envSchema.safeParse(process.env)
    if (!parsed.success) {
      throw new Error(
        `integration harness environment is invalid:\n${parsed.error.issues
          .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('\n')}`,
      )
    }
    cachedEnv = parsed.data
  }
  return cachedEnv
}

/**
 * The role the tests actually connect as, read back out of the configured base URL.
 *
 * This is deliberately NOT the literal 'statesman_app'. pg_hba is `trust` for local
 * connections, so a typo'd or escalated username in TEST_APP_DATABASE_URL_BASE connects
 * successfully as whatever role it names, with no password error (V1) — that is the
 * failure this harness exists to catch. Hardcoding the role in the connection and then
 * asserting the connection's role is 'statesman_app' would be a gate that cannot fail.
 */
function roleFromBase(base: string, which: string): string {
  let parsed: URL
  try {
    parsed = new URL(base)
  } catch {
    throw new Error(`${which} is not a URL: ${base}`)
  }
  const user = decodeURIComponent(parsed.username)
  if (!IDENTIFIER.test(user)) {
    throw new Error(
      `${which} does not name a usable role ('${user}'). The harness will not guess a ` +
        'role: with pg_hba `trust` an unintended name connects successfully (V1).',
    )
  }
  return user
}

/** The role the data-path tests connect as. Asserted to be statesman_app, not assumed. */
export function appRole(): string {
  return roleFromBase(harnessEnv().TEST_APP_DATABASE_URL_BASE, 'TEST_APP_DATABASE_URL_BASE')
}

/** The role fixture setup connects as, to SET ROLE statesman_owner. */
export function migratorRole(): string {
  return roleFromBase(
    harnessEnv().TEST_MIGRATOR_DATABASE_URL_BASE,
    'TEST_MIGRATOR_DATABASE_URL_BASE',
  )
}

export const EXPECTED_APP_ROLE = 'statesman_app'

function psqlPath(): string {
  const candidate = join(harnessEnv().PGBIN, 'psql')
  return existsSync(candidate) ? candidate : 'psql'
}

export interface PsqlOptions {
  /** Database to connect to. */
  readonly db: string
  /** Role to connect as. Omit to use the admin role. */
  readonly role?: string | undefined
  /** psql variables, referenced as :'name' (literal) or :"name" (identifier). */
  readonly vars?: Readonly<Record<string, string>> | undefined
  /** Wrap the whole script in one transaction. Not usable with CREATE/DROP DATABASE. */
  readonly singleTransaction?: boolean | undefined
}

/**
 * Run SQL through psql and return raw stdout.
 *
 * psql is invoked with an argv array and no shell, and its output is never piped: a
 * pipeline reports the FILTER's exit status, so a failed statement behind `| head` reads
 * as a success. The SQL goes in on stdin with `-f -` rather than `-c`, because psql
 * performs variable interpolation (`:'lit'`, `:"ident"`) for files and stdin ONLY — with
 * `-c` the `:"tpl"` text reaches the server verbatim and raises a syntax error.
 * `ON_ERROR_STOP=1` turns a SQL error into a non-zero exit, which this surfaces as a
 * rejection carrying psql's real status.
 */
async function psql(sql: string, options: PsqlOptions): Promise<string> {
  const env = harnessEnv()
  if (!IDENTIFIER.test(options.db)) {
    throw new Error(`refusing to connect: '${options.db}' is not a safe database identifier`)
  }
  const role = options.role ?? env.TEST_ADMIN_ROLE
  const args = [
    '--no-psqlrc',
    '-q',
    '-A',
    '-t',
    '-F',
    '|',
    '-v',
    'ON_ERROR_STOP=1',
    // Default verbosity prints `ERROR:  no user context` with no SQLSTATE, so a caller
    // that needs to tell 28000 (no user context) from 42501 (permission denied) or
    // 42P01 (undefined table) has nothing to read. Verbose prints `ERROR:  28000: ...`.
    '-v',
    'VERBOSITY=verbose',
    '-h',
    '127.0.0.1',
    '-p',
    '5432',
    '-U',
    role,
    '-d',
    options.db,
  ]
  if (options.singleTransaction === true) args.push('--single-transaction')
  for (const [key, value] of Object.entries(options.vars ?? {})) {
    args.push('-v', `${key}=${value}`)
  }
  args.push('-f', '-')

  const { code, stdout, stderr } = await new Promise<{
    code: number | null
    stdout: string
    stderr: string
  }>((resolvePromise, rejectPromise) => {
    const child = spawn(psqlPath(), args, {
      env: { ...process.env, LC_ALL: env.LC_ALL }, // V27
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      err += chunk
    })
    child.on('error', rejectPromise)
    child.on('close', (exitCode) => {
      resolvePromise({ code: exitCode, stdout: out, stderr: err })
    })
    child.stdin.end(sql, 'utf8')
  })

  if (code !== 0) {
    throw new Error(
      `psql failed (exit ${String(code)}) on database '${options.db}' as '${role}'\n` +
        `--- sql ---\n${sql}\n--- stderr ---\n${stderr}\n--- stdout ---\n${stdout}`,
    )
  }
  return stdout
}

/** Rows as arrays of column strings. NULL and '' are indistinguishable here by design:
 *  write SQL that coalesces, rather than guessing which one came back. */
export async function queryRows(sql: string, options: PsqlOptions): Promise<string[][]> {
  const out = await psql(sql, options)
  return out
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split('|'))
}

/** Exactly one row, asserted. A row count that is not 1 is never a success (V7). */
export async function queryExactlyOneRow(
  sql: string,
  options: PsqlOptions,
): Promise<string[]> {
  const rows = await queryRows(sql, options)
  const first = rows[0]
  if (rows.length !== 1 || first === undefined) {
    throw new Error(`expected exactly 1 row, got ${rows.length}\n--- sql ---\n${sql}`)
  }
  return first
}

/**
 * Parse a Postgres boolean out of psql text output, strictly.
 *
 * psql renders a boolean column as `t`/`f` but `boolean::text` as `true`/`false`. An
 * `=== 't'` comparison against a `::text` column is therefore always false, which turns
 * "is this connection a superuser?" into a check that cannot fail. Both spellings are
 * accepted and anything else throws, so a future change of representation surfaces as an
 * error instead of a silent negative.
 */
export function parseBoolean(value: string | undefined, what: string): boolean {
  if (value === 't' || value === 'true') return true
  if (value === 'f' || value === 'false') return false
  throw new Error(`${what}: expected a Postgres boolean, got '${String(value)}'`)
}

// ---------------------------------------------------------------------------
// Run identity and database naming
// ---------------------------------------------------------------------------

export const RUN_ID_ENV = 'STATESMAN_TEST_RUN_ID'
export const WORKER_DB_PREFIX = 'statesman_test_w'

export function runId(): string {
  const value = process.env[RUN_ID_ENV]
  if (value === undefined || !/^[0-9a-f]{8}$/.test(value)) {
    throw new Error(
      `${RUN_ID_ENV} is missing or malformed (${String(value)}). It is set by ` +
        `tests/integration/support/global-setup.ts; running a test file outside the ` +
        `integration config bypasses the template build.`,
    )
  }
  return value
}

export function workerDatabaseName(): string {
  const pool = process.env['VITEST_POOL_ID'] ?? '0'
  if (!/^[0-9]{1,4}$/.test(pool)) {
    throw new Error(`VITEST_POOL_ID is not a worker number: ${pool}`)
  }
  const name = `${WORKER_DB_PREFIX}${pool}_${runId()}`
  if (!IDENTIFIER.test(name)) {
    throw new Error(`derived database name is not a safe identifier: ${name}`)
  }
  return name
}

/** The connection string the production app pool must be given for this worker. */
export function appDatabaseUrl(): string {
  return `${harnessEnv().TEST_APP_DATABASE_URL_BASE}/${workerDatabaseName()}`
}

/** The connection string the production migrator pool must be given for this worker. */
export function migratorDatabaseUrl(): string {
  return `${harnessEnv().TEST_MIGRATOR_DATABASE_URL_BASE}/${workerDatabaseName()}`
}

// ---------------------------------------------------------------------------
// Template and clone lifecycle (admin role; DDL only)
// ---------------------------------------------------------------------------

/** Build the template database by running scripts/db-template.sh. Main process only. */
export async function buildTemplateDatabase(): Promise<string> {
  const env = harnessEnv()
  const script = join(REPO_ROOT, 'scripts', 'db-template.sh')
  const { stdout } = await execFileAsync('bash', [script], {
    cwd: REPO_ROOT,
    env: { ...process.env, LC_ALL: env.LC_ALL, TEST_TEMPLATE_DB: env.TEST_TEMPLATE_DB },
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout
}

export async function listTestDatabases(suffix?: string): Promise<string[]> {
  const pattern =
    suffix === undefined ? `${WORKER_DB_PREFIX}%` : `${WORKER_DB_PREFIX}%\\_${suffix}`
  const rows = await queryRows(
    "select datname from pg_database where datname like :'pat' order by datname",
    { db: harnessEnv().TEST_ADMIN_DB, vars: { pat: pattern } },
  )
  return rows.flatMap((r) => (r[0] === undefined ? [] : [r[0]]))
}

export async function dropDatabase(name: string): Promise<void> {
  if (!IDENTIFIER.test(name) || !name.startsWith(WORKER_DB_PREFIX)) {
    throw new Error(`refusing to drop '${name}': not a worker test database`)
  }
  await psql('drop database if exists :"db" with (force);', {
    db: harnessEnv().TEST_ADMIN_DB,
    vars: { db: name },
  })
}

/** Drop every worker database for one run id (teardown), or all of them (stray sweep). */
export async function dropTestDatabases(suffix?: string): Promise<string[]> {
  const names = await listTestDatabases(suffix)
  for (const name of names) await dropDatabase(name)
  return names
}

async function createWorkerDatabase(name: string): Promise<void> {
  const env = harnessEnv()
  // CREATE/DROP DATABASE cannot run inside a transaction block, so each is its own call.
  await psql('drop database if exists :"db" with (force);', {
    db: env.TEST_ADMIN_DB,
    vars: { db: name },
  })
  await psql('create database :"db" template :"tpl";', {
    db: env.TEST_ADMIN_DB,
    vars: { db: name, tpl: env.TEST_TEMPLATE_DB },
  })
  // CREATE DATABASE copies schema ownership and schema ACLs, but NOT the database ACL.
  // Without this the clone silently hands PUBLIC its TEMPORARY privilege back, and a
  // temp table shadows an unqualified reference to a real one (V22). The assertion in
  // assertTestConnectionIdentity() is what proves this ran.
  await psql(
    'grant create on database :"db" to statesman_owner;\n' +
      'revoke temporary on database :"db" from public;',
    { db: env.TEST_ADMIN_DB, vars: { db: name }, singleTransaction: true },
  )
}

// ---------------------------------------------------------------------------
// The role guard — harness-fatal, never a warning
// ---------------------------------------------------------------------------

export interface ConnectionIdentity {
  readonly database: string
  readonly currentUser: string
  readonly isSuperuser: boolean
  readonly bypassesRls: boolean
  readonly publicTablesOwned: number
  readonly reachablePrivilegedRoles: readonly string[]
  readonly holdsTempOnDatabase: boolean
}

/**
 * Measure the identity of the connection the tests will use, on the worker's own
 * database, and throw if any check fails.
 *
 * Why each check, and not just `current_user`:
 *   - current_user: pg_hba is `trust` locally, so a typo'd role connects successfully as
 *     whatever it names, with no password error (V1). The name has to be read back.
 *   - rolsuper / rolbypassrls: either one makes RLS vanish and every tenancy assertion
 *     pass vacuously.
 *   - public tables owned: table OWNERSHIP bypasses RLS independently of role
 *     attributes (V4), so the attribute checks above do not cover it.
 *   - reachable privileged roles: attributes are not inherited, but SET ROLE still
 *     works (V3), so attribute checks alone are insufficient. WHICH roles count as
 *     privileged is not decided here — it comes from
 *     `src/server/db/privileged-role.ts`, the one definition the production guard
 *     builds its own predicate from. Previously this query carried a hand-written copy
 *     that was STRICTER than production's, which meant the suite could not detect a
 *     production-side weakness in the rule it was supposedly mirroring.
 *   - TEMP on the database: re-revoked per clone, see createWorkerDatabase (V22).
 */
export async function assertTestConnectionIdentity(
  databaseName = workerDatabaseName(),
): Promise<ConnectionIdentity> {
  const row = await queryExactlyOneRow(
    `select current_database(),
            current_user,
            (select r.rolsuper     from pg_roles r where r.rolname = current_user)::text,
            (select r.rolbypassrls from pg_roles r where r.rolname = current_user)::text,
            (select count(*) from pg_class c
                join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind in ('r','p')
                and pg_get_userbyid(c.relowner) = current_user)::text,
            coalesce((select string_agg(r.rolname, ',' order by r.rolname)
               from pg_roles r
              where r.rolname <> current_user
                and ${privilegedRolePredicateSql('r')}
                and (pg_has_role(current_user, r.oid, 'USAGE')
                  or pg_has_role(current_user, r.oid, 'MEMBER'))), ''),
            has_database_privilege(current_user, current_database(), 'TEMP')::text`,
    { db: databaseName, role: appRole() },
  )
  const [database, currentUser, superText, bypassText, ownedText, reachable, tempText] = row
  if (
    database === undefined ||
    currentUser === undefined ||
    superText === undefined ||
    bypassText === undefined ||
    ownedText === undefined ||
    reachable === undefined ||
    tempText === undefined
  ) {
    throw new Error(`role-guard query returned ${row.length} columns, expected 7`)
  }

  const identity: ConnectionIdentity = {
    database,
    currentUser,
    isSuperuser: parseBoolean(superText, 'pg_roles.rolsuper'),
    bypassesRls: parseBoolean(bypassText, 'pg_roles.rolbypassrls'),
    publicTablesOwned: Number.parseInt(ownedText, 10),
    reachablePrivilegedRoles: reachable === '' ? [] : reachable.split(','),
    holdsTempOnDatabase: parseBoolean(tempText, 'has_database_privilege(TEMP)'),
  }

  const failures: string[] = []
  if (identity.currentUser !== EXPECTED_APP_ROLE) {
    failures.push(
      `current_user is '${identity.currentUser}', expected '${EXPECTED_APP_ROLE}'. ` +
        'TEST_APP_DATABASE_URL_BASE names that role and pg_hba `trust` accepted it ' +
        'without a password error (V1).',
    )
  }
  if (identity.isSuperuser) failures.push('connection role is a SUPERUSER — RLS would be bypassed')
  if (identity.bypassesRls) failures.push('connection role has BYPASSRLS — RLS would be bypassed')
  if (!Number.isInteger(identity.publicTablesOwned)) {
    failures.push(`could not read owned-table count (got '${ownedText}')`)
  } else if (identity.publicTablesOwned !== 0) {
    failures.push(
      `connection role owns ${identity.publicTablesOwned} table(s) in schema public — ` +
        'ownership bypasses RLS independently of role attributes (V4)',
    )
  }
  if (identity.reachablePrivilegedRoles.length > 0) {
    failures.push(
      `connection role can reach privileged role(s) ${identity.reachablePrivilegedRoles.join(', ')} ` +
        'by membership — attributes are not inherited but SET ROLE still works (V3)',
    )
  }
  if (identity.holdsTempOnDatabase) {
    failures.push(
      'connection role holds TEMPORARY on the database — a temp table shadows an ' +
        'unqualified reference to a real one (V22). Either the clone-time REVOKE did ' +
        'not run, or the role is privileged enough to hold it regardless.',
    )
  }
  if (identity.database !== databaseName) {
    failures.push(`connected to '${identity.database}', expected '${databaseName}'`)
  }

  if (failures.length > 0) {
    throw new Error(
      'INTEGRATION HARNESS ABORTED — the test connection is not the unprivileged app ' +
        'role, so every tenancy assertion in this run would pass without testing ' +
        `anything:\n${failures.map((f) => `  - ${f}`).join('\n')}`,
    )
  }
  return identity
}

// ---------------------------------------------------------------------------
// Per-worker fixture
// ---------------------------------------------------------------------------

let workerDatabase: Promise<ConnectionIdentity> | undefined

/**
 * Clone the template for this worker and prove the connection identity. Cached, so the
 * guard runs exactly once per worker process and no helper can skip it.
 */
export function ensureWorkerDatabase(): Promise<ConnectionIdentity> {
  if (workerDatabase === undefined) {
    const name = workerDatabaseName()
    workerDatabase = (async () => {
      await createWorkerDatabase(name)
      return assertTestConnectionIdentity(name)
    })().catch((error: unknown) => {
      workerDatabase = undefined // a failed setup must not be cached as "done"
      throw error
    })
  }
  return workerDatabase
}

/** Run SQL against this worker's database as statesman_app. */
export async function appQuery(
  sql: string,
  vars?: Readonly<Record<string, string>>,
): Promise<string[][]> {
  await ensureWorkerDatabase()
  return queryRows(sql, { db: workerDatabaseName(), role: appRole(), vars })
}

/** Run SQL against this worker's database as the schema owner. Fixture setup only. */
export async function ownerQuery(
  sql: string,
  vars?: Readonly<Record<string, string>>,
): Promise<string[][]> {
  await ensureWorkerDatabase()
  return queryRows(`set role statesman_owner;\n${sql}`, {
    db: workerDatabaseName(),
    role: migratorRole(), // member of statesman_owner; the owner itself is NOLOGIN
    vars,
  })
}

// ---------------------------------------------------------------------------
// The production seam: run a block through the real withUser
// ---------------------------------------------------------------------------

/**
 * Run `fn` as `userId` through the real `withUser`, against this worker's database.
 *
 * `withUser` takes no session parameter (ADR-0006): an identity arriving as an argument
 * type-checks perfectly when handed a victim's id, and RLS then faithfully enforces the
 * attacker's chosen identity. So this helper cannot pass an id either. It opens the same
 * ambient identity context the authentication middleware opens — `enterIdentityContext`,
 * an AsyncLocalStorage scope — and lets `withUser` resolve the session exactly as
 * production does.
 *
 * The imports are static and relative, so the whole chain is type-checked and there is no
 * parallel implementation of the transaction preamble anywhere in the harness. A fixture
 * that set `app.current_user_id` itself would pass while production's eager
 * `app.require_user_id()` validation (§6.1 step 4, V6) was missing or misordered.
 *
 * `pg` is NOT imported here, nor anywhere else under tests/: the import boundary of §6.1
 * stays intact, because the only connections this module opens are psql subprocesses for
 * DDL and catalog reads.
 */
export async function runAsUser<T>(
  userId: string,
  fn: (db: UserScopedClient) => Promise<T>,
): Promise<T> {
  if (!UUID.test(userId)) {
    throw new Error(`runAsUser: '${userId}' is not an 8-4-4-4-12 hex uuid`)
  }
  await ensureWorkerDatabase()
  pointProductionPoolsAtWorkerDatabase()
  return enterIdentityContext(userId, () => withUser(fn))
}

/**
 * Run `fn` with the migrator connection, against this worker's database.
 *
 * Exposed for fixture setup that has to reach grant-protected tables (app_user,
 * user_session, auth_attempt have no grants to the app role at all — §4.6). Note that
 * `withMigrator` refuses to run inside an open identity context, so this cannot be
 * nested inside `runAsUser`.
 */
export async function runAsMigrator<T>(
  userId: string,
  fn: (db: MigratorClient) => Promise<T>,
): Promise<T> {
  if (!UUID.test(userId)) {
    throw new Error(`runAsMigrator: '${userId}' is not an 8-4-4-4-12 hex uuid`)
  }
  await ensureWorkerDatabase()
  pointProductionPoolsAtWorkerDatabase()
  return withMigrator(userId, fn)
}

/**
 * Point the production pools at this worker's clone.
 *
 * `pool.ts` reads APP_DATABASE_URL / MIGRATOR_DATABASE_URL lazily, on the first
 * acquire (`appPool ??= createPool(...)`), so setting them before the first data call is
 * sufficient and no import-order trick is needed. It is set on every call rather than
 * once, so a test that overwrote the variable cannot silently redirect a later one.
 */
function pointProductionPoolsAtWorkerDatabase(): void {
  process.env['APP_DATABASE_URL'] = appDatabaseUrl()
  process.env['MIGRATOR_DATABASE_URL'] = migratorDatabaseUrl()
}

/**
 * Release the production pools and the cached privilege assertion.
 *
 * `closePools` and `resetPrivilegeAssertionCacheForTests` are intentionally not
 * re-exported by `src/server/db/index.ts`; test teardown imports them from `./pool`
 * directly, which is what that module's comment prescribes. Resetting the assertion cache
 * matters because the cached promise is keyed to nothing: a worker that re-pointed at a
 * different database would otherwise keep a "role already verified" result taken against
 * the previous connection.
 */
export async function releaseProductionPools(): Promise<void> {
  resetPrivilegeAssertionCacheForTests()
  await closePools()
}
