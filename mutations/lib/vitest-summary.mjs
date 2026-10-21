/* global process */
// eslint.config.mjs applies only `eslint.configs.recommended` to **/*.mjs and declares
// no Node globals there, so `process` would trip no-undef and break `npm run lint` for
// the whole repo. Declaring it here keeps the fix inside this directory rather than
// editing a shared config that these files do not own.
/**
 * Turn `vitest run --reporter=json --outputFile=<f>` into `key=value` lines the gate
 * script can read, and say whether a NAMED test failed.
 *
 * Why this exists at all: "the suite exited non-zero" is not evidence that the guard
 * under mutation was caught. A prior version of this harness treated any non-zero exit
 * as "detected" and would have reported success on six mutations while a typo in the
 * runner was the only thing failing. So the gate matches the expected test by name, and
 * this script is the only place that reads the reporter's output.
 *
 * Shapes measured against vitest 5.0.5 on this machine:
 *   top level        numTotalTests, numPassedTests, numFailedTests, success, testResults[]
 *   testResults[]    name (file path), status ('passed'|'failed'), message, assertionResults[]
 *   assertionResults ancestorTitles[], title, fullName, status, failureMessages[]
 *
 * Three outcomes are deliberately distinguished, because they mean different things:
 *   json_present=0   the reporter produced nothing — globalSetup, the template build or
 *                    the role guard aborted the run before any test executed. For a
 *                    mutation whose expected catcher IS that abort, `expect-test: #abort`
 *                    matches it; for any other, it is NOT a catch.
 *   failed=0         the suite ran green.
 *   failed>0         at least one test failed; `expected_match` says whether the one the
 *                    mutation names is among them.
 *
 * EVERY expected substring must match a failing test, not just one. A mutation that
 * hollows out two rules at once (M8 does: posture rules 9 and 10) has more than one
 * control, and matching any single one of them would let the others rot unnoticed.
 *
 * usage: node vitest-summary.mjs <json-path> <expected-test-substring>...
 * Exit status is 0 whenever the file could be read or is legitimately absent; the gate
 * reads the key=value lines and decides. A malformed (not merely absent) file exits 2,
 * because that is a broken instrument rather than a test result.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'

function emit(key, value) {
  process.stdout.write(`${key}=${String(value)}\n`)
}

const [jsonPath, ...expectedRaw] = process.argv.slice(2)
if (jsonPath === undefined) {
  process.stderr.write('usage: vitest-summary.mjs <json-path> <expected-test-substring>...\n')
  process.exit(2)
}
const expected = expectedRaw.filter((e) => e.length > 0)
const wantsAbort = expected.includes('#abort')

if (!existsSync(jsonPath) || statSync(jsonPath).size === 0) {
  emit('json_present', 0)
  emit('total', 0)
  emit('passed', 0)
  emit('failed', 0)
  emit('files_failed', 0)
  // No results at all. Only a mutation that explicitly expects the abort counts as
  // matched; for everything else "the suite never ran" is not a catch.
  emit('expected_match', wantsAbort && expected.length === 1 ? 1 : 0)
  for (const e of expected) if (e !== '#abort') emit('expected_missing', e)
  process.exit(0)
}

let report
try {
  report = JSON.parse(readFileSync(jsonPath, 'utf8'))
} catch (error) {
  process.stderr.write(
    'vitest-summary: the reporter output exists but is not JSON: ' +
      (error instanceof Error ? error.message : String(error)) +
      '\n',
  )
  process.exit(2)
}

const files = Array.isArray(report.testResults) ? report.testResults : []
const assertions = files.flatMap((f) => (Array.isArray(f.assertionResults) ? f.assertionResults : []))
const failedAssertions = assertions.filter((a) => a.status === 'failed')
const failedFiles = files.filter((f) => f.status === 'failed')

// A file that failed to collect (an import error, a beforeAll throw) reports
// status 'failed' with ZERO assertionResults. Counting only assertions would read that
// as a green suite with a non-zero exit, which is the ambiguity this whole script exists
// to remove, so file-level failures are carried as their own number.
const total = typeof report.numTotalTests === 'number' ? report.numTotalTests : assertions.length
const passed = typeof report.numPassedTests === 'number' ? report.numPassedTests : 0

emit('json_present', 1)
emit('total', total)
emit('passed', passed)
emit('failed', failedAssertions.length)
emit('files_failed', failedFiles.length)

const names = failedAssertions.map((a) =>
  typeof a.fullName === 'string' && a.fullName.length > 0
    ? a.fullName
    : [...(a.ancestorTitles ?? []), a.title ?? '<untitled>'].join(' '),
)

// The run produced results, so it did not abort before executing tests: an `#abort`
// expectation can never be satisfied here.
const missing = expected.filter((e) => e === '#abort' || !names.some((n) => n.includes(e)))
emit('expected_match', expected.length > 0 && missing.length === 0 ? 1 : 0)
for (const e of missing) emit('expected_missing', e)

for (const name of names) emit('failed_test', name)

// The FULL inventory of test names this run executed, not just the failures. The gate
// uses the baseline's inventory to check that every registered `expect-test:` substring
// identifies exactly one test. Without that check `expect-test` is a bare substring with
// no specificity requirement, and a catcher named by the single character 'e' was shown
// to make the gate print "CAUGHT — every named control failed" and "GATE PASSED". A
// catcher that cannot be resolved to one named test is not a control, it is a coincidence.
const allNames = assertions.map((a) =>
  typeof a.fullName === 'string' && a.fullName.length > 0
    ? a.fullName
    : [...(a.ancestorTitles ?? []), a.title ?? '<untitled>'].join(' '),
)
for (const name of allNames) emit('inventory_test', name)

// One short reason per failing test, so the report can say WHY the test caught it and
// not merely that it did. Newlines are stripped: these lines are read field-by-field.
for (const a of failedAssertions) {
  const first = Array.isArray(a.failureMessages) ? (a.failureMessages[0] ?? '') : ''
  const oneLine = String(first).replace(/\s+/g, ' ').slice(0, 300)
  if (oneLine.length > 0) emit('failed_reason', oneLine)
}

// A file-level failure has no assertion to name, so surface its message instead.
for (const f of failedFiles) {
  if (Array.isArray(f.assertionResults) && f.assertionResults.some((a) => a.status === 'failed')) continue
  const oneLine = String(f.message ?? '').replace(/\s+/g, ' ').slice(0, 300)
  emit('failed_file', `${String(f.name ?? '<unknown>')} :: ${oneLine}`)
}
