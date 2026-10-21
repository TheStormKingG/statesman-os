/**
 * Sentinel rows and the assertion that makes tenancy tests non-vacuous.
 *
 * The problem (V18, V19): an empty table with RLS and an empty table with no RLS both
 * return 0 rows to statesman_app, and a cross-user DELETE returns `DELETE 0` with no
 * error, byte-identical to deleting a nonexistent id. So "0 rows" is the same observation
 * for a working policy, a failed seed, a typo'd uuid and an empty table. Every denial
 * assertion in the suite rests on a row existing that *would* come back if the policy
 * were missing.
 *
 * `migrations/0006_sentinels.sql` seeds exactly one such row per protected table, owned
 * by a reserved user, committed into the template and therefore present in every clone.
 */
import {
  appQuery,
  ensureWorkerDatabase,
  ownerQuery,
  parseBoolean,
  workerDatabaseName,
} from './db'

export const SENTINEL_USER_ID = '00000000-0000-0000-0000-00000000dead'
export const SENTINEL_DECISION_ID = '00000000-0000-0000-0000-00000000dec1'
export const SENTINEL_REVISION_ID = '00000000-0000-0000-0000-00000000dec2'
export const SENTINEL_IDEMPOTENCY_TOKEN = '00000000-0000-0000-0000-00000000dec3'

/** The RLS-protected tables, and the column that carries ownership on each. */
export const PROTECTED_TABLES = [
  { table: 'decision', ownerColumn: 'user_id' },
  { table: 'decision_revision', ownerColumn: 'user_id' },
] as const

export type ProtectedTable = (typeof PROTECTED_TABLES)[number]['table']

/** What a read of a protected table with no user context actually did. */
export type NoContextOutcome =
  | { readonly kind: 'raised'; readonly sqlstate: string }
  | { readonly kind: 'rows'; readonly count: number }

export interface SentinelReport {
  readonly table: ProtectedTable
  /** Rows the owner can see with the FORCE bracket off — the seed itself. */
  readonly seeded: number
  /** What the app role observes with no user context set. */
  readonly withoutContext: NoContextOutcome
  /** Sentinel rows visible to the app role AS the sentinel user. Must be 1. */
  readonly asOwnerContext: number
  /** The same read under a foreign user context. Must be 0. */
  readonly asForeignContext: number
}

/**
 * psql is run with VERBOSITY=verbose by db.ts, which prints the code inline as
 * `ERROR:  28000: no user context`. Measured against this cluster; without verbose the
 * line is `ERROR:  no user context` and carries no code at all.
 */
const PG_ERROR_WITH_CODE = /\bERROR:\s+([0-9A-Z]{5}):/

function sqlstateOf(error: unknown): string | undefined {
  const text = error instanceof Error ? error.message : String(error)
  return PG_ERROR_WITH_CODE.exec(text)?.[1]
}

/** The only SQLSTATE a no-context read of a protected table may raise. */
export const NO_USER_CONTEXT = '28000'

/**
 * A uuid that owns nothing. Used as the attacker's identity in the paired denial. It
 * does not need a row in app_user: the GUC carries no foreign key.
 */
export const FOREIGN_USER_ID = '00000000-0000-0000-0000-00000000beef'

/**
 * Read a protected table as the app role with NO user context.
 *
 * MEASURED, and narrower than it looks: on this cluster `select count(*)` raises 28000
 * whether or not the table holds any rows. `app.require_user_id()` is STABLE and takes
 * no arguments, so the executor evaluates it once at scan start rather than per candidate
 * row — V6's "the policy raises only when a candidate row reaches the qual" was observed
 * for an indexed point lookup, and does not generalise to a seq scan. The consequence is
 * that this leg CANNOT distinguish a working policy from an empty table, which is exactly
 * what V18 warns about. It is recorded because a row coming back here is still fatal, but
 * the discriminating evidence is the sentinel-context / foreign-context pair below.
 */
async function readWithoutContext(table: ProtectedTable): Promise<NoContextOutcome> {
  try {
    const rows = await appQuery(`select 'n', count(*)::text from public.${table}`)
    const value = rows.find((r) => r[0] === 'n')?.[1]
    if (value === undefined) {
      throw new Error(`no-context read of ${table} returned no labelled row`)
    }
    return { kind: 'rows', count: Number.parseInt(value, 10) }
  } catch (error) {
    const code = sqlstateOf(error)
    if (code === undefined) throw error
    return { kind: 'raised', sqlstate: code }
  }
}

/**
 * Count the sentinel rows of `table` visible to the app role while running as `userId`.
 *
 * The context is set the way production sets it — `set_config(..., true)` inside an
 * explicit transaction — and the transaction is rolled back, so this instrument cannot
 * leave state behind. Rows are labelled so the `set_config` result row can be told apart
 * from the count without depending on output ordering.
 */
