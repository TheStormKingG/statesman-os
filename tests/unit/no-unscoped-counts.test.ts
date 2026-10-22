/**
 * A source-level gate against whole-table assertions in the integration suite.
 *
 * WHY THIS EXISTS, and why it is a test rather than a convention:
 *
 * vitest.integration.config.ts sets `isolate: false` and gives each Vitest WORKER one
 * cloned database shared by every test file that worker runs. That is a deliberate
 * harness contract: per-file isolation would multiply template clones and the files are
 * written against the shared-worker model.
 *
 * The cost is that `select count(*) from public.decision` is not a statement about the
 * file that wrote it. It is a statement about which sibling files the scheduler happened
 * to run first. Such an assertion is green or red depending on file-to-worker assignment,
 * which shifts every time a file is added.
 *
 * This bug has occurred TWICE, in two files, written by two agents who could not see each
 * other's work:
 *   - state-machine.test.ts asserted `count(*) from public.decision === 1`. Observed
 *     failing with 13 and with 20; passed when run alone.
 *   - forgery.test.ts's cleanup asserted the same thing while deleting only its own rows.
 *     7 of 9 full runs green, --maxWorkers=1 deterministically red, and the failure
 *     surfaced in an afterAll hook AFTER all 75 assertions had reported passing.
 *
 * Two independent authors reaching for the same wrong construct means the contract invites
 * it, so the contract needs enforcement and not another comment. Canon section 8 is the
 * governing rule: a gate nobody can forget beats a discipline everybody must remember.
 *
 * The escape hatch is deliberate and visible: a genuinely global claim may be written with
 * an `unscoped-count-ok:` marker and a reason on the preceding line.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// `collect` and `stripComments` are shared with the other source gate rather
// than duplicated; see tests/unit/support/source-scan.ts for why.
import { collect, stripComments } from './support/source-scan'

const INTEGRATION_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'integration')

/** Tables under RLS, where a global count is a cross-file claim. */
const PROTECTED = ['decision', 'decision_revision', 'app_user']

const OPT_OUT = 'unscoped-count-ok:'

/** How far after `from public.<table>` we look for a scoping predicate. */
const SCOPE_WINDOW = 200

/** Lines of preceding comment searched for a reasoned opt-out marker. */
const OPT_OUT_LOOKBACK = 8

interface Violation {
  file: string
  line: number
  snippet: string
}

function findViolations(rawSource: string, file: string): Violation[] {
  const violations: Violation[] = []
  const lines = rawSource.split('\n')
  const source = stripComments(rawSource)

  for (const table of PROTECTED) {
    // Match a count() aggregate reading the table, in any whitespace arrangement.
    const re = new RegExp(`count\\s*\\(\\s*\\*\\s*\\)[^;]{0,80}?from\\s+public\\.${table}\\b`, 'gis')
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) {
      const start = m.index
      const tail = source.slice(start, start + SCOPE_WINDOW)

      // Scoped if a predicate naming ANY id-bearing column follows within the window.
      // `\bid\b` alone was too narrow: `where decision_id = $1` is properly scoped, but
      // the underscore is a word character so there is no boundary before "id".
      const scoped = /\bwhere\b[^;]{0,160}?\b\w*_?id\b/is.test(tail)
      if (scoped) continue

      const lineNo = source.slice(0, start).split('\n').length
      // An explicit, reasoned opt-out in the preceding comment block. The window is
      // OPT_OUT_LOOKBACK lines rather than one, because the marker is required to carry a
      // REASON and a reason worth reading does not fit on the line above the query. A
      // one-line window would push authors toward `// unscoped-count-ok:` with no
      // justification, which is the outcome this gate is trying to avoid.
      const from = Math.max(0, lineNo - 1 - OPT_OUT_LOOKBACK)
      const nearby = lines.slice(from, lineNo).join('\n')
      if (nearby.includes(OPT_OUT)) continue

      violations.push({
        file,
        line: lineNo,
        snippet: m[0].replace(/\s+/g, ' ').slice(0, 110),
      })
    }
  }
  return violations
}

