/**
 * Sentinel rows and the assertion that makes tenancy tests non-vacuous.
 *
 * ===========================================================================
 * THE PROBLEM, AND WHY THE PORT MADE IT WORSE
 * ===========================================================================
 * V18/V19: an empty table with RLS and an empty table with no RLS both return 0 rows, and
 * a cross-user DELETE returns `DELETE 0` with no error, byte-identical to deleting a
 * nonexistent id. So "0 rows" is the same observation for a working policy, a failed seed,
 * a typo'd uuid and an empty table.
 *
 * Pre-port there was a SECOND signal: `app.require_user_id()` raised 28000, so a read with
 * no identity announced itself. `auth.uid()` returns NULL instead. MEASURED on this
 * emulation as `authenticated`: with no claim, `auth.uid()` is NULL, a read of
 * `public.decision` returns 0 rows, and NOTHING IS RAISED.
 *
 * On an EMPTY protected table there are therefore now three indistinguishable situations —
 * a correct policy, a broken policy, and no policy at all — all returning zero and raising
 * nothing. One reserved-owner row per protected table turns "0 rows" back into evidence:
 * the row WOULD come back if the policy were missing.
 *
 * `supabase/migrations/20261021140600_sentinels.sql` seeds exactly one such row per
 * owner-keyed protected table (plus the `auth.users` row its real foreign key requires),
 * and `20261021140700_scenario_content.sql` registers one per reference table in
 * `public.posture_sentinel_row`. Posture rules 9a and 9b are what notice when one is gone.
 *
 * ===========================================================================
 * WHAT CHANGED IN THIS FILE, AND WHAT IS GONE RATHER THAN MOVED
 * ===========================================================================
 *   * `NO_USER_CONTEXT = '28000'` IS DELETED, not re-pointed. No policy raises it any
 *     more and none should: a policy predicate that raised would give the local target a
 *     failure mode the live one does not have, and every local denial test would then be
 *     measuring the wrapper instead of the policy (docs/supabase-port-notes.md P2).
 *     The expectation has INVERTED — a claimless read that RAISES is now itself the
 *     anomaly, because it means something is reproducing the retired semantics.
 *   * `profile` joins the owner-keyed tables. It replaces `app_user`, and unlike `app_user`
 *     it is REACHABLE by `authenticated` (a signed-in user edits their own display name
 *     and there is no server left to proxy it), so it needs a sentinel like any other
 *     protected table rather than being protected by an absent grant.
 *   * The five REFERENCE tables are now checked here too. Their policy is
 *     `auth.uid() is not null`, so the pair is claimless-vs-any-claim rather than
 *     owner-vs-stranger, and their sentinel is keyed by the column named in
 *     `public.posture_sentinel_row`. Under the pre-port rule 9 these five were WAIVED and
 *     carried an unenforced sentinel — true the day it was written, with nothing to notice
 *     when it stopped being true.
 */
import {
  CLAIM_JSON_GUC,
  CLAIM_SUB_GUC,
  appQuery,
  ensureWorkerDatabase,
  ownerQuery,
  parseBoolean,
  runScopedAs,
  sqlstateOf,
  workerDatabaseName,
} from './db'

export const SENTINEL_USER_ID = '00000000-0000-0000-0000-00000000dead'
export const SENTINEL_DECISION_ID = '00000000-0000-0000-0000-00000000dec1'
export const SENTINEL_REVISION_ID = '00000000-0000-0000-0000-00000000dec2'
export const SENTINEL_IDEMPOTENCY_TOKEN = '00000000-0000-0000-0000-00000000dec3'

/**
 * The RLS-protected tables keyed by an OWNER column, and that column.
 *
 * `profile` is first because the FK chain is `decision -> profile -> auth.users`: a
 * missing profile sentinel is also a missing parent for the other two.
 */
export const PROTECTED_TABLES = [
  { table: 'profile', ownerColumn: 'user_id' },
  { table: 'decision', ownerColumn: 'user_id' },
  { table: 'decision_revision', ownerColumn: 'user_id' },
] as const

export type ProtectedTable = (typeof PROTECTED_TABLES)[number]['table']

/**
 * A uuid that owns nothing, used as the stranger's identity in the paired denial.
 *
 * It needs no row in `auth.users` and no profile: the claim is a GUC and carries no
 * foreign key, which is exactly why forgery has to be prevented by the policy's WITH
 * CHECK rather than by referential integrity.
 */
export const FOREIGN_USER_ID = '00000000-0000-0000-0000-00000000beef'

/** What a read of a protected table actually did. */
export type ReadOutcome =
  | { readonly kind: 'rows'; readonly count: number }
  | { readonly kind: 'raised'; readonly sqlstate: string }