async function countSentinelsAs(
  table: ProtectedTable,
  ownerColumn: string,
  userId: string,
): Promise<number> {
  const rows = await appQuery(
    `begin;
     select set_config('app.current_user_id', :'uid', true);
     select 'n', count(*)::text from public.${table} where ${ownerColumn} = :'sentinel';
     rollback;`,
    { uid: userId, sentinel: SENTINEL_USER_ID },
  )
  const value = rows.find((r) => r[0] === 'n')?.[1]
  if (value === undefined) {
    throw new Error(`sentinel count for ${table} as ${userId} returned no labelled row`)
  }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed)) {
    throw new Error(`sentinel count for ${table} as ${userId} was not a number: '${value}'`)
  }
  return parsed
}

export async function assertSentinelIntegrity(): Promise<SentinelReport[]> {
  await ensureWorkerDatabase()
  const reports: SentinelReport[] = []
  const failures: string[] = []

  for (const { table, ownerColumn } of PROTECTED_TABLES) {
    // Leg 1. The owner is subject to the policy under FORCE (V8), so the control has to
    // bracket FORCE off and back on — the same bracket the seed migration uses. The
    // re-FORCE is asserted from the catalog afterwards, because leaving it off would
    // make every later assertion in this worker vacuous.
    const rows = await ownerQuery(
      `alter table public.${table} no force row level security;
       select count(*)::text from public.${table} where ${ownerColumn} = :'uid';
       alter table public.${table} force row level security;`,
      { uid: SENTINEL_USER_ID },
    )
    const seededText = rows[0]?.[0]
    const seeded = seededText === undefined ? Number.NaN : Number.parseInt(seededText, 10)
    if (seeded !== 1) {
      failures.push(
        `public.${table}: expected exactly 1 sentinel row owned by ${SENTINEL_USER_ID}, ` +
          `found ${String(seededText ?? 'nothing')} — denial assertions against this ` +
          'table cannot fail and therefore prove nothing (V18)',
      )
    }

    const forced = await ownerQuery(
      `select c.relrowsecurity::text, c.relforcerowsecurity::text
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = :'rel';`,
      { rel: table },
    )
    const rlsEnabled = parseBoolean(forced[0]?.[0], `${table}.relrowsecurity`)
    const rlsForced = parseBoolean(forced[0]?.[1], `${table}.relforcerowsecurity`)
    if (!rlsEnabled || !rlsForced) {
      failures.push(
        `public.${table}: RLS is enabled=${String(rlsEnabled)} forced=${String(rlsForced)} ` +
          'after the control — the FORCE bracket did not close, so this worker would ' +
          'carry on with tenancy enforcement switched off',
      )
    }

    // Leg 2. Recorded, not relied on — see readWithoutContext for why.
    const withoutContext = await readWithoutContext(table)
    if (withoutContext.kind === 'rows' && withoutContext.count !== 0) {
      failures.push(
        `public.${table}: the app role read ${withoutContext.count} row(s) with no user ` +
          'context — the tenancy policy is absent, mis-scoped, or the connection role ' +
          'bypasses RLS',
      )
    }
    if (withoutContext.kind === 'raised' && withoutContext.sqlstate !== NO_USER_CONTEXT) {
      // Not every error is a denial. 42501 would mean the grants are wrong and 42P01
      // that the table is not there; either would read as "tenancy works" if the only
      // thing checked were "did it fail".
      failures.push(
        `public.${table}: the no-context read failed with SQLSTATE ` +
          `${withoutContext.sqlstate}, not ${NO_USER_CONTEXT} — that is a different ` +
          'fault wearing the denial\'s clothes',
      )
    }

    // Legs 3 and 4 — the paired denial of §8.2, and the only legs here that an empty
    // table cannot satisfy. Same table, same WHERE clause, same role, same statement:
    // the ONLY thing that differs is the user context, so a difference of 1 vs 0 is
    // attributable to the policy and to nothing else.
    const asOwnerContext = await countSentinelsAs(table, ownerColumn, SENTINEL_USER_ID)
    const asForeignContext = await countSentinelsAs(table, ownerColumn, FOREIGN_USER_ID)
    if (asOwnerContext !== 1) {
      failures.push(
        `public.${table}: the app role sees ${asOwnerContext} sentinel row(s) as the ` +
          'sentinel user, expected 1 — without this positive control the denial below ' +
          'is satisfied by an empty table, a failed seed and a typo alike (V18)',
      )
    }
    if (asForeignContext !== 0) {
      failures.push(
        `public.${table}: the app role sees ${asForeignContext} sentinel row(s) under a ` +
          `foreign user context (${FOREIGN_USER_ID}) — tenancy is not being enforced`,
      )
    }
    reports.push({ table, seeded, withoutContext, asOwnerContext, asForeignContext })
  }

  if (failures.length > 0) {
    throw new Error(
      `INTEGRATION HARNESS ABORTED — sentinel integrity failed on ` +
        `${workerDatabaseName()}:\n${failures.map((f) => `  - ${f}`).join('\n')}`,
    )
  }
  return reports
}
