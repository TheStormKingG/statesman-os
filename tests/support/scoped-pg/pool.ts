/**
 * TEST-ONLY (ADR-0015). Was src/server/db|src/server/session; it has no production
 * role now that the app talks to Supabase from the browser. See ./index.ts for
 * what moved, why, and the GUC incompatibility with supabase/migrations/.
 *
 * The connection pools, the role assertion, and the only `pg` import in the
 * codebase outside this directory's own files.
 *
 * MODULE-PRIVATE POOL. The `Pool` instances are closed over by this file and
 * never leave it: the only way to obtain a connection is `acquireAppClient` /
 * `acquireMigratorClient`, and neither of those is re-exported by `index.ts`.
 * A caller therefore cannot reach `pool.query(...)` and bypass `withUser`'s
 * identity, timeout and DISCARD ALL discipline — there is no reference to reach.
 *
 * Environment reading lives here, which is what keeps `scoped.ts` free of any
 * `process.env` access (canon 8.3).
 */

import { Pool, type PoolClient } from 'pg'
import { z } from 'zod'
import { ConfigurationError, MigratorMisuseError, PrivilegeAssertionError } from './errors'
import { privilegedRolePredicateSql, privilegedRoleReasonTextSql } from './privileged-role'

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

const connectionStringSchema = z.string().min(1)

/**
 * statement_timeout, in milliseconds.
 *
 * Validated as an integer because it is the one transaction-setup value that is
 * not a literal, and `set_config($1,$2,true)` carries it as a parameter. Nothing
 * is ever interpolated into SQL text.
 */
const statementTimeoutSchema = z.coerce.number().int().min(100).max(600_000)

function requireConnectionString(name: string): string {
  const parsed = connectionStringSchema.safeParse(process.env[name])
  if (!parsed.success) {
    throw new ConfigurationError(`${name} is not set`)
  }
  return parsed.data
}

function readStatementTimeoutMs(): number {
  const raw = process.env['DB_STATEMENT_TIMEOUT_MS']
  if (raw === undefined || raw === '') return 5_000
  const parsed = statementTimeoutSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ConfigurationError(
      `DB_STATEMENT_TIMEOUT_MS must be an integer between 100 and 600000, got ${JSON.stringify(raw)}`,
    )
  }
  return parsed.data
}

let cachedStatementTimeoutMs: number | undefined

/** The transaction-local statement_timeout every scoped transaction applies. */
export function statementTimeoutMs(): number {
  cachedStatementTimeoutMs ??= readStatementTimeoutMs()
  return cachedStatementTimeoutMs
}

/* ------------------------------------------------------------------ *
 * Pools
 * ------------------------------------------------------------------ */

let appPool: Pool | undefined
let migratorPool: Pool | undefined

function createPool(connectionString: string, label: string): Pool {
  const pool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 })
  // An error on an IDLE client is emitted on the pool, and an unhandled 'error'
  // event terminates the process. Swallowing it here keeps a dropped backend
  // from taking the server down; the next acquire fails loudly on its own.
  pool.on('error', (err: Error) => {
    console.error(`[db:${label}] idle client error: ${err.message}`)
  })
  return pool
}

/** INTERNAL. Not re-exported by `index.ts`. */
export async function acquireAppClient(): Promise<PoolClient> {
  appPool ??= createPool(requireConnectionString('APP_DATABASE_URL'), 'app')
  return appPool.connect()
}

/** INTERNAL. Not re-exported by `index.ts`. */
export async function acquireMigratorClient(): Promise<PoolClient> {
  migratorPool ??= createPool(requireConnectionString('MIGRATOR_DATABASE_URL'), 'migrator')
  return migratorPool.connect()
}

/** For test teardown and process shutdown. Not re-exported by `index.ts`. */
export async function closePools(): Promise<void> {
  const open = [appPool, migratorPool].filter((p): p is Pool => p !== undefined)
  appPool = undefined
  migratorPool = undefined
  await Promise.all(open.map((p) => p.end()))
}

/* ------------------------------------------------------------------ *
 * The role assertion
 * ------------------------------------------------------------------ */

