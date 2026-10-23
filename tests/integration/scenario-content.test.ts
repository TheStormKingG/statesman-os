/**
 * Slice 2 scenario content — integration.
 *
 * What this file tests is the reference-data half of the schema: `scenario`,
 * `scenario_version`, `source`, `scenario_claim` and `rubric_version` as built by
 * `supabase/migrations/20261021140700_scenario_content.sql`, and the single seeded case
 * DEMO-PH-001 as written by
 * `supabase/migrations/20261021140800_seed_demo_ph_001.sql`.
 *
 * TAG MAPPING. Each tag is quoted from the acceptance condition in docs/PRD.md §6.1 /
 * §6.2 rather than inferred from the requirement's title, because a tag that names a
 * requirement the test does not actually exercise is worse than no tag: `trace:check`
 * will report it as covered.
 *   FR-01  "User sees task, assumed role, timeline, available resources, missing
 *          information and topic before starting" (PRD §6.1)
 *          -> the case is READABLE by the app role (tests 1, 2) and its body CARRIES
 *             all six of those elements (test 13). The rendering is a later slice; what
 *             is testable at the data layer is that the content exists to render.
 *   FR-02  "Every factual scenario assertion is traceable to accessible source(s) or
 *          explicitly flagged as invented scenario data" (PRD §6.1)
 *          -> the provenance test (6), the unregistered-claim test (7), the NOT NULL
 *             teeth on `is_fiction` / `as_of_date` (9), the source-traceability check
 *             (10), and the write/erase denials that keep the record from being edited
 *             out of the data path (3, 5).
 *   FR-04  "Timestamped snapshot is saved; edits create a new revision, not a
 *          replacement" (PRD §6.1) — read here as the content side of that promise:
 *          a snapshot is worthless if the case under it can move
 *          -> the ST020 publish gate (4) and the version-pinning test (11).
 *   FR-07  "Five required lenses appear; each references decision text, constraints or
 *          an identified information gap" (PRD §6.2)
 *          -> test 12 covers the data-layer PRECONDITION only: that the seeded case
 *             grounds all five lenses of PRD §5.3 in registered claims. Generation is
 *             Slice 4 and is not touched here.
 *   FR-08  "no fabricated citations, statutes or institutional positions" (PRD §6.2)
 *          -> test 8: a citation naming a (source, version) pair that does not exist
 *             cannot be persisted at all, which is canon §7.3's "grounding is code".
 *   NFR-01 "authenticated session and authorization checks on every sensitive
 *          read/write" (PRD §8) -> tests 2, 3 and 5.
 *   NFR-10 "Source links stored with dates; broken/withdrawn sources flagged and cases
 *          reviewable or archived" (PRD §8)
 *          -> test 10 covers the FIRST clause only. There is no `source.status` column
 *             and no archival flag yet (canon §12.1 item 4), so the flagging and
 *             archival clause is NOT covered by this file and is not tagged as if it
 *             were.
 *   INV-07 a decision pins the scenario version it was taken against
 *          -> test 11, and the note at its end about what the schema cannot yet
 *             enforce.
 *
 * ------------------------------------------------------------------------------------
 * WHICH POSTURE OPTION 0008 CHOSE, and why this file is the control for it
 * ------------------------------------------------------------------------------------
 * Scenario content is REFERENCE data: readable by every authenticated user, written only
 * by migration. That is not the tenancy shape `app.verify_security_posture()` rule 1 and
 * rule 8 were written for, and the brief for this slice named two legal ways out. 0008
 * took BOTH, for different rules, and this file measures each one:
 *
 *   * For rule 1 (REACHABILITY) and rule 8 (POLICY SHAPE) it took the POLICY route. Each
 *     of the five tables is RLS-enabled AND FORCED and carries exactly one policy,
 *     `for select using (app.require_user_id() is not null)`. That mentions
 *     `require_user_id()` (so rule 8 passes), is not `USING (true)` (so rule 8 still
 *     bites), and because `require_user_id()` RAISES 28000 rather than returning NULL
 *     (V5), an unauthenticated read is refused rather than silently empty. Test 2 is the
 *     paired control for exactly that claim: 28000 with no context, rows with context.
 *     No posture rule was weakened to fit.
 *   * For rule 9 (SENTINELS) it took the EXEMPTION route, with a stated reason per row in
 *     `public.posture_exempt_table`. Rule 9 counts rows owned by the reserved sentinel
 *     uuid in a `user_id` column, and reference data has no owner column at all, so the
 *     rule is not merely inconvenient here — it is unevaluable. 0008's own CTRL-1
 *     re-asserts the catalog facts the exemption must not be allowed to hide (forced RLS
 *     plus a policy on all five), so the exemption waives rule 9 and nothing else.
 *
 * ------------------------------------------------------------------------------------
 * THE THREE RULES THIS FILE IS WRITTEN TO
 * ------------------------------------------------------------------------------------
 * 1. NO GATE WITHOUT A POSITIVE CONTROL (canon §8). Every refusal below is paired with a
 *    statement identical in shape that differs only in the variable under test:
 *      - "the app role cannot write" is paired with the OWNER writing the same row;
 *      - "a published version is frozen" is paired with an UNPUBLISHED version accepting
 *        the same UPDATE and the same DELETE — without it the test cannot distinguish
 *        "published is frozen" from "nothing can ever be written";
 *      - "an unregistered claim does not resolve" is paired with a registered one
 *        resolving, because 0 rows and "the table is empty" are the same observation
 *        (V18);
 *      - "version 1 is still pinned" is paired with version 2 being independently
 *        readable, because otherwise a v2 that was never reachable would read as pinning.
 *
 * 2. A ROW COUNT OF 0 IS NEVER A SUCCESS SIGNAL (V7), and neither is a bare error. Every
 *    refusal asserts the SQLSTATE, and several assert the message text as well — because
 *    the absent GRANT and a missing RLS policy BOTH report 42501, and the whole point of
 *    0008's grant model is that the grant is what is talking. Measured on this cluster:
 *    the app role's refused INSERT says `permission denied for table scenario_claim`,
 *    where an RLS denial would say `new row violates row-level security policy`. A test
 *    asserting only `42501` would pass if someone added `grant insert` and relied on the
 *    absent INSERT policy instead, which is a strictly weaker control.
 *
 * 3. EVERY COUNT IS SCOPED (V35). `isolate: false` gives each worker one clone shared by
 *    every file it runs, so an unscoped count measures scheduling order. Every count here
 *    is scoped by `scenario_version_id`, `scenario_id` or `decision_id`. Note that the
 *    reference tables are NOT empty before this file runs and are not expected to be:
 *    0008 seeds a sentinel case of its own (ids `…0800xx`) alongside 0009's demo case
 *    (ids `…0900xx`), which is why `where scenario_version_id = …` appears on every one.
 *
 * And one rule about how the SQL is written. Canon §6.1 rule 4 is "zero interpolated
 * VALUES": every value below arrives as a `$1` parameter (the `pg` path) or a `:'var'`
 * psql variable (the owner path), with no exceptions. The only interpolated text anywhere
 * in this file is a table IDENTIFIER taken from the frozen `REFERENCE_TABLES` tuple, which
 * cannot be parameterised in SQL at all — the same position in which 0008's own CTRL
 * blocks use `format('%I')` on a catalog-sourced name.
 */

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { StatesmanError, submitDecision } from '../support/scoped-pg'
import type { UserScopedClient } from '../support/scoped-pg'
import {
  EXPECTED_APP_ROLE,
  appQuery,
  ensureWorkerDatabase,
  ownerQuery,
  releaseProductionPools,
  runAsUser,
} from './support/db'
import { assertSentinelIntegrity } from './support/sentinels'
import { SEEDED_SCENARIO_VERSION_ID } from './support/scenario-fixtures'

/* ------------------------------------------------------------------ *
 * The seeded case. Ids are literals from migration 0009, not discovered at runtime:
 * a test that looks up "the published scenario" would keep passing if the seed stopped
 * producing one and 0008's sentinel case were found instead.
 * ------------------------------------------------------------------ */

