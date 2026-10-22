/**
 * Source gate: no composite score exists anywhere.    [NFR-01] and CLAUDE.md §2
 *
 * Implementation plan task 3.6: "asserts no component file and no API response contains an
 * aggregate score field name from a committed deny-list."
 *
 * ── WHY A PROHIBITION NEEDS A TEST AT ALL ───────────────────────────────────
 *
 * This one is not a bug class, it is a product boundary, and it is the single most
 * load-bearing one in the repository. CLAUDE.md §2 lists it first among the hard
 * prohibitions: "No composite score of any kind — no readiness, character, viability or
 * fitness index, and no summing or averaging of the five dimensions." `docs/decisions.md`
 * D14 records it as prohibited rather than deferred. PRD §1.4 principle 7 and §5.1 both say
 * the surface shows a multidimensional profile plus evidence quality, "not a large readiness
 * score".
 *
 * A prohibition enforced only by everyone remembering it is enforced by nothing. A composite
 * score is also the single most likely thing to be added in good faith — it is what every
 * comparable product has, it makes a dashboard look finished, and it would arrive in a commit
 * whose message says "add summary metric" and read as an improvement. This gate is what makes
 * that commit fail.
 *
 * ── WHAT THIS GATE CAN AND CANNOT SEE, STATED PLAINLY ───────────────────────
 *
 * It matches NAMES. It will catch `readinessScore`, a `composite_score` column, an
 * `overall_rating` field in a response shape. It will NOT catch an unnamed arithmetic mean of
 * five values assigned to a variable called `x`, and no name-based check could. So this gate
 * is a floor, not a proof, and the prohibition still relies on review for the arithmetic
 * case. Saying so here is the point: a gate whose limits are not written down gets cited as
 * evidence for a claim it never made.
 *
 * ── COMMENTS ARE STRIPPED, AND THAT IS THE WHOLE REASON THIS RUNS AT ALL ────
 *
 * Every banned term below appears, in prose, in CLAUDE.md, the canon, `docs/decisions.md`,
 * the PRD and the shell page — because the prohibition has to be WRITTEN somewhere to be
 * followed. The sibling gate `no-unscoped-counts.test.ts` recorded the same lesson by
 * execution: its first version flagged three sites that were all comments explaining the bug
 * it was looking for. So both files share one comment-stripper (`support/source-scan.ts`)
 * rather than each growing its own.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectWithExtensions,
  stripComments,
  stripSqlComments,
} from './support/source-scan'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * The committed deny-list.
 *
 * Each entry is matched as a whole identifier, case-insensitively, against both snake_case
 * and camelCase spellings. Word boundaries are not optional: `xp` as a bare substring matches
 * `expected`, which appears in nearly every file in the project, and a gate that fires on
 * every file is a gate that gets deleted.
 */
const BANNED_IDENTIFIERS: readonly string[] = [
  // Composite indices by every name the PRD, the canon and CLAUDE.md use for them.
  'readiness_score',
  'readiness_index',
  'readinessScore',
  'readinessIndex',
  'overall_score',
  'overallScore',
  'overall_rating',
  'overallRating',
  'overall_level',
  'overallLevel',
  'composite_score',
  'compositeScore',
  'composite_index',
  'compositeIndex',
  'aggregate_score',
  'aggregateScore',
  'total_score',
  'totalScore',
  'weighted_score',
  'weightedScore',
  'average_score',
  'averageScore',
  'avg_score',
  'avgScore',
  'character_score',
  'characterScore',
  'viability_score',
  'viabilityScore',
  'fitness_score',
  'fitnessScore',
  'statesman_score',
  'statesmanScore',
  'decision_score',
  'decisionScore',
  'maturity_score',
  'maturityScore',
  // CLAUDE.md §2, same sentence: "No leaderboards, XP, punitive streaks, social feeds or
  // public profiles." These belong in the same gate because they are the same failure —
  // turning practice into a score — and they would arrive in the same commit.
  'leaderboard',
  'total_points',
  'totalPoints',
  'streak_count',
  'streakCount',
  'current_streak',
  'currentStreak',
] as const

interface Violation {
  readonly file: string
  readonly line: number
  readonly identifier: string
  readonly text: string
}

/** A whole-identifier, case-insensitive match. */
function patternFor(identifier: string): RegExp {
  // `\b` would treat `_` as a word character, so `my_readiness_score` is deliberately a
  // match: a prefix does not make a composite score something else.
  return new RegExp(`(^|[^A-Za-z0-9_])${identifier}([^A-Za-z0-9_]|$)`, 'i')
}

function findViolations(raw: string, file: string, kind: 'ts' | 'sql'): Violation[] {
  const stripped = kind === 'ts' ? stripComments(raw) : stripSqlComments(raw)
  const lines = stripped.split('\n')
  const rawLines = raw.split('\n')
  const out: Violation[] = []
  lines.forEach((line, index) => {
    for (const identifier of BANNED_IDENTIFIERS) {
      if (patternFor(identifier).test(line)) {
        out.push({
          file,
          line: index + 1,
          identifier,
          text: (rawLines[index] ?? '').trim().slice(0, 140),
        })
      }
    }
  })
  return out
}

