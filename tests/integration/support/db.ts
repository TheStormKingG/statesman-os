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
 *    be imported only inside `tests/support/scoped-pg/**` (§6.1), enforced by an AST check, and a
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
import { withMigrator, withUser } from '../../support/scoped-pg'
import type { MigratorClient, UserScopedClient } from '../../support/scoped-pg'
// THE ONE RULE for "is this role too privileged to serve user data". Shared with the
// production guard (POSTURE_SQL in tests/support/scoped-pg/pool.ts) so the two cannot drift —
// they had, and the harness was holding the stricter copy. No `pg` import is involved:
// the module is pure SQL-string construction.
import { privilegedRolePredicateSql } from '../../support/scoped-pg/privileged-role'
// closePools / resetPrivilegeAssertionCacheForTests are deliberately NOT part of the
// db module's public surface; its own comment says test setup imports them from here.
import { closePools, resetPrivilegeAssertionCacheForTests } from '../../support/scoped-pg/pool'
import { enterIdentityContext } from '../../support/scoped-pg/session'

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
  /**
   * The role the DATA-PATH tests connect as: `authenticated` (ADR-0015 §8.3). It is a
   * LOGIN role in scripts/emulate-supabase.sh and pg_hba is `trust`, so this connects
   * with no password — which is also why the role is read back out of the live
   * connection rather than trusted (see `roleFromBase`).
   *
   * The variable keeps its pre-port NAME so that every call site and every mutation that
   * points at it stays valid. Its VALUE is the whole port: `statesman_app` does not exist
   * on a Supabase project and `authenticated` is what PostgREST resolves a signed-in
   * browser to.
   */
  TEST_APP_DATABASE_URL_BASE: z
    .string()
    .min(1)
    .default('postgres://authenticated@127.0.0.1:5432'),
  /**
   * The role FIXTURE SETUP connects as. Was `statesman_migrator`, a member of
   * `statesman_owner`; both are retired (ADR-0015 §4.1) and `postgres` owns every
   * relation in `public` directly, so no SET ROLE is needed any more.
   *
   * `postgres` IS BYPASSRLS. That is the single most dangerous fact of this port, so this
   * connection is confined to `ownerQuery()` and that function's comment forbids making
   * an enforcement assertion through it.
   */
  TEST_MIGRATOR_DATABASE_URL_BASE: z
    .string()
    .min(1)
    .default('postgres://postgres@127.0.0.1:5432'),
  TEST_TEMPLATE_DB: z.string().regex(IDENTIFIER).default('statesman_test_template'),
  TEST_ADMIN_DB: z.string().regex(IDENTIFIER).default('postgres'),
  /**
   * CREATE DATABASE needs rolcreatedb, and a clone must be handed to another OWNER
   * (see `createWorkerDatabase`), so cloning runs as the bootstrap superuser — the role
   * V10 already designates for pg_dump. It is used for DDL and catalog reads only and is
   * never handed to a test; `assertTestConnectionIdentity()` proves the connection the
   * tests use is `authenticated`.
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
 * This is deliberately NOT the literal 'authenticated'. pg_hba is `trust` for local
 * connections, so a typo'd or escalated username in TEST_APP_DATABASE_URL_BASE connects
 * successfully as whatever role it names, with no password error (V1) — that is the
 * failure this harness exists to catch. Hardcoding the role in the connection and then
 * asserting the connection's role is 'authenticated' would be a gate that cannot fail.
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

/** The role the data-path tests connect as. Asserted to be `authenticated`, not assumed. */
export function appRole(): string {
  return roleFromBase(harnessEnv().TEST_APP_DATABASE_URL_BASE, 'TEST_APP_DATABASE_URL_BASE')
}

/** The role fixture setup connects as: `postgres`, which owns schema `public`'s relations. */
export function migratorRole(): string {
  return roleFromBase(
    harnessEnv().TEST_MIGRATOR_DATABASE_URL_BASE,
    'TEST_MIGRATOR_DATABASE_URL_BASE',
  )
}

/**
 * ADR-0015 §"the trap this introduces": the harness must assert
 * `current_user = 'authenticated'`. Spelled once, here, so the guard and its failure
 * message cannot disagree about what the expectation was.
 */