const RUBRIC_V1 = '00000000-0000-0000-0000-000000090001'
const SCENARIO = '00000000-0000-0000-0000-000000090002'
const VERSION_1 = '00000000-0000-0000-0000-000000090003'
const SCENARIO_SLUG = 'demo-ph-001'
/** A source belonging to VERSION_1, used as the "real" half of the FK probes. */
const SOURCE_IN_V1 = '00000000-0000-0000-0000-000000090101'

/** Published by test 11, so a second version exists to pin against. */
const VERSION_2 = '00000000-0000-0000-0000-00000009a002'

/** Measured from the seed, asserted rather than discovered. */
const EXPECTED_CLAIMS = 47
const EXPECTED_SOURCES = 10

/** PRD §5.3's five challenge lenses, in the order 0009 writes them. */
const LENSES = [
  'legal_authority',
  'public_finance',
  'ethics_equity',
  'execution',
  'community_impact',
] as const

const REFERENCE_TABLES = [
  'scenario',
  'scenario_version',
  'source',
  'scenario_claim',
  'rubric_version',
] as const

/**
 * A claim id that is deliberately not in the whitelist, in the shape the registry's
 * `scenario_claim_id_shape` check accepts — so a refusal is attributable to the claim
 * being unregistered and not to the id being malformed.
 */
const UNREGISTERED_CLAIM = 'C-FABRICATED-NOT-IN-THE-WHITELIST'

/* ------------------------------------------------------------------ *
 * Shapes read back from the database
 * ------------------------------------------------------------------ */

type ScenarioRow = {
  id: string
  slug: string
  status: string
  sector: string
  jurisdiction: string
}

type VersionRow = {
  id: string
  scenario_id: string
  version_no: number
  is_fiction: boolean
  as_of_date: string
  published_at: string | null
  content_hash: string
  rubric_version_id: string | null
}

type ClaimRow = { claim_id: string; source_id: string; confidence: string }
type SourceRow = { id: string; kind: string; uri: string | null; retrieved_date: string | null }
type CountRow = { n: number }

/* ------------------------------------------------------------------ *
 * SQL. Every value is a parameter; nothing is interpolated.
 * ------------------------------------------------------------------ */

const READ_SCENARIO_SQL =
  'select id::text as id, slug, status, sector, jurisdiction from public.scenario where slug = $1'

const READ_VERSION_SQL =
  'select id::text as id, scenario_id::text as scenario_id, version_no, is_fiction, ' +
  'as_of_date::text as as_of_date, published_at::text as published_at, content_hash, ' +
  'rubric_version_id::text as rubric_version_id ' +
  'from public.scenario_version where id = $1::uuid'

const READ_RUBRIC_SQL =
  'select id::text as id, version_no, published_at::text as published_at ' +
  'from public.rubric_version where id = $1::uuid'

const READ_CONTENT_SQL = 'select content from public.scenario_version where id = $1::uuid'

const COUNT_CLAIMS_SQL =
  'select count(*)::int as n from public.scenario_claim where scenario_version_id = $1::uuid'

const COUNT_SOURCES_SQL =
  'select count(*)::int as n from public.source where scenario_version_id = $1::uuid'

const COUNT_VERSIONS_SQL =
  'select count(*)::int as n from public.scenario_version where scenario_id = $1::uuid'

const LIST_CLAIMS_SQL =
  'select claim_id, source_id::text as source_id, confidence from public.scenario_claim ' +
  'where scenario_version_id = $1::uuid order by claim_id'

const LIST_SOURCES_SQL =
  'select id::text as id, kind, uri, retrieved_date::text as retrieved_date ' +
  'from public.source where scenario_version_id = $1::uuid order by id'

/**
 * FR-02 leg one, in SQL rather than in TypeScript: a registered claim whose
 * `(source_id, scenario_version_id)` pair has no `source` row. The composite FK should
 * make this structurally impossible, which is exactly why it is measured — a constraint
 * believed to hold and never read back is a claim.
 */
const ORPHAN_CLAIMS_SQL =
  'select count(*)::int as n from public.scenario_claim c where c.scenario_version_id = $1::uuid ' +
  'and not exists (select 1 from public.source s ' +
  'where s.id = c.source_id and s.scenario_version_id = c.scenario_version_id)'

/** FR-02 leg two: a source in this version that no registered claim cites. */
const UNCITED_SOURCES_SQL =
  'select count(*)::int as n from public.source s where s.scenario_version_id = $1::uuid ' +
  'and not exists (select 1 from public.scenario_claim c ' +
  'where c.source_id = s.id and c.scenario_version_id = s.scenario_version_id)'

const RESOLVE_CLAIM_SQL =
  'select claim_id from public.scenario_claim where scenario_version_id = $1::uuid and claim_id = $2'

const READ_REVISION_SQL =
  'select id::text as id, revision_no, content from public.decision_revision ' +
  'where decision_id = $1::uuid order by revision_no'

const UPDATE_REVISION_SQL =
  'update public.decision_revision set rationale = $2::text where id = $1::uuid'

const INSERT_DECISION_SQL =
  'insert into public.decision (user_id, draft_payload, scenario_version_id) ' +
  `values ($1::uuid, $2::jsonb, '${SEEDED_SCENARIO_VERSION_ID}'::uuid) returning id`

/* The write attempts the app role must not be able to make. */
const APP_INSERT_CLAIM_SQL =
  'insert into public.scenario_claim ' +
  '(scenario_version_id, claim_id, source_id, claim_text, confidence) ' +
  "values ($1::uuid, $2, $3::uuid, 'injected by the app role', 'high')"

const APP_UPDATE_VERSION_SQL =
  'update public.scenario_version set is_fiction = false where id = $1::uuid'

const APP_DELETE_CLAIM_SQL =
  'delete from public.scenario_claim where scenario_version_id = $1::uuid'

/* Catalog reads. No identity context is needed for these, and none is set: they are the
 * one class of read that works either side of a FORCE boundary (0008 CTRL-6's rule). */

// PORTED (ADR-0015 §4.1). This query named `statesman_app` as a LITERAL, and that role
// still EXISTS in this local cluster as a leftover of the pre-port bootstrap — so after
// the port it did not error, it quietly returned `false` for every privilege, including
// SELECT. A test asserting `sel = 'true'` then failed for a reason that looked like a
// missing grant and was actually a measurement of the wrong role. The role the browser
// resolves to is `authenticated`, and it is read from EXPECTED_APP_ROLE rather than
// spelled again, so the connection the suite asserts about and the role this query asks
// about cannot drift apart.
const APP_PRIVILEGES_SQL =
  "select c.relname, " +
  "has_table_privilege(:'role', c.oid, 'SELECT')::text, " +
  "has_table_privilege(:'role', c.oid, 'INSERT')::text, " +
  "has_table_privilege(:'role', c.oid, 'UPDATE')::text, " +
  "has_table_privilege(:'role', c.oid, 'DELETE')::text, " +
  "has_table_privilege(:'role', c.oid, 'TRUNCATE')::text " +
  'from pg_class c join pg_namespace n on n.oid = c.relnamespace ' +
  "where n.nspname = 'public' and c.relkind = 'r' and c.relname in " +
  "('scenario','scenario_version','source','scenario_claim','rubric_version') " +
  'order by c.relname'

const NOT_NULL_SQL =
  'select a.attname, a.attnotnull::text from pg_attribute a ' +
  "where a.attrelid = 'public.scenario_version'::regclass " +
  "and a.attname in ('is_fiction','as_of_date') and a.attnum > 0 and not a.attisdropped " +
  'order by a.attname'

const CLAIM_CONSTRAINTS_SQL =
  'select conname, pg_get_constraintdef(oid) from pg_constraint ' +
  "where conrelid = 'public.scenario_claim'::regclass " +
  "and contype in ('p','u','f') order by conname"

const VERSION_UNIQUE_SQL =
  'select conname, pg_get_constraintdef(oid) from pg_constraint ' +
  "where conrelid = 'public.scenario_version'::regclass and contype in ('p','u') " +
  'order by conname'