function scan(dir: string, extensions: readonly string[], kind: 'ts' | 'sql'): Violation[] {
  const out: Violation[] = []
  for (const file of collectWithExtensions(join(REPO_ROOT, dir), extensions)) {
    out.push(...findViolations(readFileSync(file, 'utf8'), relative(REPO_ROOT, file), kind))
  }
  return out
}

describe('no composite score anywhere', () => {
  it('[NFR-01] no application source names an aggregate score', () => {
    const violations = scan('src', ['.ts', '.tsx'], 'ts')
    expect(
      violations,
      'CLAUDE.md §2 and docs/decisions.md D14 prohibit a composite score of any kind. ' +
        'If one of these names is genuinely not a composite index, rename it; the ' +
        'prohibition is not negotiable and this list is not a style preference.\n' +
        violations.map((v) => `  ${v.file}:${v.line} [${v.identifier}] ${v.text}`).join('\n'),
    ).toEqual([])
  })

  /**
   * D14 says "anywhere in schema, API response or UI", so the schema is scanned too. A
   * `composite_score` COLUMN would be the most durable form of this failure: a UI can be
   * changed in an afternoon, and a column that exists invites something to populate it.
   */
  it('[NFR-01] no migration declares an aggregate score column', () => {
    const violations = scan('supabase/migrations', ['.sql'], 'sql')
    expect(
      violations,
      'A composite score column in the schema is the most durable form of the thing D14 ' +
        'prohibits.\n' +
        violations.map((v) => `  ${v.file}:${v.line} [${v.identifier}] ${v.text}`).join('\n'),
    ).toEqual([])
  })

  /* ---------------------------------------------------------------- *
   * The controls. Without these, the two tests above pass trivially.
   * ---------------------------------------------------------------- */

  it('[NFR-01] CONTROL: the detector flags a banned identifier in code', () => {
    const planted = [
      'export interface Summary {',
      '  readinessScore: number',
      '}',
    ].join('\n')
    const found = findViolations(planted, 'planted.ts', 'ts')
    expect(found.map((v) => v.identifier)).toContain('readinessScore')
    expect(found[0]?.line, 'the reported line must be the planted one').toBe(2)
  })

  it('[NFR-01] CONTROL: the detector flags a banned column in SQL', () => {
    const planted = 'create table public.thing (\n  composite_score smallint\n);'
    const found = findViolations(planted, 'planted.sql', 'sql')
    expect(found.map((v) => v.identifier)).toContain('composite_score')
  })

  /**
   * THE CONTROL ON THE CONTROL. The detector must NOT fire on prose. If this fails, the two
   * repository-wide tests above are passing for the wrong reason — or, far more likely, they
   * are FAILING on the project's own documentation and someone is about to silence them.
   */
  it('[NFR-01] CONTROL: prose describing the prohibition is not a violation', () => {
    const tsProse = [
      '// No composite_score or readinessScore may exist: see CLAUDE.md §2.',
      '/* A readiness_index would be prohibited, not merely deferred (D14). */',
      'export const ok = 1',
    ].join('\n')
    expect(findViolations(tsProse, 'prose.ts', 'ts')).toEqual([])

    const sqlProse = [
      '-- No composite_score column exists; D14 prohibits a readiness_index.',
      'create table public.fine (id uuid primary key);',
    ].join('\n')
    expect(findViolations(sqlProse, 'prose.sql', 'sql')).toEqual([])
  })

  /**
   * The `--`-inside-a-string case, asserted because getting it wrong fails in the UNSAFE
   * direction: everything after the quote would be blanked and a real violation on that line
   * would be missed.
   */
  it('[NFR-01] CONTROL: a double dash inside a SQL string does not blank the rest of the line', () => {
    const planted = "select 'a -- b' as note, composite_score from public.thing;"
    expect(findViolations(planted, 'planted.sql', 'sql').map((v) => v.identifier)).toContain(
      'composite_score',
    )
  })

  it('[NFR-01] CONTROL: word boundaries hold, so ordinary words are not violations', () => {
    // `xp` inside `expected`, `streak` without the banned suffix, and a legitimate
    // per-dimension maturity level, which the product DOES have (0-4 per dimension) and
    // which must not be confused with a composite one.
    const benign = [
      'const expected = computeExpected()',
      'const maturity_level = 2',
      'const confidence = 60',
      'const scoreboardIsNotAWord = 1',
    ].join('\n')
    expect(findViolations(benign, 'benign.ts', 'ts')).toEqual([])
  })

  it('[NFR-01] CONTROL: the deny-list is populated and free of duplicates', () => {
    // A gate reading an empty list passes everything. A duplicated entry would double-report
    // and make the violation count misleading.
    expect(BANNED_IDENTIFIERS.length).toBeGreaterThan(20)
    expect(new Set(BANNED_IDENTIFIERS).size).toBe(BANNED_IDENTIFIERS.length)
  })

  it('[NFR-01] CONTROL: the scan actually reached files', () => {
    // The most embarrassing way for a source gate to pass: a wrong path, zero files read,
    // zero violations, green.
    const tsFiles = collectWithExtensions(join(REPO_ROOT, 'src'), ['.ts', '.tsx'])
    const sqlFiles = collectWithExtensions(join(REPO_ROOT, 'supabase/migrations'), ['.sql'])
    expect(tsFiles.length, 'no TypeScript files were scanned').toBeGreaterThan(3)
    expect(sqlFiles.length, 'no migrations were scanned').toBeGreaterThan(5)
  })
})
