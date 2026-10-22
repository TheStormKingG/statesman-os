/**
 * TEST-ONLY (ADR-0015). Was src/server/db|src/server/session; it has no production
 * role now that the app talks to Supabase from the browser. See ./index.ts for
 * what moved, why, and the GUC incompatibility with supabase/migrations/.
 *
 * THE ONE RULE: what makes a Postgres role too privileged to serve user data.
 *
 * WHY THIS FILE EXISTS. The rule was previously written out twice, by hand, in
 * two places that are supposed to mirror each other:
 *
 *   - the production guard, `POSTURE_SQL` in `./pool.ts` (`assertUnprivilegedOnce`)
 *   - the harness guard, `assertTestConnectionIdentity` in
 *     `tests/integration/support/db.ts`
 *
 * They had DRIFTED, and in the dangerous direction: the harness guard tested
 * `rolcreaterole`, `rolcreatedb` and membership of `pg_read_all_data` /
 * `pg_write_all_data`; the production guard tested none of those. The harness
 * guard being the STRICTER of the two is the worst possible arrangement, because
 * the suite's job is to detect a production-side weakness and the suite was
 * holding the only copy of the missing predicates. A production role that had
 * acquired CREATEROLE, or membership of `pg_read_all_data`, would have been
 * refused by the test harness and ACCEPTED by the running application.
 *
 * So the rule now lives here once, as SQL text, and both guards build their
 * predicate from this module. Neither can be weakened without weakening the
 * other, which is what makes the suite able to see a change to the production
 * guard at all.
 *
 * NO `pg` IMPORT. This module is pure string construction, so the §6.1 import
 * boundary ("the pg driver may be imported only from src/server/db/") is not
 * involved and `tests/integration/support/db.ts` — which deliberately speaks to
 * Postgres through `psql` and never opens a Pool — can read the same rule.
 */

/**
 * One reason a role is too privileged, as a SQL boolean over a `pg_roles` alias.
 *
 * `code` is what the guard's error message names, so a control can assert WHICH
 * predicate fired rather than merely that something did. That distinction is the
 * whole value of the list: a test that only asserts "it was refused" passes just
 * as happily when the refusal came from a predicate that would have missed the
 * role it claims to catch.
 */
export interface PrivilegeReason {
  /** Stable token that appears in the guard's message. */
  readonly code: string
  /** Builds the SQL boolean for a `pg_roles` alias (e.g. `'p'`). */
  readonly sql: (alias: string) => string
  /** Why this makes a role unfit to serve user data. */
  readonly why: string
}

/**
 * Relation kinds whose OWNER is privileged over the data inside them.
 *
 * Tables and partitioned tables for V4 (ownership bypasses RLS under ENABLE,
 * independently of `rolsuper`/`rolbypassrls`). Views, matviews and foreign
 * tables because a view over an RLS table executes with the VIEW OWNER's
 * privileges unless `security_invoker = true` (V11), so owning the view is
 * owning the data it exposes.
 */
const OWNED_RELKINDS = "'r', 'p', 'v', 'm', 'f'"

/** A `pg_roles` alias is interpolated into SQL text, so it is constrained hard. */
const ALIAS = /^[a-z][a-z0-9_]{0,30}$/

function checkAlias(alias: string): string {
  if (!ALIAS.test(alias)) {
    throw new Error(`privileged-role: '${alias}' is not a usable SQL alias`)
  }
  return alias
}

/**
 * The rule, as an ordered list. Adding a reason here strengthens BOTH guards.
 */
export const PRIVILEGE_REASONS: readonly PrivilegeReason[] = [
  {
    code: 'SUPERUSER',
    sql: (a) => `${a}.rolsuper`,
    why: 'a superuser is exempt from every policy and every GRANT',
  },
  {
    code: 'BYPASSRLS',
    sql: (a) => `${a}.rolbypassrls`,
    why: 'BYPASSRLS makes every row-level policy inert',
  },
  {
    code: 'OWNS_PUBLIC_RELATION',
    sql: (a) =>
      `exists (select 1
                 from pg_catalog.pg_class c
                 join pg_catalog.pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public'
                  and c.relkind in (${OWNED_RELKINDS})
                  and c.relowner = ${a}.oid)`,
    why: 'relation ownership bypasses RLS under ENABLE, with no role attribute set (V4), and a view owner lends their privileges to the view (V11)',
  },
  {
    code: 'CREATEROLE',
    sql: (a) => `${a}.rolcreaterole`,
    why: 'CREATEROLE can mint a new role, grant itself that role, and act as it — an escalation path out of the app role',
  },
  {
    code: 'CREATEDB',
    sql: (a) => `${a}.rolcreatedb`,
    why: 'CREATEDB can create a database it owns, where it is free of this schema\'s policies and grants',
  },
  // ── The two blanket-data predefined roles.
  //
  // Neither sets BYPASSRLS, so neither is caught by an attribute check — but
  // `pg_read_all_data` confers SELECT on every table in every schema and
  // `pg_write_all_data` confers INSERT/UPDATE/DELETE. Canon §4.6 protects
  // `app_user`, `user_session` and `auth_attempt` by GRANT ABSENCE rather than by
  // RLS: the app role simply holds no privilege on them. Blanket access defeats
  // that protection completely, without touching a single role attribute or policy.
  //
  // They are RESERVED role names — `ALTER ROLE pg_read_all_data …` is refused by
  // the server ("Cannot alter reserved roles") — so they can only ever be acquired
  // by MEMBERSHIP, which is exactly what the reachability test measures.
  //
  // Kept as two separate reasons rather than one `rolname in (…)`: each is then a
  // predicate that can be removed on its own, so the mutation gate can show that
  // each has its own control rather than one control covering both.
  {
    code: 'PG_READ_ALL_DATA',
    sql: (a) => `${a}.rolname = 'pg_read_all_data'`,
    why: 'pg_read_all_data confers SELECT on every table, defeating the grant-absence protection on app_user, user_session and auth_attempt (§4.6)',
  },
  {
    code: 'PG_WRITE_ALL_DATA',
    sql: (a) => `${a}.rolname = 'pg_write_all_data'`,
    why: 'pg_write_all_data confers INSERT/UPDATE/DELETE on every table, including the append-only and immutable ones',
  },
]

/**
 * A `text[]` of the codes that match `alias`, with the non-matching entries
 * removed. Empty array means "this role is an ordinary data role".
 *
 * The predicate and the human-readable reasons are both derived from this one
 * expression, so a role can never be reported as privileged without naming the
 * reason, nor named without being counted.
 */
export function privilegedRoleReasonArraySql(alias: string): string {
  const a = checkAlias(alias)
  const cases = PRIVILEGE_REASONS.map((r) => `case when ${r.sql(a)} then '${r.code}' end`).join(
    ',\n      ',
  )
  return `array_remove(array[\n      ${cases}\n    ], null)`
}

/** True when the role at `alias` is too privileged to serve user data. */
export function privilegedRolePredicateSql(alias: string): string {
  return `cardinality(${privilegedRoleReasonArraySql(alias)}) > 0`
}

/** The matching codes as a `+`-joined string, for an error message. */
export function privilegedRoleReasonTextSql(alias: string): string {
  return `array_to_string(${privilegedRoleReasonArraySql(alias)}, '+')`
}

/** Every reason code, for a test that asserts the rule is stated once. */
export const PRIVILEGE_REASON_CODES: readonly string[] = PRIVILEGE_REASONS.map((r) => r.code)