const postureRowSchema = z.object({
  role_name: z.string(),
  database_name: z.string(),
  is_superuser: z.boolean(),
  is_bypassrls: z.boolean(),
  owned_relations: z.coerce.number().int(),
  privileged_reachable: z.coerce.number().int(),
  privileged_reachable_names: z.string(),
})

/**
 * Four independent facts in one round trip.
 *
 * - `is_superuser` / `is_bypassrls`: role attributes (V1).
 * - `owned_relations`: ownership bypasses RLS independently of those attributes
 *   (V4). Counted over tables, partitioned tables, views, matviews and foreign
 *   tables, because a view owner's privileges apply to a view over user data too
 *   (V11). `authenticated` owns nothing in `public` — MEASURED on the built
 *   template: `authenticated_public_tables_owned = 0` — so the wider net costs
 *   nothing and closes the view case.
 * - `privileged_reachable`: attributes are not inherited, but SET ROLE still
 *   works (V3), so reachability is tested with `pg_has_role(..., 'USAGE')` and
 *   `'MEMBER'`.
 *
 *   What counts as privileged is NOT written out here. It comes from
 *   `./privileged-role`, which is the single definition this guard and the
 *   integration harness guard (`assertTestConnectionIdentity`) both build from.
 *   They were previously two hand-written copies and they had drifted, with the
 *   HARNESS holding the stricter rule — it tested `rolcreaterole`,
 *   `rolcreatedb` and membership of `pg_read_all_data`/`pg_write_all_data` and
 *   this guard tested none of them. That is the worst possible direction for the
 *   drift to run, because it means the suite cannot see a weakness on the
 *   production side: a role that had acquired CREATEROLE was refused by the
 *   tests and accepted by the application.
 *
 *   POST-PORT, THE ROLE THIS CLAUSE EXISTS FOR IS `postgres` (ADR-0015).
 *   `statesman_owner` and `statesman_migrator` are retired. Supabase's
 *   `postgres` has `rolsuper = false` and `rolbypassrls = TRUE`, so an
 *   attribute-only test that asked about `rolsuper` alone would admit the one
 *   role on the platform that ignores every policy — and it is the role the CLI
 *   and the dashboard SQL editor use by default, so it is the role a typo lands
 *   on. The emulation also grants `anon`, `authenticated` and `service_role` TO
 *   `postgres` and TO `authenticator`, so the membership graph is real here, not
 *   hypothetical: `authenticator` is NOINHERIT and holds `service_role`, which
 *   is V3 exactly — an attribute check passes it while `SET ROLE` succeeds.
 *
 *   Because `pg_hba` is `trust` locally, a one-character typo in
 *   `APP_DATABASE_URL` connects successfully (V1) as whatever role it names,
 *   with no password error. MEASURED: `authenticated` reaches zero privileged
 *   roles by membership on the built template.
 *
 *   Each reachable role is reported WITH the reason codes that matched, so a
 *   control can assert which predicate did the catching. "It was refused" is
 *   satisfied just as well by a predicate that would have missed the role the
 *   test claims to cover.
 *
 *   The current role is excluded from this count, because its own ownership is
 *   already reported by `owned_relations`.
 */
const POSTURE_SQL = `
  with me as (
    select r.oid, r.rolname, r.rolsuper, r.rolbypassrls
      from pg_catalog.pg_roles r
     where r.rolname = current_user
  ),
  public_rel as (
    select c.relowner, count(*)::int as n
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace nsp on nsp.oid = c.relnamespace
     where nsp.nspname = 'public'
       and c.relkind in ('r', 'p', 'v', 'm', 'f')
     group by c.relowner
  ),
  reachable as (
    select p.rolname,
           ${privilegedRoleReasonTextSql('p')} as reasons
      from pg_catalog.pg_roles p, me
     where p.oid <> me.oid
       and ${privilegedRolePredicateSql('p')}
       and (pg_catalog.pg_has_role(me.oid, p.oid, 'USAGE')
         or pg_catalog.pg_has_role(me.oid, p.oid, 'MEMBER'))
  )
  select
    me.rolname                                                     as role_name,
    current_database()                                             as database_name,
    me.rolsuper                                                    as is_superuser,
    me.rolbypassrls                                                as is_bypassrls,
    coalesce((select pr.n from public_rel pr where pr.relowner = me.oid), 0) as owned_relations,
    (select count(*)::int from reachable)                          as privileged_reachable,
    coalesce((select string_agg(rolname || ' [' || reasons || ']', ', ' order by rolname)
                from reachable), '')                               as privileged_reachable_names
  from me
`