export const EXPECTED_APP_ROLE = 'authenticated'

/**
 * The GUCs `auth.uid()` coalesces — the flattened claim and the `sub` member of the JSON
 * claims object, which is Supabase's published definition and what
 * scripts/emulate-supabase.sh reproduces. BOTH are written by every scoped run: setting
 * one while a stale value sits in the other resolves to whichever the coalesce prefers.
 */
export const CLAIM_SUB_GUC = 'request.jwt.claim.sub'
export const CLAIM_JSON_GUC = 'request.jwt.claims'

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
  // TWO things do not travel with CREATE DATABASE ... TEMPLATE, and scripts/db-template.sh
  // prints both requirements at the end of every build (port finding P10).
  //
  // 1. THE OWNER. CREATE DATABASE sets the owner to the CREATING role, so a clone made by
  //    the bootstrap superuser would be owned by it rather than by `postgres` — which
  //    changes what `pg_database_owner` resolves to and therefore who owns schema
  //    `public`, which posture rules 1b, 2 and 3 are all written against. MEASURED on a
  //    clone made with OWNER postgres: `public` is owned by `pg_database_owner` and
  //    `public.decision` by `postgres`, matching the template exactly.
  await psql('create database :"db" template :"tpl" owner postgres;', {
    db: env.TEST_ADMIN_DB,
    vars: { db: name, tpl: env.TEST_TEMPLATE_DB },
  })
  // 2. THE DATABASE ACL. `revoke temporary on database` is applied by
  //    20261021140000_harden_public_schema.sql against current_database(), so the TEMPLATE
  //    has it and a CLONE does not. MEASURED on a clone before this revoke:
  //    has_database_privilege('authenticated', …, 'TEMP') is TRUE, inherited from PUBLIC.
  //    V22: a temp table shadows an unqualified reference to a real one, so an
  //    `authenticated` session holding TEMPORARY can substitute its own `public.decision`
  //    for the duration of a connection. The template passing this check therefore proves
  //    nothing about a clone, and the assertion in assertTestConnectionIdentity() is what
  //    proves this statement ran.
  //
  //    The pre-port version also re-granted CREATE on the database to `statesman_owner`.
  //    That role is retired and nothing in the Supabase-shaped set creates objects after
  //    migration time, so the grant is dropped rather than translated.
  await psql('revoke temporary on database :"db" from public;', {
    db: env.TEST_ADMIN_DB,
    vars: { db: name },
    singleTransaction: true,
  })
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
  /** `auth.uid()` with NO claim set. MUST be undefined (SQL NULL), and must not raise. */
  readonly uidWithoutClaim: string | undefined
  /** The claim GUC read back INSIDE the probe transaction. MUST be the probe id. */
  readonly claimObserved: string | undefined
  /** `auth.uid()` inside the probe transaction. MUST equal `claimObserved`. */
  readonly uidWithClaim: string | undefined
}

/**
 * The identity the guard's probe transaction sets. It owns nothing and is NOT the
 * sentinel, so a guard that somehow leaked a committed row would leave a traceable
 * orphan rather than a plausible-looking one. The probe transaction is rolled back.
 */
const GUARD_PROBE_UID = '00000000-0000-0000-0000-0000000060a0'