describe('integration suite source gate: no unscoped counts on protected tables', () => {
  const files = collect(INTEGRATION_DIR)

  it('finds integration test sources to scan', () => {
    // An empty glob would make every assertion below pass while checking nothing, which
    // is the exact failure mode canon section 8 names. Assert the population is non-empty.
    expect(files.length).toBeGreaterThan(5)
  })

  it('no integration source asserts a whole-table count on an RLS-protected table', () => {
    const violations = files.flatMap((f) =>
      findViolations(readFileSync(f, 'utf8'), f.slice(f.indexOf('tests/'))),
    )

    const report = violations
      .map((v) => `  ${v.file}:${v.line}  ${v.snippet}`)
      .join('\n')

    expect(
      violations,
      violations.length === 0
        ? ''
        : `Unscoped count(*) on an RLS-protected table in the integration suite.\n` +
            `The worker's database is SHARED between files (isolate: false), so a global\n` +
            `count measures which siblings ran first, not what this file did.\n` +
            `Scope it with a 'where user_id = ...' predicate, or if the global claim is\n` +
            `genuinely intended, put '${OPT_OUT} <reason>' on the preceding line.\n\n` +
            report,
    ).toEqual([])
  })

  it('the detector can actually fail (positive control)', () => {
    // Without this, a regex that matches nothing would make the gate above permanently
    // green. Two shapes: the bad one must be caught, the scoped one must not.
    const bad = `const r = await ownerQuery("select (select count(*)::text from public.decision);")`
    const good = `const r = await ownerQuery("select (select count(*)::text from public.decision where user_id = :'u'::uuid);")`

    expect(findViolations(bad, 'fixture.ts')).toHaveLength(1)
    expect(findViolations(good, 'fixture.ts')).toHaveLength(0)
  })

  it('scoping by any id-bearing column counts as scoped', () => {
    // `where decision_id = $1` is properly scoped. An earlier `\bid\b` predicate missed
    // it, because the underscore in `decision_id` is a word character so there is no
    // word boundary before "id" — a real query in forgery.test.ts was flagged for it.
    const byChildId = `'select count(*)::int as n from public.decision_revision where decision_id = $1::uuid'`
    expect(findViolations(byChildId, 'fixture.ts')).toHaveLength(0)
  })

  it('ignores counts that appear inside comments', () => {
    // The detector's first version flagged three sites that were all PROSE describing
    // this very bug, including the comment documenting the fix. A gate that flags its own
    // documentation teaches people to silence it.
    const inLineComment = `// this used to read select count(*) from public.decision and require 1\nconst x = 1`
    const inBlockComment = `/*\n * select count(*) from public.decision was a whole-table claim\n */\nconst x = 1`
    expect(findViolations(inLineComment, 'fixture.ts')).toHaveLength(0)
    expect(findViolations(inBlockComment, 'fixture.ts')).toHaveLength(0)

    // ...but a real query on the line AFTER a comment is still caught, so comment
    // stripping has not blinded the detector to adjacent code.
    const commentThenCode =
      `// a harmless note\nconst r = await ownerQuery("select count(*) from public.decision;")`
    expect(findViolations(commentThenCode, 'fixture.ts')).toHaveLength(1)
  })

  it('reports the correct line number after comment stripping', () => {
    // Comment blanking preserves offsets and newlines precisely so that the reported
    // line still points at the offending query. If it drifted, the gate would be
    // actionable in principle and useless in practice.
    const src = `// line 1\n// line 2\nconst r = q("select count(*) from public.decision;")\n`
    const v = findViolations(src, 'fixture.ts')
    expect(v).toHaveLength(1)
    expect(v[0]?.line).toBe(3)
  })

  it('the opt-out marker suppresses a flagged count (control on the escape hatch)', () => {
    const optedOut =
      `// ${OPT_OUT} the sentinel migration is the only writer at this point\n` +
      `const r = await ownerQuery("select (select count(*)::text from public.decision);")`
    expect(findViolations(optedOut, 'fixture.ts')).toHaveLength(0)
  })

  it('the opt-out marker still applies when its reason spans several lines', () => {
    // The marker is required to carry a reason, and a reason worth reading needs room.
    // A one-line lookback would push authors toward an unexplained marker.
    const multiLine =
      `    // ${OPT_OUT} the claim IS global and a lower bound, not an equality.\n` +
      `    // It asserts the table is non-empty so the denial above is over real data,\n` +
      `    // and a lower bound is monotonic, so sibling rows can only strengthen it.\n` +
      `    const owned = await ownerQuery('select count(*)::text from public.app_user;')`
    expect(findViolations(multiLine, 'fixture.ts')).toHaveLength(0)
  })

  it('an opt-out marker further away than the lookback does NOT suppress', () => {
    // Control on the control: the escape hatch must be local to the query it excuses,
    // or a single marker at the top of a file would silence the whole file.
    const tooFar =
      `// ${OPT_OUT} a reason stranded far above\n` +
      'const a = 1\n'.repeat(OPT_OUT_LOOKBACK + 3) +
      `const r = await ownerQuery("select count(*) from public.decision;")`
    expect(findViolations(tooFar, 'fixture.ts')).toHaveLength(1)
  })
})