async function runPrivilegeAssertion(): Promise<void> {
  const client = await acquireAppClient()
  let row: unknown
  try {
    const result = await client.query(POSTURE_SQL)
    if (result.rows.length !== 1) {
      // Fails closed: no row means `current_user` is not in pg_roles, which
      // should be impossible, so the verdict is "unsafe", not "assume fine".
      throw new PrivilegeAssertionError(
        `role posture query returned ${String(result.rows.length)} rows; expected exactly 1`,
      )
    }
    row = result.rows[0]
  } finally {
    client.release()
  }

  const parsed = postureRowSchema.safeParse(row)
  if (!parsed.success) {
    throw new PrivilegeAssertionError(`role posture query returned an unexpected shape: ${parsed.error.message}`)
  }
  const posture = parsed.data

  // Report every violation, not the first. One failed start-up should tell the
  // operator everything that is wrong with the connection.
  const violations: string[] = []
  if (posture.is_superuser) violations.push('the role is a SUPERUSER')
  if (posture.is_bypassrls) violations.push('the role has BYPASSRLS')
  if (posture.owned_relations > 0) {
    violations.push(`the role owns ${String(posture.owned_relations)} relation(s) in schema public (ownership bypasses RLS)`)
  }
  if (posture.privileged_reachable > 0) {
    violations.push(
      `the role can SET ROLE to ${String(posture.privileged_reachable)} privileged role(s) ` +
        `(${posture.privileged_reachable_names})`,
    )
  }

  if (violations.length > 0) {
    throw new PrivilegeAssertionError(
      `refusing to serve user data as role "${posture.role_name}" on database "${posture.database_name}": ` +
        violations.join('; ') +
        '. The application must connect as a non-owner role without BYPASSRLS.',
    )
  }
}

let privilegeAssertion: Promise<void> | undefined

/**
 * Assert the app connection's role is safe for user data. Cached, so it runs
 * once per process, and awaited at the top of every entry point rather than
 * from a framework lifecycle hook — a new code path cannot forget it, because
 * the only way in already awaits it.
 *
 * A REJECTION IS NOT CACHED. A dropped connection during start-up would
 * otherwise brick the process permanently, and clearing the cache cannot turn a
 * failure into a pass: every retry re-reads the catalogue and must satisfy all
 * four conditions again.
 */
export function assertUnprivilegedOnce(): Promise<void> {
  if (privilegeAssertion === undefined) {
    privilegeAssertion = runPrivilegeAssertion().catch((err: unknown) => {
      privilegeAssertion = undefined
      throw err
    })
  }
  return privilegeAssertion
}

/** Test-only: forget the cached verdict so a fresh assertion runs. */
export function resetPrivilegeAssertionCacheForTests(): void {
  privilegeAssertion = undefined
}

/* ------------------------------------------------------------------ *
 * Keeping the migrator out of the request path
 * ------------------------------------------------------------------ */

/**
 * Refuse a privileged connection inside the Next.js server runtime.
 *
 * VERIFIED in the installed next@16.4.2: `node_modules/next/dist/bin/next` sets
 * `process.env.NEXT_RUNTIME = 'nodejs'` for every command, so `next dev`,
 * `next build` and `next start` all carry it, while a `tsx` or `vitest` process
 * does not. This is a real structural barrier for the supported run modes.
 *
 * RESIDUAL GAP: a custom server that calls Next programmatically (`node
 * server.js`) would not set the variable, so this check alone would not stop it.
 * `withMigrator` therefore pairs it with a request-context check.
 */
export function assertNotRequestRuntime(operation: string): void {
  const runtime = process.env['NEXT_RUNTIME']
  if (runtime !== undefined && runtime !== '') {
    throw new MigratorMisuseError(
      `${operation} is a migration/test-only entry point and must never run inside the ` +
        `Next.js server runtime (NEXT_RUNTIME=${runtime}). Use withUser from a request path.`,
    )
  }
}