/**
 * Measure the identity of the connection the tests will use, on the worker's own
 * database, and throw if any check fails.
 *
 * Why each check:
 *
 *   - current_user: pg_hba is `trust` locally, so a typo'd role connects successfully as
 *     whatever it names, with no password error (V1). The name is read back out of the
 *     live connection rather than asserted against the string we put in the URL.
 *
 *   - rolbypassrls: THE check this port exists for. Supabase's `postgres` has it while
 *     `rolsuper` is FALSE, so it reads as a restricted role while enforcing nothing, and
 *     it is the role the CLI and the dashboard SQL editor use by default (ADR-0015,
 *     docs/supabase-target.md §2). MEASURED: pointed at `postgres`, this guard reports
 *     rolbypassrls = true and 11 owned relations in `public`, and aborts.
 *
 *   - rolsuper: kept although no Supabase project has a superuser, because the LOCAL
 *     cluster does (the macOS login role, `trust` auth — V1) and that is where a mis-set
 *     TEST_APP_DATABASE_URL_BASE lands by accident.
 *
 *   - relations owned in `public`: ownership bypasses RLS independently of role
 *     attributes (V4), so the attribute checks above do not cover it. relkind now
 *     includes views and matviews as well as tables: a view the connection owns is a read
 *     path whose policy is evaluated as the VIEW OWNER, not the caller (V11).
 *
 *   - reachable privileged roles: attributes are not inherited, but SET ROLE still works
 *     (V3), so attribute checks alone are insufficient. WHICH roles count as privileged
 *     comes from `tests/support/scoped-pg/privileged-role.ts`, which already names
 *     `rolbypassrls` among its reasons — so a membership route to Supabase's `postgres`,
 *     `service_role` or `supabase_admin` is caught by the same predicate that catches a
 *     superuser. Note this question is NARROWER than posture rule 11 and admits no
 *     allowlist: rule 11 asks which bypassrls roles may EXIST (the platform requires
 *     four), while this asks whether the TEST CONNECTION can reach one, for which the
 *     answer is always no.
 *
 *   - TEMP on the database: re-revoked per clone, see createWorkerDatabase (V22).
 *
 *   - THE CLAIM. ADR-0015 requires the guard to assert that a JWT claim is actually set,
 *     and this is where "assert, do not assume" bites hardest, because post-port the
 *     failure is silent in BOTH directions:
 *       * with no claim, `auth.uid()` must be NULL and must RAISE NOTHING. If it raises,
 *         something is reproducing the retired `28000` semantics and every denial test in
 *         the run is measuring the emulation instead of the policy.
 *       * with the claim set inside an EXPLICIT transaction, `current_setting` must return
 *         it and `auth.uid()` must equal it. MEASURED on this emulation: the same
 *         `set_config(…, true)` issued OUTSIDE a transaction block leaves the next
 *         statement reading the empty string. So this pair is the only thing that
 *         distinguishes "identity travels" from "identity silently does not" — and an
 *         identity that silently does not travel yields 0 rows and no error from every
 *         protected table, which is indistinguishable from correct denial.
 */
export interface ConnectionIdentityOptions {
  /**
   * Connect as this role instead of `appRole()`.
   *
   * FOR THE GUARD'S OWN NEGATIVE CONTROL AND NOTHING ELSE. ADR-0015 requires this
   * guard to abort rather than warn and requires a mutation proving it bites
   * (M22), and a mutation can only be CAUGHT by a test that drives the guard's
   * failure path. The guard otherwise reads its role out of the live connection
   * precisely so it cannot be told what to find (see `roleFromBase`), so this
   * parameter does not relax that: the role still has to be read back from
   * `current_user`, and the caller's job is to assert that the guard REFUSED it
   * and named the right predicate.
   *
   * No fixture, data read or enforcement assertion may pass this. The one
   * legitimate caller is the instrument test in tenancy.test.ts.
   */
  readonly role?: string | undefined
}