export interface SentinelReport {
  readonly table: string
  /** How the table is protected, and therefore which pair is diagnostic. */
  readonly keyedBy: 'owner' | 'reference'
  /** Rows that exist, read as `postgres` (BYPASSRLS): existence, never visibility. */
  readonly seeded: number
  /** What `authenticated` observes with NO claim. Post-port: 0 rows, raising nothing. */
  readonly withoutClaim: ReadOutcome
  /** Rows visible WITH the entitled claim. The positive control. Must be 1. */
  readonly withEntitledClaim: number
  /** The same read under a stranger's claim. Must be 0 for owner-keyed tables. */
  readonly withStrangerClaim: number
}

/**
 * Read a protected table as `authenticated` with NO claim.
 *
 * MEASURED, and the expectation is now INVERTED from the pre-port version. `auth.uid()`
 * is STABLE and takes no arguments, so the executor evaluates it once at scan start; with
 * no claim it is NULL, `user_id = NULL` is never true, and the scan returns zero rows
 * having raised nothing at all.
 *
 * This leg therefore CANNOT distinguish a working policy from an empty table — that is
 * V18 exactly, and it is why the pair below is the discriminating evidence. It is recorded
 * because BOTH of its abnormal outcomes are fatal:
 *   * rows coming back means the policy is absent, mis-scoped, or the connection bypasses
 *     RLS;
 *   * an ERROR coming back means something is reproducing the retired 28000 semantics, or
 *     the grant is missing (42501), or the table is not there (42P01) — all three of which
 *     would read as "tenancy works" to a check that only asked "did it fail".
 */
async function readWithoutClaim(table: string): Promise<ReadOutcome> {
  try {
    const rows: string[][] = await appQuery(
      `select set_config('${CLAIM_SUB_GUC}', '', false);
       select set_config('${CLAIM_JSON_GUC}', '', false);
       select 'n', count(*)::text from public.${table}`,
    )
    const value = rows.find((r) => r[0] === 'n')?.[1]
    if (value === undefined) {
      throw new Error(`claimless read of ${table} returned no labelled row`)
    }
    return { kind: 'rows', count: Number.parseInt(value, 10) }
  } catch (error) {
    const code = sqlstateOf(error)
    if (code === undefined) throw error
    return { kind: 'raised', sqlstate: code }
  }
}

/**
 * Count rows of `table` matching `column = value`, visible to `authenticated` while
 * holding `claim`.
 *
 * The claim is installed by `runScopedAs`, which brackets the whole thing in an explicit
 * transaction, ASSERTS server-side that the claim took effect before this SQL runs, and
 * rolls back — so this instrument cannot leave state behind and cannot silently measure a
 * claim that never arrived. Rows are labelled so the count can be found without depending
 * on output ordering.
 */
async function countAs(
  table: string,
  column: string,
  value: string,
  claim: string,
): Promise<number> {
  const rows = await runScopedAs(
    claim,
    `select 'n', count(*)::text from public.${table} where ${column} = :'target';`,
    { vars: { target: value } },
  )
  const text = rows.find((r) => r[0] === 'n')?.[1]
  if (text === undefined) {
    throw new Error(`count of ${table} as ${claim} returned no labelled row`)
  }
  const parsed = Number.parseInt(text, 10)
  if (!Number.isInteger(parsed)) {
    throw new Error(`count of ${table} as ${claim} was not a number: '${text}'`)
  }
  return parsed
}

/** The reference tables and their sentinel keys, read from the registry as `postgres`. */
async function referenceSentinels(): Promise<
  { table: string; idColumn: string; sentinelId: string }[]
> {
  // `authenticated` cannot read this registry — MEASURED: 42501, which is deliberate
  // (migrate.sh runs the posture check as `postgres` for the same reason). Reading it
  // here rather than hardcoding the five rows means a table added to the registry is
  // covered by this assertion automatically, the same way posture rule 9b covers it.
  const rows = await ownerQuery(
    `select table_name, id_column, sentinel_id
       from public.posture_sentinel_row order by table_name`,
  )
  return rows.flatMap((r) => {
    const [table, idColumn, sentinelId] = r
    if (table === undefined || idColumn === undefined || sentinelId === undefined) return []
    if (!/^[a-z][a-z0-9_]{0,50}$/.test(table) || !/^[a-z][a-z0-9_]{0,50}$/.test(idColumn)) {
      throw new Error(`posture_sentinel_row holds an unsafe identifier: ${table}.${idColumn}`)
    }
    return [{ table, idColumn, sentinelId }]
  })
}

/**
 * Prove that every protected table carries a sentinel row AND that the sentinel is
 * invisible to an identity not entitled to it.
 *
 * Four legs per table, and the last two are the only ones an empty table cannot satisfy:
 *
 *   1. EXISTENCE, read as `postgres`. Reports that the seed landed. It is read through a
 *      BYPASSRLS connection, so it says nothing whatever about enforcement.
 *   2. RLS still FORCEd, read from the catalog. A table left ENABLE-without-FORCE would
 *      pass every other leg here while giving the owner an ordinary bypass.
 *   3. THE CLAIMLESS READ. Recorded; both of its abnormal outcomes are fatal; it is not
 *      evidence of denial on its own — see `readWithoutClaim`.
 *   4. THE PAIR. Same table, same WHERE clause, same role, same statement: the ONLY thing
 *      that differs is the claim. A difference of 1 vs 0 is attributable to the policy and
 *      to nothing else. For the reference tables the pair is claimless-vs-any-claim,
 *      because their policy is `auth.uid() is not null`.
 */
