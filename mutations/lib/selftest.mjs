/* global process */
// eslint.config.mjs applies only `eslint.configs.recommended` to **/*.mjs and declares
// no Node globals there, so `process` would trip no-undef and break `npm run lint` for
// the whole repo. Declaring it here keeps the fix inside this directory rather than
// editing a shared config that these files do not own.
/**
 * A control for the mutation applier itself.
 *
 * Canon §8 applies to this harness as much as to the code it measures: an instrument that
 * cannot be made to report the negative has not been shown to work. The applier is the
 * instrument, and it has already been wrong once in a way that was invisible from the
 * outside — `readBlock` advanced past a marker it was already past, which silently
 * emptied every single-line @@REPLACE block and truncated the first line of every
 * multi-line one. Mutations then applied a corrupted edit, the suite went red for the
 * wrong reason, and the gate reported "MISATTRIBUTED" without being able to say why.
 *
 * So this runs at the gate's preflight, against synthetic mutations with known bytes:
 *
 *   1. a single-line FIND and a single-line REPLACE round-trip EXACTLY;
 *   2. a multi-line FIND and a multi-line REPLACE round-trip EXACTLY, first and last
 *      lines included;
 *   3. two edits in one mutation both land;
 *   4. a new-file block creates the file with the exact content;
 *   5. a FIND that is not present fails (the stale-mutation path);
 *   6. a FIND present twice with `count: 1` fails (the ambiguous-target path);
 *   7. a FIND present twice with `count: 2` replaces both;
 *   8. `expect: uncaught` without a `todo:` fails;
 *   9. a path containing `..` fails.
 *
 * Checks 5-9 are the ones that matter most: they are the cases where the applier must
 * report a negative. Without them a permissive applier would read as a working one.
 *
 * Exit 0 all good, 2 the instrument is broken.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMutation, parseMutation } from './mutation.mjs'

let failures = 0
const root = mkdtempSync(join(tmpdir(), 'mutation-selftest.'))

function check(name, fn) {
  try {
    fn()
    process.stdout.write(`    ok   ${name}\n`)
  } catch (error) {
    failures += 1
    process.stdout.write(`    FAIL ${name}: ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

/** Assert that `fn` throws, and that the message mentions `fragment`. */
function throws(fn, fragment) {
  let threw = false
  try {
    fn()
  } catch (error) {
    threw = true
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes(fragment)) {
      throw new Error(`threw, but the message does not mention '${fragment}': ${message}`)
    }
  }
  if (!threw) throw new Error(`expected a throw mentioning '${fragment}', got none`)
}

function equal(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`)
  }
}

let seq = 0
/** Write a .mut file and a target file, apply, and return the target's new content. */
function run(body, targetName, targetContent) {
  seq += 1
  const dir = join(root, `case${String(seq)}`)
  mkdirSync(dir, { recursive: true })
  const mutFile = join(dir, 'case.mut')
  writeFileSync(mutFile, body, 'utf8')
  if (targetName !== undefined) writeFileSync(join(dir, targetName), targetContent, 'utf8')
  const mutation = parseMutation(mutFile)
  applyMutation(mutation, dir)
  return targetName === undefined ? dir : readFileSync(join(dir, targetName), 'utf8')
}

const HEAD = 'id: T\ntitle: t\nexpect: caught\nexpect-test: x\n'

check('1 single-line FIND and single-line REPLACE round-trip exactly', () => {
  const out = run(
    `${HEAD}file: t.sql\n@@FIND\n    where a = 'b'\n@@REPLACE\n    where a = 'c'\n@@END\n`,
    't.sql',
    "head\n    where a = 'b'\ntail\n",
  )
  equal(out, "head\n    where a = 'c'\ntail\n", 'single-line replacement')
})

check('2 multi-line FIND and multi-line REPLACE keep their first and last lines', () => {
  const out = run(
    `${HEAD}file: t.ts\n@@FIND\nL1\nL2\nL3\n@@REPLACE\nR1\nR2\n@@END\n`,
    't.ts',
    'before\nL1\nL2\nL3\nafter\n',
  )
  equal(out, 'before\nR1\nR2\nafter\n', 'multi-line replacement')
})

check('3 two edits in one mutation both land', () => {
  const out = run(
    `${HEAD}file: t.sql\n@@FIND\nAAA\n@@REPLACE\nXXX\n@@END\n\nfile: t.sql\n@@FIND\nBBB\n@@REPLACE\nYYY\n@@END\n`,
    't.sql',
    'AAA\nmid\nBBB\n',
  )
  equal(out, 'XXX\nmid\nYYY\n', 'both edits')
})

check('4 a new-file block writes the exact content', () => {
  const dir = run(`${HEAD}new-file: made.sql\n@@CONTENT\nline one\nline two\n@@END\n`, undefined, '')
  equal(readFileSync(join(dir, 'made.sql'), 'utf8'), 'line one\nline two\n', 'created file')
})

check('5 NEGATIVE: a FIND that is absent fails as a stale mutation', () => {
  throws(
    () => run(`${HEAD}file: t.sql\n@@FIND\nNOPE\n@@REPLACE\nX\n@@END\n`, 't.sql', 'something else\n'),
    'STALE MUTATION',
  )
})

check('6 NEGATIVE: a FIND present twice with count: 1 fails as ambiguous', () => {
  throws(
    () => run(`${HEAD}file: t.sql\ncount: 1\n@@FIND\nDUP\n@@REPLACE\nX\n@@END\n`, 't.sql', 'DUP\nDUP\n'),
    'STALE MUTATION',
  )
})

check('7 a FIND present twice with count: 2 replaces both', () => {
  const out = run(
    `${HEAD}file: t.sql\ncount: 2\n@@FIND\nDUP\n@@REPLACE\nX\n@@END\n`,
    't.sql',
    'DUP\nmid\nDUP\n',
  )
  equal(out, 'X\nmid\nX\n', 'both occurrences')
})

check('8 NEGATIVE: expect: uncaught without a todo: is rejected', () => {
  throws(() => {
    seq += 1
    const dir = join(root, `case${String(seq)}`)
    mkdirSync(dir, { recursive: true })
    const f = join(dir, 'case.mut')
    writeFileSync(f, 'id: T\ntitle: t\nexpect: uncaught\nexpect-test: x\nfile: t\n@@FIND\nA\n@@REPLACE\nB\n@@END\n', 'utf8')
    parseMutation(f)
  }, "requires a 'todo:'")
})

check('9 NEGATIVE: a path that escapes the mirror is refused', () => {
  throws(
    () => run(`${HEAD}file: ../outside.sql\n@@FIND\nA\n@@REPLACE\nB\n@@END\n`, undefined, ''),
    'escapes the mirror',
  )
})

rmSync(root, { recursive: true, force: true })

if (failures > 0) {
  process.stdout.write(`  mutation applier SELF-TEST FAILED (${String(failures)} check(s))\n`)
  process.exit(2)
}
process.stdout.write('  mutation applier self-test: 9/9\n')