export async function assertTestConnectionIdentity(
  databaseName = workerDatabaseName(),
  options: ConnectionIdentityOptions = {},
): Promise<ConnectionIdentity> {
  // One psql script, one connection, one explicit transaction, rolled back. The CLAIMLESS
  // legs run BEFORE the claim is set, because set_config(…, true) survives to the end of
  // the transaction and would otherwise contaminate them.
  const rows = await queryRows(
    `begin;
     select 'noclaim', coalesce(auth.uid()::text, '');
     select set_config('${CLAIM_SUB_GUC}', :'probe', true);
     select set_config('${CLAIM_JSON_GUC}', '', true);
     select 'claim',
            coalesce(nullif(current_setting('${CLAIM_SUB_GUC}', true), ''), ''),
            coalesce(auth.uid()::text, '');
     select 'ident',
            current_database(),
            current_user,
            (select r.rolsuper     from pg_roles r where r.rolname = current_user)::text,
            (select r.rolbypassrls from pg_roles r where r.rolname = current_user)::text,
            (select count(*) from pg_class c
                join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind in ('r','p','v','m')
                and pg_get_userbyid(c.relowner) = current_user)::text,
            coalesce((select string_agg(r.rolname, ',' order by r.rolname)
               from pg_roles r
              where r.rolname <> current_user
                and ${privilegedRolePredicateSql('r')}
                and (pg_has_role(current_user, r.oid, 'USAGE')
                  or pg_has_role(current_user, r.oid, 'MEMBER'))), ''),
            has_database_privilege(current_user, current_database(), 'TEMP')::text;
     rollback;`,
    {
      db: databaseName,
      role: options.role ?? appRole(),
      vars: { probe: GUARD_PROBE_UID },
    },
  )

  const labelled = (label: string): string[] => {
    const row = rows.find((r) => r[0] === label)
    if (row === undefined) {
      throw new Error(
        `role-guard query returned no '${label}' row. Rows seen: ${JSON.stringify(rows)}. ` +
          'A missing label means the probe transaction did not run to completion, which ' +
          'is itself a harness failure and is never a pass.',
      )
    }
    return row
  }

  const noclaim = labelled('noclaim')
  const claim = labelled('claim')
  const ident = labelled('ident')
  const [, database, currentUser, superText, bypassText, ownedText, reachable, tempText] =
    ident
  if (
    database === undefined ||
    currentUser === undefined ||
    superText === undefined ||
    bypassText === undefined ||
    ownedText === undefined ||
    reachable === undefined ||
    tempText === undefined
  ) {
    throw new Error(`role-guard 'ident' row returned ${ident.length} columns, expected 8`)
  }

  // psql prints SQL NULL and the empty string identically (-t -A), which is why every
  // column above is coalesced in SQL. Here the empty string means "absent".
  const absent = (value: string | undefined): string | undefined =>
    value === undefined || value === '' ? undefined : value

  const identity: ConnectionIdentity = {
    database,
    currentUser,
    isSuperuser: parseBoolean(superText, 'pg_roles.rolsuper'),
    bypassesRls: parseBoolean(bypassText, 'pg_roles.rolbypassrls'),
    publicTablesOwned: Number.parseInt(ownedText, 10),
    reachablePrivilegedRoles: reachable === '' ? [] : reachable.split(','),
    holdsTempOnDatabase: parseBoolean(tempText, 'has_database_privilege(TEMP)'),
    uidWithoutClaim: absent(noclaim[1]),
    claimObserved: absent(claim[1]),
    uidWithClaim: absent(claim[2]),
  }

  const failures: string[] = []
  if (identity.currentUser !== EXPECTED_APP_ROLE) {
    failures.push(
      `current_user is '${identity.currentUser}', expected '${EXPECTED_APP_ROLE}'. ` +
        'TEST_APP_DATABASE_URL_BASE names that role and pg_hba `trust` accepted it ' +
        'without a password error (V1).',
    )
  }
  if (identity.isSuperuser) {
    failures.push('connection role is a SUPERUSER — RLS would not be applied at all')
  }
  if (identity.bypassesRls) {
    failures.push(
      'connection role has BYPASSRLS — RLS would not be applied at all. On Supabase this ' +
        'is `postgres`, whose rolsuper is FALSE, so it reads as a restricted role while ' +
        'enforcing nothing, and it is the role the CLI and the dashboard SQL editor use ' +
        'by default (ADR-0015; docs/supabase-target.md §2). Tenancy, cross-user denial ' +
        'and forgery would all pass vacuously.',
    )
  }
  if (!Number.isInteger(identity.publicTablesOwned)) {
    failures.push(`could not read owned-relation count (got '${ownedText}')`)
  } else if (identity.publicTablesOwned !== 0) {
    failures.push(
      `connection role owns ${identity.publicTablesOwned} relation(s) in schema public — ` +
        'ownership bypasses RLS independently of role attributes (V4), and a view it owns ' +
        'is evaluated as the view owner rather than the caller (V11)',
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
        'unqualified reference to a real one (V22). Either the clone-time REVOKE in ' +
        'createWorkerDatabase did not run, or the role is privileged enough to hold it ' +
        'regardless. The DATABASE ACL does not travel with CREATE DATABASE ... TEMPLATE, ' +
        'so the template passing this check proves nothing about a clone.',
    )
  }
  if (identity.database !== databaseName) {
    failures.push(`connected to '${identity.database}', expected '${databaseName}'`)
  }

  // --- the identity path itself, which post-port fails silently in both directions ---
  if (identity.uidWithoutClaim !== undefined) {
    failures.push(
      `auth.uid() returned '${identity.uidWithoutClaim}' with NO claim set, expected ` +
        'NULL. A non-null identity with no claim means every "0 rows" denial in this run ' +
        'would have been measured against the wrong user.',
    )
  }
  if (identity.claimObserved !== GUARD_PROBE_UID) {
    failures.push(
      `the claim GUC read back as '${String(identity.claimObserved)}' inside the probe ` +
        `transaction, expected '${GUARD_PROBE_UID}'. No JWT claim is reaching the ` +
        `database. MEASURED: set_config('${CLAIM_SUB_GUC}', …, true) issued OUTSIDE an ` +
        'explicit transaction leaves the NEXT statement reading the empty string, so a ' +
        'scoped run that lost its BEGIN would execute with auth.uid() NULL, see zero ' +
        'rows, raise nothing, and pass. Three separate checks in this project have ' +
        'already been invalidated by a SET LOCAL that did nothing.',
    )
  }
  if (identity.uidWithClaim !== identity.claimObserved) {
    failures.push(
      `auth.uid() returned '${String(identity.uidWithClaim)}' while the claim GUC held ` +
        `'${String(identity.claimObserved)}'. The identity accessor is not reading the ` +
        'claim this harness sets, so no assertion in this run addresses the user it names.',
    )
  }

  if (failures.length > 0) {
    throw new Error(
      'INTEGRATION HARNESS ABORTED — the test connection is not an unprivileged ' +
        '`authenticated` session carrying a JWT claim, so every tenancy assertion in ' +
        'this run would pass without testing anything:\n' +
        `${failures.map((f) => `  - ${f}`).join('\n')}\n` +
        'Fatal by design: ADR-0015 requires this guard to ABORT, not warn. Mutation M22 ' +
        'is the standing proof that it bites.',
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

/**
 * Run SQL against this worker's database as `authenticated` with NO claim set.
 *
 * READ THE RESULT CAREFULLY. Pre-port this ran as `statesman_app` and a read of a
 * protected table RAISED 28000, so a result here was self-describing. Post-port
 * `auth.uid()` returns NULL, the read returns 0 rows, and NOTHING is raised (MEASURED).
 * A zero from this function is therefore indistinguishable from an empty table, a typo'd
 * id, a failed seed or a missing grant (V7/V18/V19), and is evidence of denial ONLY when
 * paired with a positive control showing the same statement return rows WITH a claim.
 * `runScopedAs` is the other half of that pair and support/sentinels.ts builds it for
 * every protected table.
 */
export async function appQuery(
  sql: string,
  vars?: Readonly<Record<string, string>>,
): Promise<string[][]> {
  await ensureWorkerDatabase()
  return queryRows(sql, { db: workerDatabaseName(), role: appRole(), vars })
}

/**
 * Run SQL against this worker's database as `postgres`. FIXTURE SETUP AND CATALOG READS
 * ONLY.
 *
 * `postgres` owns every relation in `public` AND is BYPASSRLS, so NO ENFORCEMENT
 * ASSERTION MAY BE MADE THROUGH THIS FUNCTION. A tenancy, denial or forgery probe run
 * here passes while enforcing nothing — ADR-0015 calls that the single most dangerous
 * fact of the port, and it is why `assertTestConnectionIdentity()` aborts rather than
 * warns. A read through this function reports EXISTENCE; VISIBILITY is what `runAsUser`
 * and `runScopedAs` measure, because only they carry an identity the policy consults.
 *
 * Two pre-port shapes are gone with the roles they named: there is no
 * `set role statesman_owner` (the role is retired, ADR-0015 §4.1) and no NO FORCE / FORCE
 * bracket is needed for a READ, because BYPASSRLS is not FORCE-sensitive. A bracket is
 * still needed around a WRITE issued by a merely-owning role (V8), which is why
 * 20261021140600_sentinels.sql keeps one.
 */
export async function ownerQuery(
  sql: string,
  vars?: Readonly<Record<string, string>>,
): Promise<string[][]> {
  await ensureWorkerDatabase()
  return queryRows(sql, {
    db: workerDatabaseName(),
    role: migratorRole(), // `postgres`: owns public's relations, and is BYPASSRLS
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
 * Exposed for fixture setup that has to reach what `authenticated` cannot: the three
 * posture registries (`posture_exempt_table`, `posture_bypassrls_allow`,
 * `posture_sentinel_row`), which hold no grants to any client role — MEASURED: as
 * `authenticated`, `select from public.posture_sentinel_row` fails with 42501 — and
 * `auth.users`, which belongs to GoTrue. The pre-port list (app_user, user_session,
 * auth_attempt) is gone: ADR-0015 retires ADR-0002 and 20261021140200 replaces all three
 * with `public.profile`, which `authenticated` CAN reach because a signed-in user edits
 * their own display name with no server to proxy it.
 *
 * `withMigrator` refuses to run inside an open identity context, so this cannot be nested
 * inside `runAsUser`.
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
 * re-exported by `tests/support/scoped-pg/index.ts`; test teardown imports them from `./pool`
 * directly, which is what that module's comment prescribes. Resetting the assertion cache
 * matters because the cached promise is keyed to nothing: a worker that re-pointed at a
 * different database would otherwise keep a "role already verified" result taken against
 * the previous connection.
 */
export async function releaseProductionPools(): Promise<void> {
  resetPrivilegeAssertionCacheForTests()
  await closePools()
}

// ---------------------------------------------------------------------------
// The claim-carrying psql seam
// ---------------------------------------------------------------------------

/**
 * psql is run with VERBOSITY=verbose, which prints the code inline as
 * `ERROR:  42501: new row violates row-level security policy`. MEASURED against this
 * cluster; without verbose the line carries no code at all, and a caller that cannot read
 * a SQLSTATE cannot tell a denial from a missing table.
 */
const PG_ERROR_WITH_CODE = /\bERROR:\s+([0-9A-Z]{5}):/

/** The SQLSTATE psql reported, or undefined if the failure carried none. */
export function sqlstateOf(error: unknown): string | undefined {
  const text = error instanceof Error ? error.message : String(error)
  return PG_ERROR_WITH_CODE.exec(text)?.[1]
}

/** The psql variable a scoped run publishes its own user id under, for the caller's SQL. */
export const SCOPED_UID_VAR = 'stm_uid'

/** The label `runScopedAs` tags its own identity row with, so callers never see it. */
export const SCOPED_IDENTITY_LABEL = '__stm_identity__'

export interface ScopedRunOptions {
  /** psql variables for the caller's SQL. `stm_uid` is added automatically. */
  readonly vars?: Readonly<Record<string, string>> | undefined
  /**
   * COMMIT instead of ROLLBACK. Default false.
   *
   * Rollback is the default because the common case is a probe, and a probe that commits
   * leaves the next assertion in the same worker measuring the previous one's residue.
   * Fixture writes that must persist pass `commit: true` explicitly, so every committing
   * scoped run is visible at its call site.
   */
  readonly commit?: boolean | undefined
}

/**
 * Run `sql` as `userId` over psql, with the identity claim set the way PostgREST sets it.
 *
 * ===========================================================================
 * WHY THIS EXISTS ALONGSIDE `runAsUser`
 * ===========================================================================
 * `runAsUser` goes through the scoped `pg` client, which owns a transaction preamble and
 * is the right seam for application-shaped work. This function is for the cases that
 * preamble cannot serve: multi-statement SQL scripts, catalog reads taken under an
 * identity, DDL probes inside a rolled-back transaction, and the paired controls in
 * support/sentinels.ts — all of which need to be a SCRIPT rather than a sequence of
 * client calls.
 *
 * ===========================================================================
 * WHY IT IS NOT A ONE-LINE set_config
 * ===========================================================================
 *   * AN EXPLICIT TRANSACTION. `set_config(…, true)` is `SET LOCAL`. MEASURED on this
 *     emulation: issued outside a transaction block it is scoped to that single statement
 *     and the NEXT statement reads the empty string. A scoped run without the `begin`
 *     would run every following statement with `auth.uid()` NULL — which post-port
 *     returns 0 rows and raises nothing, so it would PASS. Three separate checks in this
 *     project have already been invalidated by a SET LOCAL that did nothing, which is why
 *     this is asserted rather than assumed.
 *
 *   * THE SETTING IS ASSERTED IN TWO INDEPENDENT PLACES:
 *       - server-side, in a DO block that RAISES ST099 BEFORE the caller's SQL runs, so
 *         psql exits non-zero and this function rejects instead of returning rows;
 *       - client-side, by reading the resolved id back out of a labelled row and
 *         comparing it to the id that was requested.
 *     The server-side half cannot compare against the requested id directly, because psql
 *     does NOT interpolate variables inside a dollar-quoted string — a `do $$ … :'uid' …
 *     $$` block receives the text `:'uid'` verbatim. It asserts instead that the GUC is
 *     non-empty and that `auth.uid()` agrees with it; the client-side half closes the gap.
 *
 *   * BOTH GUC FORMS ARE WRITTEN, because `auth.uid()` coalesces them and a stale value
 *     in the other one would win.
 *
 * DECLARED GAP: what this reproduces is the GUC PostgREST sets. It reproduces nothing
 * about JWT issuance or verification, which live in GoTrue and are not in the emulation
 * at all (docs/supabase-port-notes.md §3). A test passing here says nothing about whether
 * a real token would have produced this claim.
 */
export async function runScopedAs(
  userId: string,
  sql: string,
  options: ScopedRunOptions = {},
): Promise<string[][]> {
  if (!UUID.test(userId)) {
    throw new Error(`runScopedAs: '${userId}' is not an 8-4-4-4-12 hex uuid`)
  }
  await ensureWorkerDatabase()

  const script =
    'begin;\n' +
    `select set_config('${CLAIM_SUB_GUC}', :'${SCOPED_UID_VAR}', true);\n` +
    `select set_config('${CLAIM_JSON_GUC}', '', true);\n` +
    'do $stm_scope$\n' +
    'declare claim text; uid text;\n' +
    'begin\n' +
    `  claim := nullif(current_setting('${CLAIM_SUB_GUC}', true), '');\n` +
    '  if claim is null then\n' +
    "    raise exception 'SCOPED RUN HAS NO IDENTITY: the claim GUC is unset inside the " +
    "transaction. set_config(..., true) is SET LOCAL and does nothing outside an explicit " +
    "transaction block.' using errcode = 'ST099';\n" +
    '  end if;\n' +
    '  uid := auth.uid()::text;\n' +
    '  if uid is null then\n' +
    "    raise exception 'SCOPED RUN HAS NO IDENTITY: the claim is %, but auth.uid() is " +
    "NULL. Post-port that means 0 rows and no error from every protected table, so this " +
    "run would have passed while addressing nobody.', claim using errcode = 'ST099';\n" +
    '  end if;\n' +
    '  if uid <> claim then\n' +
    "    raise exception 'SCOPED RUN IDENTITY MISMATCH: claim is %, auth.uid() is %', " +
    "claim, uid using errcode = 'ST099';\n" +
    '  end if;\n' +
    'end $stm_scope$;\n' +
    `select '${SCOPED_IDENTITY_LABEL}', auth.uid()::text;\n` +
    `${sql}\n` +
    (options.commit === true ? 'commit;' : 'rollback;')

  const rows = await queryRows(script, {
    db: workerDatabaseName(),
    role: appRole(),
    vars: { ...(options.vars ?? {}), [SCOPED_UID_VAR]: userId },
  })

  const resolved = rows.find((r) => r[0] === SCOPED_IDENTITY_LABEL)?.[1]
  if (resolved !== userId) {
    throw new Error(
      `runScopedAs: asked for '${userId}' but auth.uid() resolved to '${String(resolved)}'. ` +
        'The server-side guard passed, so the claim WAS set and DID agree with ' +
        'auth.uid() — it simply was not the identity requested. Every assertion in this ' +
        'block addressed the wrong user.',
    )
  }
  return rows.filter((r) => r[0] !== SCOPED_IDENTITY_LABEL)
}