/* ------------------------------------------------------------------ *
 * Owner-side scripts
 *
 * Reference tables carry SELECT-only grants, so every write probe below has to run as
 * the schema owner — and under FORCE the owner is subject to the same policy (V8/V9),
 * which for these tables means an owner write is refused by RLS before it reaches the
 * constraint or trigger under test. So each script brackets `no force` / `force` exactly
 * as 0008 and 0009 do, inside a transaction, and rolls back.
 *
 * The bracket is safe in both outcomes: the `alter table` is inside the transaction, so
 * whether psql aborts under ON_ERROR_STOP (session ends, transaction rolls back) or the
 * statement unexpectedly succeeds (the explicit `rollback` runs), FORCE is restored
 * either way. Test 5's after-state read re-checks `pg_class` rather than trusting that
 * argument, because a NO FORCE left open makes every denial downstream vacuous and
 * fails nothing on its own (0006, 0008 CTRL-6).
 * ------------------------------------------------------------------ */

const NO_FORCE = REFERENCE_TABLES.map(
  (t) => `alter table public.${t} no force row level security;`,
).join('\n')

const FORCE = REFERENCE_TABLES.map(
  (t) => `alter table public.${t} force row level security;`,
).join('\n')

/** Wrap owner-side statements in the FORCE bracket and roll them back. */
function bracketedRollback(body: string): string {
  return `begin;\n${NO_FORCE}\n${body}\n${FORCE}\nrollback;`
}

const RLS_STATE_SQL =
  'select c.relname, c.relrowsecurity::text, c.relforcerowsecurity::text, ' +
  '(select count(*) from pg_policy p where p.polrelid = c.oid)::text ' +
  'from pg_class c join pg_namespace n on n.oid = c.relnamespace ' +
  "where n.nspname = 'public' and c.relname in " +
  "('scenario','scenario_version','source','scenario_claim','rubric_version') " +
  'order by c.relname'

// PORTED (ADR-0015): public.app_user is retired. `public.profile.user_id` carries a REAL
// foreign key to `auth.users (id)`, so an identity fixture creates the auth row first —
// the chain is decision -> profile -> auth.users. :'hash' is still accepted as a psql
// variable by every call site and is simply not used: no credential column exists to
// write it to, which is strictly stronger than storing an unusable encoding.
const INSERT_APP_USER_SQL =
  'insert into auth.users (id, email, created_at, updated_at) ' +
  "values (:'id', :'email', now(), now()) on conflict (id) do nothing; " +
  'insert into public.profile (user_id, display_name) ' +
  "values (:'id', :'email') on conflict (user_id) do nothing;"

/** Not a valid argon2 encoding, so no credential can ever verify against it. */
const UNUSABLE_HASH = '!not-a-hash:scenario-content-fixture-cannot-authenticate'

/* ------------------------------------------------------------------ *
 * Error inspection
 * ------------------------------------------------------------------ */

/**
 * `db.ts` runs psql with VERBOSITY=verbose, so an error line reads
 * `ERROR:  ST020: scenario_version row … is published`. At default verbosity the code is
 * absent entirely, which would make a SQLSTATE assertion unsatisfiable rather than false.
 */
const PG_ERROR_WITH_CODE = /\bERROR:\s+([0-9A-Z]{5}):/

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Run an owner-side script that must be REJECTED, and return its SQLSTATE. */
async function ownerSqlstate(
  sql: string,
  vars?: Readonly<Record<string, string>>,
): Promise<string> {
  try {
    await ownerQuery(sql, vars)
  } catch (error: unknown) {
    const code = PG_ERROR_WITH_CODE.exec(messageOf(error))?.[1]
    if (code === undefined) throw error
    return code
  }
  throw new Error(
    'expected the owner-side statement to be rejected, but psql exited 0. ' +
      'A guard that cannot be made to fail has not been shown to work (canon §8).',
  )
}

/** Run an owner-side script that must be rejected, and return code plus message. */
async function ownerFailure(
  sql: string,
  vars?: Readonly<Record<string, string>>,
): Promise<{ code: string; message: string }> {
  try {
    await ownerQuery(sql, vars)
  } catch (error: unknown) {
    const message = messageOf(error)
    const code = PG_ERROR_WITH_CODE.exec(message)?.[1]
    if (code === undefined) throw error
    return { code, message }
  }
  throw new Error('expected the owner-side statement to be rejected, but psql exited 0')
}

/**
 * Run a block through the real `withUser` and require that it be REJECTED.
 *
 * Each expected rejection gets its own `runAsUser`: Postgres marks the whole transaction
 * aborted after an error, so a second statement in the same block would fail with 25P02
 * and the test would be asserting the wrong thing.
 */
async function appRejection(
  userId: string,
  fn: (db: UserScopedClient) => Promise<unknown>,
): Promise<StatesmanError> {
  let resolved: unknown
  try {
    resolved = await runAsUser(userId, fn)
  } catch (error: unknown) {
    if (error instanceof StatesmanError) return error
    throw error
  }
  throw new Error(
    `expected the statement to be rejected, but it resolved with ${JSON.stringify(resolved) ?? 'undefined'}`,
  )
}

/* ------------------------------------------------------------------ *
 * Reading the case body
 * ------------------------------------------------------------------ */

type JsonObject = Record<string, unknown>