export async function assertSentinelIntegrity(): Promise<SentinelReport[]> {
  await ensureWorkerDatabase()
  const reports: SentinelReport[] = []
  const failures: string[] = []

  const owner = PROTECTED_TABLES.map((t) => ({
    table: t.table,
    column: t.ownerColumn,
    value: SENTINEL_USER_ID,
    keyedBy: 'owner' as const,
  }))
  const reference = (await referenceSentinels()).map((r) => ({
    table: r.table,
    column: r.idColumn,
    value: r.sentinelId,
    keyedBy: 'reference' as const,
  }))
  if (reference.length === 0) {
    // V7 applied to this instrument: an empty registry would make the reference half of
    // this assertion pass by iterating nothing, which is the failure mode the whole file
    // is about.
    failures.push(
      'public.posture_sentinel_row is EMPTY, so the reference-table half of this ' +
        'assertion checked nothing. Posture rule 9b requires every protected table with ' +
        'no user_id column to be registered there.',
    )
  }

  for (const { table, column, value, keyedBy } of [...owner, ...reference]) {
    // Leg 1 — existence, as `postgres`.
    const seededRows = await ownerQuery(
      `select count(*)::text from public.${table} where ${column} = :'target';`,
      { target: value },
    )
    const seededText = seededRows[0]?.[0]
    const seeded = seededText === undefined ? Number.NaN : Number.parseInt(seededText, 10)
    if (seeded !== 1) {
      failures.push(
        `public.${table}: expected exactly 1 sentinel row where ${column} = ${value}, ` +
          `found ${String(seededText ?? 'nothing')} — denial assertions against this ` +
          'table cannot fail and therefore prove nothing (V18)',
      )
    }

    // Leg 2 — the catalog.
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
          '— this worker would carry on with tenancy enforcement switched off for it',
      )
    }

    // Leg 3 — the claimless read.
    const withoutClaim = await readWithoutClaim(table)
    if (withoutClaim.kind === 'rows' && withoutClaim.count !== 0) {
      failures.push(
        `public.${table}: \`authenticated\` read ${withoutClaim.count} row(s) with NO ` +
          'claim set — the policy is absent, mis-scoped, or the connection bypasses RLS',
      )
    }
    if (withoutClaim.kind === 'raised') {
      failures.push(
        `public.${table}: the claimless read RAISED SQLSTATE ${withoutClaim.sqlstate}. ` +
          'Post-port it must return 0 rows and raise NOTHING (MEASURED). An error here ' +
          'means either something is reproducing the retired 28000 semantics — in which ' +
          'case every local denial test is measuring the wrapper rather than the policy ' +
          '— or the fault is 42501/42P01 wearing the denial\'s clothes.',
      )
    }

    // Leg 4 — the pair.
    const entitled = keyedBy === 'owner' ? SENTINEL_USER_ID : FOREIGN_USER_ID
    const withEntitledClaim = await countAs(table, column, value, entitled)
    const withStrangerClaim =
      keyedBy === 'owner'
        ? await countAs(table, column, value, FOREIGN_USER_ID)
        : // A reference table is readable by ANY signed-in identity by design
          // (`auth.uid() is not null`), so there is no stranger to deny and the
          // claimless leg above IS the negative half of this pair. Recording 0 here
          // would assert a denial that the policy does not promise, and a test that
          // asserts more than the design promises fails for the wrong reason later.
          Number.NaN

    if (withEntitledClaim !== 1) {
      failures.push(
        `public.${table}: \`authenticated\` sees ${withEntitledClaim} sentinel row(s) ` +
          `with the entitled claim (${entitled}), expected 1 — without this positive ` +
          'control the zero in leg 3 is satisfied by an empty table, a failed seed, a ' +
          'typo\'d id and a missing grant alike (V18/V19)',
      )
    }
    if (keyedBy === 'owner' && withStrangerClaim !== 0) {
      failures.push(
        `public.${table}: \`authenticated\` sees ${withStrangerClaim} sentinel row(s) ` +
          `under a stranger's claim (${FOREIGN_USER_ID}) — tenancy is not being enforced`,
      )
    }

    reports.push({
      table,
      keyedBy,
      seeded,
      withoutClaim,
      withEntitledClaim,
      withStrangerClaim,
    })
  }

  if (failures.length > 0) {
    throw new Error(
      'INTEGRATION HARNESS ABORTED — sentinel integrity failed on ' +
        `${workerDatabaseName()}:\n${failures.map((f) => `  - ${f}`).join('\n')}`,
    )
  }
  return reports
}