function asObject(value: unknown, what: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what}: expected a JSON object, got ${typeof value}`)
  }
  return value as JsonObject
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected a JSON array`)
  return value
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what}: expected a string`)
  return value
}

/**
 * Every claim id the case body CITES, with the path it was cited from.
 *
 * The walker keys on the property NAME (`claims`, `grounding_claims`) rather than on a
 * fixed list of paths, so a new block that cites claims the same way is covered the day
 * it is added rather than the day someone remembers to extend this list. Measured on the
 * seeded case: 134 citation occurrences at 25 distinct paths, 47 distinct ids.
 */
const CITING_KEYS = new Set(['claims', 'grounding_claims'])

function collectCitations(node: unknown, path: string, out: Map<string, string[]>): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => {
      collectCitations(child, `${path}[${String(i)}]`, out)
    })
    return
  }
  if (typeof node !== 'object' || node === null) return
  for (const [key, value] of Object.entries(node as JsonObject)) {
    const childPath = path === '' ? key : `${path}.${key}`
    if (CITING_KEYS.has(key) && Array.isArray(value)) {
      value.forEach((entry, i) => {
        if (typeof entry === 'string') {
          const at = `${childPath}[${String(i)}]`
          const paths = out.get(entry) ?? []
          paths.push(at)
          out.set(entry, paths)
        }
      })
      continue
    }
    collectCitations(value, childPath, out)
  }
}

type RegisterEntry = { claimId: string; sourceId: string; lenses: string[] }

function readRegister(content: JsonObject): RegisterEntry[] {
  return asArray(content['claim_register'], 'claim_register').map((raw, i) => {
    const entry = asObject(raw, `claim_register[${String(i)}]`)
    return {
      claimId: asString(entry['claim_id'], `claim_register[${String(i)}].claim_id`),
      sourceId: asString(entry['source_id'], `claim_register[${String(i)}].source_id`),
      lenses: asArray(entry['lenses'] ?? [], `claim_register[${String(i)}].lenses`).map((l, j) =>
        asString(l, `claim_register[${String(i)}].lenses[${String(j)}]`),
      ),
    }
  })
}

async function readCaseBody(userId: string): Promise<JsonObject> {
  const row = await runAsUser(userId, async (db) =>
    db.queryOne<{ content: unknown }>(READ_CONTENT_SQL, [VERSION_1]),
  )
  return asObject(row.content, 'scenario_version.content')
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/**
 * `app_user` carries no grants to `statesman_app` (§4.6), so a fixture user cannot be
 * created through `withUser` at all. Decisions, by contrast, ARE created through
 * `withUser`, so a missing INSERT policy surfaces rather than being bypassed.
 */
async function seedUser(): Promise<string> {
  const id = randomUUID()
  await ownerQuery(INSERT_APP_USER_SQL, {
    id,
    email: `scenario+${id}@statesman.invalid`, // .invalid is reserved (RFC 2606)
    hash: UNUSABLE_HASH,
  })
  return id
}

describe('scenario content — Slice 2 reference data', () => {
  let user = ''
  let otherUser = ''

  beforeAll(async () => {
    await ensureWorkerDatabase()
    // Harness-fatal. It proves RLS is enabled AND forced on the user-owned tables in
    // THIS clone and that a sentinel row is visible to its owner and invisible under a
    // foreign identity. Without it every denial below could be satisfied by an empty
    // table or a broken fixture (V18).
    await assertSentinelIntegrity()
    user = await seedUser()
    otherUser = await seedUser()
  })

  afterAll(async () => {
    await releaseProductionPools()
  })

  // 1 ----------------------------------------------------------------
  it('[FR-01] the app role reads the published demo case and all five reference tables', async () => {
    const scenario = await runAsUser(user, async (db) =>
      db.queryOne<ScenarioRow>(READ_SCENARIO_SQL, [SCENARIO_SLUG]),
    )
    expect(scenario.id).toBe(SCENARIO)
    expect(scenario.status).toBe('published')
    // PRD §8.2's editorial record, and canon §1.2's editorial boundary: the jurisdiction
    // is openly invented, so the case cannot read as a claim about a real place.
    expect(scenario.jurisdiction).toMatch(/invented/i)

    const version = await runAsUser(user, async (db) =>
      db.queryOne<VersionRow>(READ_VERSION_SQL, [VERSION_1]),
    )
    expect(version.scenario_id).toBe(SCENARIO)
    expect(version.version_no).toBe(1)
    expect(version.published_at).not.toBeNull()
    expect(version.is_fiction).toBe(true)
    expect(version.as_of_date).toBe('2026-03-06')
    // PRD §8.1: every approved case stores the rubric it is to be assessed against.
    expect(version.rubric_version_id).toBe(RUBRIC_V1)
    expect(version.content_hash).toMatch(/^[0-9a-f]{64}$/)

    const rubric = await runAsUser(user, async (db) =>
      db.queryOne<{ id: string; version_no: number; published_at: string | null }>(
        READ_RUBRIC_SQL,
        [RUBRIC_V1],
      ),
    )
    expect(rubric.version_no).toBe(1)
    expect(rubric.published_at).not.toBeNull()

    const sources = await runAsUser(user, async (db) =>
      db.queryOne<CountRow>(COUNT_SOURCES_SQL, [VERSION_1]),
    )
    const claims = await runAsUser(user, async (db) =>
      db.queryOne<CountRow>(COUNT_CLAIMS_SQL, [VERSION_1]),
    )
    expect(sources.n).toBe(EXPECTED_SOURCES)
    expect(claims.n).toBe(EXPECTED_CLAIMS)

    // A second identity reads the same reference rows. Reference data is shared, not
    // tenanted, and this is the leg that says so: if the policy had been copied from
    // `decision`'s tenancy shape, this user would see nothing.
    const asOther = await runAsUser(otherUser, async (db) =>
      db.queryOne<CountRow>(COUNT_CLAIMS_SQL, [VERSION_1]),
    )
    expect(asOther.n).toBe(EXPECTED_CLAIMS)
  })

  // 2 ----------------------------------------------------------------
  it('[FR-01][NFR-01] every reference table returns 0 rows and RAISES NOTHING for a claimless read, and rows with a claim', async () => {
    // THE GATE, REWRITTEN RATHER THAN RE-POINTED. This asserted a RAISED 28000, on the
    // ground that `app.require_user_id()` raises rather than returning NULL (V5), so an
    // unauthenticated read of reference data was refused LOUDLY and not silently empty.
    //
    // `auth.uid()` returns NULL. MEASURED here as `authenticated` with no claim: 0 rows
    // and NO error. So the refusal still happens — the policy `auth.uid() is not null` is
    // false — but it no longer announces itself. The assertion is therefore inverted, and
    // a RAISE is now the anomaly: it would mean something is reproducing the retired
    // semantics, or that a 42501/42P01 is wearing the denial's clothes.
    //
    // This is also why 20261021140700 had to REGISTER these five tables in
    // public.posture_sentinel_row (rule 9b). Under the pre-port rule 9 they were waived,
    // and the zero below would then have been indistinguishable from an empty table — the
    // sentinel row is the only thing that makes it mean denial (V18).
    for (const table of REFERENCE_TABLES) {
      const probe = `select 'n', count(*)::text from public.${table};`
      let code: string | undefined
      let rows: string[][] | undefined
      try {
        rows = await appQuery(probe)
      } catch (error: unknown) {
        code = PG_ERROR_WITH_CODE.exec(messageOf(error))?.[1]
      }
      expect(code, `claimless read of public.${table} must raise nothing`).toBeUndefined()
      expect(
        rows?.find((r) => r[0] === 'n')?.[1],
        `claimless read of public.${table}`,
      ).toBe('0')
    }

    // POSITIVE CONTROL, and post-port it carries the whole weight of the assertion. Same
    // role, same tables; the only difference is that a claim is set. Without this leg the
    // zero above is satisfied by a broken connection, a missing table, a typo'd role, a
    // failed seed — or a policy that denies everyone, which is V18 exactly.
    const counts = await runAsUser(user, async (db) => {
      const out: Record<string, number> = {}
      for (const table of REFERENCE_TABLES) {
        // Catalog-driven table name, not user input; values elsewhere are parameters.
        const row = await db.queryOne<CountRow>(
          `select count(*)::int as n from public.${table}`,
        )
        out[table] = row.n
      }
      return out
    })
    for (const table of REFERENCE_TABLES) {
      expect(counts[table], `contexted read of public.${table}`).toBeGreaterThan(0)
    }
  })

  // 3 ----------------------------------------------------------------
  it('[FR-02][NFR-01] `authenticated` holds SELECT only: INSERT, UPDATE and DELETE each raise 42501 from the absent grant', async () => {
    // Leg 1 — the catalog. This is what notices a `grant insert` added later, which the
    // SQLSTATE assertions below could NOT distinguish from the absent INSERT policy.
    const privileges = await appQuery(APP_PRIVILEGES_SQL, { role: EXPECTED_APP_ROLE })
    expect(privileges).toHaveLength(REFERENCE_TABLES.length)
    for (const row of privileges) {
      const [name, sel, ins, upd, del, trunc] = row
      expect([name, sel]).toEqual([name, 'true'])
      expect([name, ins, upd, del, trunc]).toEqual([name, 'false', 'false', 'false', 'false'])
    }

    // Leg 2 — the data path. Each of the three writes, through the real withUser.
    const insert = await appRejection(user, async (db) =>
      db.query(APP_INSERT_CLAIM_SQL, [VERSION_1, UNREGISTERED_CLAIM, SOURCE_IN_V1]),
    )
    expect(insert.sqlState).toBe('42501')
    expect(insert.kind).toBe('permission_denied')
    // The MESSAGE, not only the code: an RLS denial would read `new row violates
    // row-level security policy`. 0008's control is the absent grant, so that is what
    // this asserts (see rule 2 in the header).
    expect(messageOf(insert)).toMatch(/permission denied for table scenario_claim/)

    const update = await appRejection(user, async (db) =>
      db.query(APP_UPDATE_VERSION_SQL, [VERSION_1]),
    )
    expect(update.sqlState).toBe('42501')
    expect(messageOf(update)).toMatch(/permission denied for table scenario_version/)

    const del = await appRejection(user, async (db) => db.query(APP_DELETE_CLAIM_SQL, [VERSION_1]))
    expect(del.sqlState).toBe('42501')
    expect(messageOf(del)).toMatch(/permission denied for table scenario_claim/)

    // POSITIVE CONTROL. The OWNER inserts a structurally identical claim row, inside the
    // FORCE bracket and rolled back. It succeeding is what makes the three 42501s above
    // attributable to privileges rather than to an unreachable row, a broken constraint
    // or a table that does not exist.
    const inserted = await ownerQuery(
      bracketedRollback(
        'insert into public.scenario_claim ' +
          '(scenario_version_id, claim_id, source_id, claim_text, confidence) ' +
          "values (:'v', :'c', :'s', 'owner positive control', 'high');\n" +
          "select 'inserted', count(*) from public.scenario_claim " +
          "where scenario_version_id = :'v' and claim_id = :'c';",
      ),
      { v: VERSION_1, c: UNREGISTERED_CLAIM, s: SOURCE_IN_V1 },
    )
    expect(inserted).toEqual([['inserted', '1']])

    // AFTER-STATE. The refused writes left nothing behind, and the rolled-back control
    // did not commit. `DELETE 0` is byte-identical to deleting a nonexistent id (V19),
    // so the after-state read is the leg that distinguishes them.
    const after = await runAsUser(user, async (db) => {
      const claims = await db.queryOne<CountRow>(COUNT_CLAIMS_SQL, [VERSION_1])
      const version = await db.queryOne<VersionRow>(READ_VERSION_SQL, [VERSION_1])
      return { claims: claims.n, isFiction: version.is_fiction }
    })
    expect(after.claims).toBe(EXPECTED_CLAIMS)
    expect(after.isFiction).toBe(true)
  })

  // 4 ----------------------------------------------------------------
  it('[FR-04] a published scenario_version refuses UPDATE and DELETE with ST020 while an unpublished one accepts both', async () => {
    const before = await runAsUser(user, async (db) =>
      db.queryOne<VersionRow>(READ_VERSION_SQL, [VERSION_1]),
    )

    // GATE 1 — UPDATE of a published row.
    const updateCode = await ownerSqlstate(
      bracketedRollback(
        "update public.scenario_version set content = '{\"tampered\":true}'::jsonb " +
          "where id = :'v';",
      ),
      { v: VERSION_1 },
    )
    expect(updateCode).toBe('ST020')

    // GATE 2 — DELETE of a published row. The trigger is `before update or delete`, and
    // a test that exercised only UPDATE would pass if `delete` were dropped from it.
    const deleteCode = await ownerSqlstate(
      bracketedRollback("delete from public.scenario_version where id = :'v';"),
      { v: VERSION_1 },
    )
    expect(deleteCode).toBe('ST020')

    // POSITIVE CONTROL, and the reason this test can say "published is frozen" rather
    // than "nothing can ever be written": an UNPUBLISHED version takes the same UPDATE
    // and the same DELETE, in the same bracket, as the same role. Row counts are
    // asserted because a policy that affects zero rows raises nothing (V7).
    const control = await ownerQuery(
      bracketedRollback(
        'insert into public.scenario_version ' +
          '(id, scenario_id, version_no, content, is_fiction, as_of_date) values ' +
          "(:'d', :'s', 9901, '{\"draft\":true}'::jsonb, true, '2026-03-06');\n" +
          "update public.scenario_version set content = '{\"draft\":\"edited\"}'::jsonb " +
          "where id = :'d';\n" +
          "select 'updated', count(*) from public.scenario_version " +
          "where id = :'d' and content->>'draft' = 'edited';\n" +
          "delete from public.scenario_version where id = :'d';\n" +
          "select 'remaining', count(*) from public.scenario_version where id = :'d';",
      ),
      { d: '00000000-0000-0000-0000-00000009990a', s: SCENARIO },
    )
    expect(control).toEqual([
      ['updated', '1'],
      ['remaining', '0'],
    ])

    // AFTER-STATE. `content_hash` is a generated column over `jsonb_send(content)`, so
    // an unchanged hash is a statement about the bytes and not about the row existing.
    const after = await runAsUser(user, async (db) =>
      db.queryOne<VersionRow>(READ_VERSION_SQL, [VERSION_1]),
    )
    expect(after.content_hash).toBe(before.content_hash)
    expect(after.published_at).toBe(before.published_at)
  })

  // 5 ----------------------------------------------------------------
  it('[FR-02][NFR-01] TRUNCATE is refused on every reference table: ST021 under CASCADE, and 0A000 first where an inbound FK bars it', async () => {
    // Measured, not assumed. A bare TRUNCATE of four of the five tables never reaches
    // the trigger at all: an inbound foreign key raises 0A000 first. Only
    // `scenario_claim` has no inbound FK, which is why 0008's own CTRL-5 uses it as the
    // leg where the trigger is the ONLY control. Asserting ST021 for all five bare
    // truncates would have been asserting a property this schema does not have.
    const BARE: Readonly<Record<(typeof REFERENCE_TABLES)[number], string>> = {
      scenario: '0A000',
      scenario_version: '0A000',
      source: '0A000',
      scenario_claim: 'ST021',
      rubric_version: '0A000',
    }
    for (const table of REFERENCE_TABLES) {
      const code = await ownerSqlstate(`begin;\ntruncate table public.${table};\nrollback;`)
      expect(code, `bare truncate of public.${table}`).toBe(BARE[table])
    }

    // CASCADE is the documented way past the 0A000 barrier, so this is the leg that
    // actually exercises the BEFORE TRUNCATE triggers (V15: a row-level BEFORE
    // UPDATE/DELETE trigger cannot see a TRUNCATE at all). Note the limit of the
    // assertion: under CASCADE the refusal is attributable to the guard being present
    // somewhere on the cascade path, not to one named table's trigger.
    for (const table of REFERENCE_TABLES) {
      const code = await ownerSqlstate(
        `begin;\ntruncate table public.${table} cascade;\nrollback;`,
      )
      expect(code, `truncate ... cascade of public.${table}`).toBe('ST021')
    }

    // The app role never reaches either control: it holds no TRUNCATE grant (test 3's
    // catalog leg), so it is stopped by privilege checking first. Two controls, because
    // V15 is precisely the case where one of them looks sufficient and is not.
    const refused = await appRejection(user, async (db) => db.query('truncate public.scenario_claim'))
    expect(refused.sqlState).toBe('42501')

    // Every bracket this test opened is closed. A NO FORCE left open fails nothing on
    // its own and makes every denial above vacuous, so it is read back from the catalog
    // rather than argued from the structure of the scripts.
    const rls = await appQuery(RLS_STATE_SQL)
    expect(rls).toHaveLength(REFERENCE_TABLES.length)
    for (const row of rls) {
      const [name, enabled, forced, policies] = row
      expect([name, enabled, forced, policies]).toEqual([name, 'true', 'true', '1'])
    }
  })

  // 6 ----------------------------------------------------------------
  it('[FR-02] provenance has no orphans in either direction: every case claim resolves to a registered row and every row to a source in the same version', async () => {
    const content = await readCaseBody(user)
    const register = readRegister(content)
    const citations = new Map<string, string[]>()
    collectCitations(content, '', citations)

    const dbClaims = await runAsUser(user, async (db) => {
      const result = await db.query<ClaimRow>(LIST_CLAIMS_SQL, [VERSION_1])
      return [...result.rows]
    })
    const dbSources = await runAsUser(user, async (db) => {
      const result = await db.query<SourceRow>(LIST_SOURCES_SQL, [VERSION_1])
      return [...result.rows]
    })

    // The population is non-empty, FIRST. Every orphan assertion below is satisfied
    // vacuously by an empty case, which is the exact failure canon §8 names.
    expect(register).toHaveLength(EXPECTED_CLAIMS)
    expect(dbClaims).toHaveLength(EXPECTED_CLAIMS)
    expect(dbSources).toHaveLength(EXPECTED_SOURCES)
    expect(citations.size).toBeGreaterThan(0)

    const registered = new Set(register.map((e) => e.claimId))
    const inDatabase = new Set(dbClaims.map((c) => c.claim_id))
    expect(registered.size).toBe(EXPECTED_CLAIMS) // no duplicate ids in the register

    // DIRECTION 1 — every factual claim the case body cites resolves to a registered
    // row. This is FR-02's whole content: a cited claim that is not in the whitelist is
    // an unsourced assertion rendered as a sourced one.
    const unresolved = [...citations.entries()]
      .filter(([id]) => !inDatabase.has(id))
      .map(([id, paths]) => `${id} cited at ${paths.join(', ')}`)
    expect(unresolved).toEqual([])

    // DIRECTION 2 — every registered row is in the case body's own register, and every
    // register entry reached the database. Compared as sorted arrays so a one-sided
    // difference is reported with its ids rather than as a count.
    expect([...inDatabase].sort()).toEqual([...registered].sort())

    // DIRECTION 3 — no register entry is dead weight: each is cited at least once. A
    // claim nothing cites is a whitelist row the grounding gate would accept for text
    // that does not exist in the case.
    const uncited = [...registered].filter((id) => !citations.has(id)).sort()
    expect(uncited).toEqual([])

    // DIRECTION 4 — every claim resolves to a source IN THE SAME VERSION, measured in
    // SQL against the composite FK that is supposed to make it impossible, and again in
    // TypeScript against the rows actually read back.
    const orphanClaims = await runAsUser(user, async (db) =>
      db.queryOne<CountRow>(ORPHAN_CLAIMS_SQL, [VERSION_1]),
    )
    expect(orphanClaims.n).toBe(0)

    const sourceIds = new Set(dbSources.map((s) => s.id))
    const danglingSources = dbClaims
      .filter((c) => !sourceIds.has(c.source_id))
      .map((c) => `${c.claim_id} -> ${c.source_id}`)
    expect(danglingSources).toEqual([])

    // DIRECTION 5 — and no source in this version is unreferenced, so the source
    // register and the claim register describe the same case rather than two.
    const uncitedSources = await runAsUser(user, async (db) =>
      db.queryOne<CountRow>(UNCITED_SOURCES_SQL, [VERSION_1]),
    )
    expect(uncitedSources.n).toBe(0)
    expect(new Set(dbClaims.map((c) => c.source_id)).size).toBe(EXPECTED_SOURCES)

    // The register's own source_id agrees with the stored row, id by id. Without this,
    // the body could attribute a claim to one source while the whitelist attributes it
    // to another, and every assertion above would still pass.
    const storedSourceOf = new Map(dbClaims.map((c) => [c.claim_id, c.source_id]))
    const mismatched = register
      .filter((e) => storedSourceOf.get(e.claimId) !== e.sourceId)
      .map((e) => `${e.claimId}: body ${e.sourceId} vs stored ${String(storedSourceOf.get(e.claimId))}`)
    expect(mismatched).toEqual([])

    // Every stored claim carries an editorial confidence band from the closed domain.
    // FR-02 is traceability, and an untyped confidence is not a traceable one.
    for (const claim of dbClaims) {
      expect(['high', 'medium', 'low', 'insufficient']).toContain(claim.confidence)
    }
  })

  // 7 ----------------------------------------------------------------
  it('[FR-02] an unregistered claim_id does not resolve while a registered one does', async () => {
    // This is the property the Slice 4 grounding gate depends on: a model citation
    // naming an id absent from the whitelist must not find a row.
    const absent = await runAsUser(user, async (db) => {
      const result = await db.query<{ claim_id: string }>(RESOLVE_CLAIM_SQL, [
        VERSION_1,
        UNREGISTERED_CLAIM,
      ])
      return result.rows.length
    })
    expect(absent).toBe(0)

    // POSITIVE CONTROL. 0 rows and "the table is empty" are the same observation (V18),
    // so a registered id must resolve through the identical statement.
    const content = await readCaseBody(user)
    const first = readRegister(content)[0]
    expect(first).toBeDefined()
    const present = await runAsUser(user, async (db) => {
      const result = await db.query<{ claim_id: string }>(RESOLVE_CLAIM_SQL, [
        VERSION_1,
        first?.claimId ?? '',
      ])
      return result.rows.length
    })
    expect(present).toBe(1)

    // THE OTHER AXIS, and the one a single-version test would miss: a REGISTERED claim
    // id does not resolve against a DIFFERENT scenario_version. The whitelist is keyed
    // `(scenario_version_id, claim_id)`, so an id approved for one version must not
    // ground a citation pinned to another. 0008 seeds a sentinel case whose version id
    // is `…080003`; the demo claim ids must not resolve there.
    const crossVersion = await runAsUser(user, async (db) => {
      const result = await db.query<{ claim_id: string }>(RESOLVE_CLAIM_SQL, [
        '00000000-0000-0000-0000-000000080003',
        first?.claimId ?? '',
      ])
      return result.rows.length
    })
    expect(crossVersion).toBe(0)
  })

  // 8 ----------------------------------------------------------------
  it('[FR-02][FR-08] a fabricated citation is unpersistable: the composite FK rejects a (source_id, scenario_version_id) pair that does not exist', async () => {
    // GATE. A real source id, a real-looking claim id, and a version the source does not
    // belong to. The SQLSTATE and the CONSTRAINT NAME are both asserted: "an error" would
    // also be satisfied by the claim-id shape check, by the confidence domain, or by the
    // RLS denial that the bracket exists to get past.
    const failure = await ownerFailure(
      bracketedRollback(
        'insert into public.scenario_version ' +
          '(id, scenario_id, version_no, content, is_fiction, as_of_date) values ' +
          "(:'other', :'s', 9902, '{}'::jsonb, true, '2026-03-06');\n" +
          'insert into public.scenario_claim ' +
          '(scenario_version_id, claim_id, source_id, claim_text, confidence) values ' +
          "(:'other', 'C-FABRICATED-CITATION', :'src', 'a claim with a borrowed source', 'high');",
      ),
      { other: '00000000-0000-0000-0000-00000009990b', s: SCENARIO, src: SOURCE_IN_V1 },
    )
    expect(failure.code).toBe('23503')
    expect(failure.message).toMatch(/scenario_claim_source_fk/)

    // POSITIVE CONTROL. The same two inserts, differing only in that the source belongs
    // to the version the claim names. Without it, the 23503 above is satisfied by a
    // table that rejects every insert.
    const control = await ownerQuery(
      bracketedRollback(
        'insert into public.scenario_version ' +
          '(id, scenario_id, version_no, content, is_fiction, as_of_date) values ' +
          "(:'other', :'s', 9903, '{}'::jsonb, true, '2026-03-06');\n" +
          'insert into public.source ' +
          '(id, scenario_version_id, title, publisher, kind, retrieved_date) values ' +
          "(:'newsrc', :'other', 'probe source', 'probe publisher', " +
          "'fictional_assumption', '2026-03-05');\n" +
          'insert into public.scenario_claim ' +
          '(scenario_version_id, claim_id, source_id, claim_text, confidence) values ' +
          "(:'other', 'C-FABRICATED-CITATION', :'newsrc', 'a claim with its own source', 'high');\n" +
          "select 'persisted', count(*) from public.scenario_claim " +
          "where scenario_version_id = :'other';",
      ),
      {
        other: '00000000-0000-0000-0000-00000009990c',
        s: SCENARIO,
        newsrc: '00000000-0000-0000-0000-00000009990d',
      },
    )
    expect(control).toEqual([['persisted', '1']])

    // THE CONSTRAINT SHAPE the Slice 4 citation tables will reference. No citation table
    // exists yet (canon §7.3 item 2 lands in Slice 4), so what is asserted here is the
    // anchor it will point at: the whitelist primary key, and the unique constraint over
    // the full (version, source, claim) triple. A citation row carrying a composite FK
    // to this triple cannot name a claim and a source that do not belong together.
    const constraints = await appQuery(CLAIM_CONSTRAINTS_SQL)
    const byName = new Map(constraints.map((row) => [row[0] ?? '', row[1] ?? '']))
    expect(byName.get('scenario_claim_pk')).toBe('PRIMARY KEY (scenario_version_id, claim_id)')
    expect(byName.get('scenario_claim_citation_anchor')).toBe(
      'UNIQUE (scenario_version_id, source_id, claim_id)',
    )
    expect(byName.get('scenario_claim_source_fk')).toBe(
      'FOREIGN KEY (source_id, scenario_version_id) REFERENCES source(id, scenario_version_id) ON DELETE RESTRICT',
    )
  })

  // 9 ----------------------------------------------------------------
  it('[FR-02] is_fiction and as_of_date are NOT NULL, and both agree with the case body fiction notice', async () => {
    // Leg 1 — the catalog. This is what notices the constraint being dropped even if an
    // insert probe were ever reshaped to stop reaching it.
    const notNull = await appQuery(NOT_NULL_SQL)
    expect(notNull).toEqual([
      ['as_of_date', 'true'],
      ['is_fiction', 'true'],
    ])

    // Leg 2 — the behaviour, one column at a time. FR-02's teeth: a case with no fiction
    // flag reads as neither invented nor sourced at the point of rendering, and an
    // undated case cannot be described honestly at all (PRD §8.2).
    const noFiction = await ownerSqlstate(
      bracketedRollback(
        'insert into public.scenario_version ' +
          '(scenario_id, version_no, content, as_of_date) values ' +
          "(:'s', 9904, '{}'::jsonb, '2026-03-06');",
      ),
      { s: SCENARIO },
    )
    expect(noFiction).toBe('23502')

    const noDate = await ownerSqlstate(
      bracketedRollback(
        'insert into public.scenario_version ' +
          '(scenario_id, version_no, content, is_fiction) values ' +
          "(:'s', 9905, '{}'::jsonb, true);",
      ),
      { s: SCENARIO },
    )
    expect(noDate).toBe('23502')

    // POSITIVE CONTROL. The same insert with both columns present succeeds, so the two
    // 23502s are attributable to the missing column and not to the bracket, the role or
    // some other constraint on the row.
    const control = await ownerQuery(
      bracketedRollback(
        'insert into public.scenario_version ' +
          '(scenario_id, version_no, content, is_fiction, as_of_date) values ' +
          "(:'s', 9906, '{}'::jsonb, true, '2026-03-06');\n" +
          "select 'inserted', count(*) from public.scenario_version " +
          "where scenario_id = :'s' and version_no = 9906;",
      ),
      { s: SCENARIO },
    )
    expect(control).toEqual([['inserted', '1']])

    // Leg 3 — the column and the body agree. A NOT NULL column satisfied by a value that
    // contradicts the case's own fiction notice would be a label, not a control.
    const content = await readCaseBody(user)
    const notice = asObject(content['fiction_notice'], 'fiction_notice')
    const version = await runAsUser(user, async (db) =>
      db.queryOne<VersionRow>(READ_VERSION_SQL, [VERSION_1]),
    )
    expect(notice['is_fiction']).toBe(true)
    expect(version.is_fiction).toBe(true)
    expect(notice['as_of_date']).toBe(version.as_of_date)
    expect(notice['every_source_is_fictional']).toBe(true)
  })

  // 10 ---------------------------------------------------------------
  it('[FR-02][NFR-10] a non-fictional source without a uri or a retrieved date is rejected, and every seeded source is a dated fictional assumption', async () => {
    // WHY THIS PROBE EXISTS. All ten seeded sources are `fictional_assumption`, and
    // `source_factual_is_traceable` only constrains the other kinds — so on the seeded
    // data the constraint is satisfied VACUOUSLY and a test that read only the seed
    // would report a control that has never been exercised. These two probes are the
    // only place it is made to bite.
    const noUri = await ownerFailure(
      bracketedRollback(
        'insert into public.source ' +
          '(scenario_version_id, title, publisher, kind, retrieved_date) values ' +
          "(:'v', 'probe', 'probe publisher', 'news_report', '2026-03-05');",
      ),
      { v: VERSION_1 },
    )
    expect(noUri.code).toBe('23514')
    expect(noUri.message).toMatch(/source_factual_is_traceable/)

    const noRetrieved = await ownerFailure(
      bracketedRollback(
        'insert into public.source ' +
          '(scenario_version_id, title, publisher, kind, uri) values ' +
          "(:'v', 'probe', 'probe publisher', 'news_report', 'https://example.invalid/probe');",
      ),
      { v: VERSION_1 },
    )
    expect(noRetrieved.code).toBe('23514')
    expect(noRetrieved.message).toMatch(/source_factual_is_traceable/)

    // POSITIVE CONTROL — the same non-fictional source WITH both, which is PRD §8.1's
    // "source list and access dates".
    const control = await ownerQuery(
      bracketedRollback(
        'insert into public.source ' +
          '(id, scenario_version_id, title, publisher, kind, uri, retrieved_date) values ' +
          "(:'id', :'v', 'probe', 'probe publisher', 'news_report', " +
          "'https://example.invalid/probe', '2026-03-05');\n" +
          "select 'inserted', count(*) from public.source where id = :'id';",
      ),
      { id: '00000000-0000-0000-0000-00000009990e', v: VERSION_1 },
    )
    expect(control).toEqual([['inserted', '1']])

    // The seeded case, measured. Every source is an openly declared invented assumption
    // carrying the in-world date it was read — which is what makes canon §1.2's
    // editorial boundary checkable rather than asserted in prose.
    const sources = await runAsUser(user, async (db) => {
      const result = await db.query<SourceRow>(LIST_SOURCES_SQL, [VERSION_1])
      return [...result.rows]
    })
    expect(sources).toHaveLength(EXPECTED_SOURCES)
    for (const source of sources) {
      expect(source.kind).toBe('fictional_assumption')
      expect(source.retrieved_date).not.toBeNull()
    }
  })

  // 11 ---------------------------------------------------------------
  it('[FR-04][INV-07] publishing a second scenario_version leaves version 1 and the submitted revision untouched, while version 2 is independently readable', async () => {
    const before = await runAsUser(user, async (db) =>
      db.queryOne<VersionRow>(READ_VERSION_SQL, [VERSION_1]),
    )
    expect(before.published_at).not.toBeNull()

    // A decision submitted against version 1. The pin is carried in the revision's
    // `content`, because `decision_revision` has no `scenario_version_id` column yet —
    // see the note at the end of this test for what that means and what it does not.
    const decisionId = await runAsUser(user, async (db) => {
      const row = await db.queryOne<{ id: string }>(INSERT_DECISION_SQL, [
        db.userId,
        JSON.stringify({ title: 'pinning fixture', scenario_version_id: VERSION_1 }),
      ])
      return row.id
    })
    const submitted = await runAsUser(user, async (db) =>
      submitDecision(db, {
        decisionId,
        idempotencyToken: randomUUID(),
        content: { scenario_version_id: VERSION_1, position: 'fictional fixture position' },
        confidence: 60,
        forecast: 'fictional fixture forecast — not a prediction',
        horizon: '30 days',
        rationale: 'taken against version 1 of the demo case',
      }),
    )
    expect(submitted.revisionNo).toBe(1)

    // Publish version 2 of the SAME scenario, committed rather than rolled back: the
    // whole question is what happens to an already-submitted decision when the content
    // under it moves. Published, so the ST020 gate makes it immutable immediately, which
    // is why it is inserted complete in one statement.
    await ownerQuery(
      'begin;\n' +
        NO_FORCE +
        '\ninsert into public.scenario_version ' +
        '(id, scenario_id, version_no, content, is_fiction, as_of_date, ' +
        'rubric_version_id, published_at) values ' +
        "(:'v2', :'s', 2, '{\"case_id\":\"DEMO-PH-001\",\"case_version\":2}'::jsonb, " +
        "true, '2026-03-20', :'r', now())\n" +
        'on conflict (id) do nothing;\n' +
        FORCE +
        '\ncommit;',
      { v2: VERSION_2, s: SCENARIO, r: RUBRIC_V1 },
    )

    // GATE 1 — version 1 did not move. The hash is over the content bytes, so this is a
    // statement about the content and not merely about the row still existing.
    const afterV1 = await runAsUser(user, async (db) =>
      db.queryOne<VersionRow>(READ_VERSION_SQL, [VERSION_1]),
    )
    expect(afterV1.content_hash).toBe(before.content_hash)
    expect(afterV1.published_at).toBe(before.published_at)
    expect(afterV1.version_no).toBe(1)

    // GATE 2 — the submitted revision still resolves version 1.
    const revisions = await runAsUser(user, async (db) => {
      const result = await db.query<{ id: string; revision_no: number; content: JsonObject }>(
        READ_REVISION_SQL,
        [decisionId],
      )
      return [...result.rows]
    })
    expect(revisions).toHaveLength(1)
    const revision = revisions[0]
    expect(revision?.content['scenario_version_id']).toBe(VERSION_1)

    // GATE 3 — and the pin cannot be rewritten after the fact. `decision_revision` is
    // append-only and the app role holds no UPDATE grant, so the recorded version is as
    // immutable as the decision itself. Without this leg, "it still says v1" is a
    // statement about what nobody happened to overwrite.
    const rewrite = await appRejection(user, async (db) =>
      db.query(UPDATE_REVISION_SQL, [revision?.id ?? '', 'rewritten']),
    )
    expect(rewrite.sqlState).toBe('42501')

    // POSITIVE CONTROL, and the reason this test can distinguish pinning from v2 being
    // unreachable: the SAME user reads version 2 independently, and its content differs.
    const v2 = await runAsUser(user, async (db) =>
      db.queryOne<VersionRow>(READ_VERSION_SQL, [VERSION_2]),
    )
    expect(v2.scenario_id).toBe(SCENARIO)
    expect(v2.version_no).toBe(2)
    expect(v2.published_at).not.toBeNull()
    expect(v2.content_hash).not.toBe(before.content_hash)

    const versions = await runAsUser(user, async (db) =>
      db.queryOne<CountRow>(COUNT_VERSIONS_SQL, [SCENARIO]),
    )
    expect(versions.n).toBe(2)

    // WHAT THIS TEST DOES NOT ESTABLISH, stated here rather than left to be assumed.
    // Canon §5.1 gives `decision_revision` a `scenario_version_id` with a composite FK;
    // migration 0003 did not create it and 0008 did not add it, so there is no column
    // for INV-07 to constrain. Nothing in the schema requires the pin recorded above to
    // name a version that exists, belongs to the right scenario, or was published. What
    // IS asserted is the anchor such an FK needs, so the shape is known to be available
    // when the column lands.
    const anchors = await appQuery(VERSION_UNIQUE_SQL)
    const defs = anchors.map((row) => row[1] ?? '')
    expect(defs).toContain('PRIMARY KEY (id)')
    expect(defs).toContain('UNIQUE (scenario_id, version_no)')
  })

  // 12 ---------------------------------------------------------------
  it('[FR-07] all five challenge lenses are grounded in registered claims', async () => {
    const content = await readCaseBody(user)
    const register = readRegister(content)
    const lenses = asArray(content['challenge_lenses'], 'challenge_lenses').map((raw, i) => {
      const entry = asObject(raw, `challenge_lenses[${String(i)}]`)
      return {
        lens: asString(entry['lens'], `challenge_lenses[${String(i)}].lens`),
        grounding: asArray(
          entry['grounding_claims'],
          `challenge_lenses[${String(i)}].grounding_claims`,
        ).map((g, j) => asString(g, `challenge_lenses[${String(i)}].grounding_claims[${String(j)}]`)),
      }
    })

    // PRD §5.3 requires all five lenses, and canon §7.2 sends exactly one lens per
    // challenge run. A case that cannot ground five lenses makes the fifth run either
    // ungrounded or an empty response.
    expect(lenses.map((l) => l.lens)).toEqual([...LENSES])

    const dbClaims = await runAsUser(user, async (db) => {
      const result = await db.query<ClaimRow>(LIST_CLAIMS_SQL, [VERSION_1])
      return [...result.rows]
    })
    const inDatabase = new Set(dbClaims.map((c) => c.claim_id))
    expect(inDatabase.size).toBe(EXPECTED_CLAIMS)

    for (const { lens, grounding } of lenses) {
      // Leg 1 — the lens names claims, and every one of them resolves to a registered
      // row. An unresolvable grounding reference is a lens that LOOKS grounded.
      expect(grounding.length, `lens ${lens} grounding list`).toBeGreaterThan(0)
      const missing = grounding.filter((id) => !inDatabase.has(id))
      expect(missing, `lens ${lens} names unregistered claims`).toEqual([])

      // Leg 2 — the other direction: at least one REGISTERED claim is tagged with this
      // lens in the register. Leg 1 alone would pass if the lens block cited claims that
      // nothing in the register considers relevant to it.
      const tagged = register.filter((e) => e.lenses.includes(lens)).map((e) => e.claimId)
      expect(tagged.length, `claims tagged for lens ${lens}`).toBeGreaterThan(0)
      const taggedAndStored = tagged.filter((id) => inDatabase.has(id))
      expect(taggedAndStored.length, `stored claims tagged for lens ${lens}`).toBeGreaterThan(0)
    }

    // WHAT THIS TEST CANNOT CHECK. Lens tagging lives in the `content` jsonb only:
    // `scenario_claim` has no `lens` column, so there is no relational constraint
    // between a lens and the claims that ground it, and nothing stops a later edit from
    // tagging a claim for a lens whose text never mentions it. The assertions above are
    // content-level by necessity, not by choice.
    const everyClaimTagged = register.filter((e) => e.lenses.length === 0).map((e) => e.claimId)
    expect(everyClaimTagged).toEqual([])
  })

  // 13 ---------------------------------------------------------------
  it('[FR-01] the case body carries every element the user must see before starting', async () => {
    // FR-01's acceptance condition names six things: task, assumed role, timeline,
    // available resources, missing information and topic. The screen that shows them is
    // a later slice; what is testable now is whether the published content contains them
    // at all, because a case missing any one of them cannot satisfy FR-01 no matter how
    // the page is written. Asserted against the stored jsonb, not against the file on
    // disk — the row is what the application will read.
    const content = await readCaseBody(user)

    // task / the decision required
    const required = asArray(content['required_decision'], 'required_decision')
    expect(required.length).toBeGreaterThan(0)
    expect(asString(content['issue_statement'], 'issue_statement').length).toBeGreaterThan(0)

    // assumed role, with its explicit limits — PRD §9.4 and canon §1.2: the user is
    // never told they hold an authority the case has not given them.
    const role = asObject(content['user_role'], 'user_role')
    expect(asString(role['title'], 'user_role.title').length).toBeGreaterThan(0)
    expect(asString(role['authority_in_scenario'], 'user_role.authority_in_scenario').length)
      .toBeGreaterThan(0)
    expect(asArray(role['explicit_limits'], 'user_role.explicit_limits').length).toBeGreaterThan(0)

    // timeline
    const window = asObject(content['decision_window'], 'decision_window')
    expect(typeof window['window_hours']).toBe('number')
    expect(asString(window['in_world_deadline'], 'decision_window.in_world_deadline')).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    )

    // available resources, and the constraints every lens of PRD §5.3 reads
    expect(asArray(content['available_resources'], 'available_resources').length).toBeGreaterThan(0)
    const constraints = asObject(content['constraints'], 'constraints')
    for (const key of ['legal_authority', 'budgetary', 'operational']) {
      expect(Object.keys(constraints)).toContain(key)
    }

    // missing information. This one is load-bearing beyond FR-01: PRD §6.2's FR-07 lets
    // a challenge reference "an identified information gap", and canon §7.3 drops a
    // challenge whose citations do not resolve. A case with no declared gaps gives the
    // challenge layer nothing honest to point at, so an empty list is a defect here and
    // not merely a thin case.
    expect(asArray(content['data_gaps'], 'data_gaps').length).toBeGreaterThan(0)

    // topic
    expect(asString(content['sector'], 'sector').length).toBeGreaterThan(0)
    const scenario = await runAsUser(user, async (db) =>
      db.queryOne<ScenarioRow>(READ_SCENARIO_SQL, [SCENARIO_SLUG]),
    )
    // The relational columns and the body agree on the topic. Two stores, one fact: the
    // library will filter on the column (FR-06, deferred) and the desk will render the
    // body, and a divergence would show a different subject in each.
    expect(scenario.sector).toBe(content['sector'])
  })
})
