/* global process */
// eslint.config.mjs applies only `eslint.configs.recommended` to **/*.mjs and declares
// no Node globals there, so `process` would trip no-undef and break `npm run lint` for
// the whole repo. Declaring it here keeps the fix inside this directory rather than
// editing a shared config that these files do not own.
/**
 * Parse and apply one mutation definition.
 *
 * WHY THIS IS NOT A UNIFIED DIFF
 * ------------------------------
 * The first version of this harness used `.patch` files and /usr/bin/patch. Two problems
 * killed it, both measured on this machine:
 *
 *   1. `patch --version` here reports `patch 2.0-12u11-Apple`, not GNU patch. It is
 *      lenient about fuzz and offsets and unreliable at creating a new file from a
 *      `--- /dev/null` hunk, which mutation M8 needs.
 *   2. A unified diff carries line numbers. Several agents are editing `src/` and
 *      `migrations/` in this project concurrently, so a hunk that applies today applies
 *      with fuzz tomorrow and against the wrong code the day after. Fuzz is exactly the
 *      failure the gate exists to prevent: a patch that lands somewhere else, or lands
 *      partially, produces a red suite that gets read as "the guard has a control".
 *
 * So a mutation is a set of LITERAL find/replace edits with a REQUIRED occurrence count.
 * There is no fuzz, no context matching and no line numbers. If the target text is not
 * present exactly `count` times, applying fails loudly and the gate reports a stale
 * mutation rather than a caught one.
 *
 * FORMAT
 * ------
 *   # comment, ignored
 *   id: M1                      (required, unique, [A-Za-z0-9_-]+)
 *   title: one line             (required)
 *   expect: caught | uncaught   (required)
 *   expect-test: <substring>    (REPEATABLE, at least one. Each is matched against a
 *                                failing test's vitest `fullName`, and EVERY one must
 *                                match. The literal `#abort` means "the run produced no
 *                                test results at all", i.e. globalSetup or the role guard
 *                                aborted the suite before any test ran.)
 *   todo: <reason>              (required when expect: uncaught)
 *   proves: <free text>         (optional, repeatable; printed in the report)
 *
 *   file: <repo-relative path>  (the file the next edit block touches)
 *   count: 1                    (optional, default 1: required occurrences of FIND)
 *   @@FIND
 *   ...literal text...
 *   @@REPLACE
 *   ...literal text...
 *   @@END
 *
 *   new-file: <repo-relative path>   (the file the next block CREATES; must not exist)
 *   @@CONTENT
 *   ...literal text...
 *   @@END
 *
 * Text inside a block is taken byte-for-byte, minus the final newline before the closing
 * marker. Header keys may not repeat except `proves`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, normalize, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SINGLE_KEYS = ['id', 'title', 'expect', 'todo']
/**
 * `expect-test` is a LIST and every entry must be among the failures.
 *
 * It started as a single value, which was too weak for a mutation that disables more
 * than one rule: M8 hollows out posture rules 9 and 10 together, three separate controls
 * fail, and matching any ONE of them would let the other two rot unnoticed. "All of
 * these failed" is the claim worth making.
 */
const LIST_KEYS = ['proves', 'expect-test']

/** Count non-overlapping occurrences of a literal needle. */
function countOccurrences(haystack, needle) {
  if (needle.length === 0) throw new Error('empty FIND block')
  let n = 0
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    n += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return n
}

/** Replace every occurrence of a literal needle. No regex, so `$&` et al. are inert. */
function replaceAllLiteral(haystack, needle, replacement) {
  return haystack.split(needle).join(replacement)
}

/**
 * A path that must stay inside the mirror. A mutation file is repo content, so this is
 * not a security boundary — it is a guard against a typo'd `../../` quietly editing the
 * real repo while the harness reports on the mirror.
 */
function safeJoin(root, relative) {
  if (isAbsolute(relative)) throw new Error(`path must be repo-relative: ${relative}`)
  const full = resolve(root, relative)
  const prefix = resolve(root) + '/'
  if (!full.startsWith(prefix)) throw new Error(`path escapes the mirror: ${relative}`)
  return full
}

export function parseMutation(path) {
  const text = readFileSync(path, 'utf8')
  const lines = text.split('\n')
  const headers = {}
  const proves = []
  const expectTests = []
  const edits = []

  let i = 0
  let pendingFile = null
  let pendingCount = 1

  const fail = (message) => {
    throw new Error(`${path}:${String(i + 1)}: ${message}`)
  }

  /**
   * Read a block body. `i` must already point at the FIRST BODY LINE; on return it
   * points just past `marker`.
   *
   * The first version of this advanced past a marker itself before reading, which is
   * correct for the first block of a pair and wrong for the second — by then `i` is
   * already on the body. It silently dropped the first line of every REPLACE block:
   * single-line replacements came out EMPTY and multi-line ones came out TRUNCATED, so
   * mutations applied a corrupted edit and the gate reported misattributed catches. The
   * caller now consumes its own opening marker, and lib/selftest.mjs asserts the exact
   * bytes of both shapes so this cannot regress unnoticed.
   */
  const readBlock = (marker) => {
    const body = []
    while (i < lines.length && lines[i] !== marker) {
      body.push(lines[i])
      i += 1
    }
    if (i >= lines.length) fail(`unterminated block: expected ${marker}`)
    i += 1
    return body.join('\n')
  }

  while (i < lines.length) {
    const line = lines[i]

    if (line === '@@FIND') {
      if (pendingFile === null) fail('@@FIND without a preceding `file:` header')
      i += 1 // past @@FIND
      const find = readBlock('@@REPLACE')
      const replace = readBlock('@@END')
      // An empty FIND would match everywhere and is always a definition error. An empty
      // REPLACE is legitimate: deleting a guard is the most direct mutation there is.
      if (find.length === 0) fail('the @@FIND block is empty')
      if (find === replace) fail('@@FIND and @@REPLACE are identical')
      edits.push({ kind: 'replace', file: pendingFile, count: pendingCount, find, replace })
      pendingFile = null
      pendingCount = 1
      continue
    }

    if (line === '@@CONTENT') {
      if (pendingFile === null) fail('@@CONTENT without a preceding `new-file:` header')
      i += 1 // past @@CONTENT
      const content = readBlock('@@END')
      if (content.length === 0) fail('the @@CONTENT block is empty')
      edits.push({ kind: 'create', file: pendingFile, content })
      pendingFile = null
      pendingCount = 1
      continue
    }

    if (line.trim() === '' || line.startsWith('#')) {
      i += 1
      continue
    }

    const match = /^([a-z-]+):[ \t]*(.*)$/.exec(line)
    if (match === null) fail(`not a header or a block marker: ${JSON.stringify(line)}`)
    const key = match[1]
    const value = match[2].trim()

    if (key === 'file' || key === 'new-file') {
      if (pendingFile !== null) fail(`'${key}:' overrides an unused '${pendingFile}'`)
      // `file:` and `new-file:` are the same slot; the following block marker
      // (@@FIND vs @@CONTENT) decides whether the file is edited or created, and
      // `applyMutation` enforces that a created file does not already exist.
      pendingFile = normalize(value)
    } else if (key === 'count') {
      pendingCount = Number.parseInt(value, 10)
      if (!Number.isInteger(pendingCount) || pendingCount < 1) fail(`bad count: ${value}`)
    } else if (key === 'expect-test') {
      if (value === '') fail("empty 'expect-test:'")
      expectTests.push(value)
    } else if (LIST_KEYS.includes(key)) {
      proves.push(value)
    } else if (SINGLE_KEYS.includes(key)) {
      if (headers[key] !== undefined) fail(`duplicate header '${key}:'`)
      headers[key] = value
    } else {
      fail(`unknown header '${key}:'`)
    }
    i += 1
  }

  if (pendingFile !== null) throw new Error(`${path}: trailing '${pendingFile}' with no block`)

  for (const key of ['id', 'title', 'expect']) {
    if (headers[key] === undefined || headers[key] === '') {
      throw new Error(`${path}: missing required header '${key}:'`)
    }
  }
  if (expectTests.length === 0) {
    throw new Error(`${path}: at least one 'expect-test:' is required`)
  }
  if (!/^[A-Za-z0-9_-]+$/.test(headers['id'])) {
    throw new Error(`${path}: id must be [A-Za-z0-9_-]+, got '${headers['id']}'`)
  }
  if (headers['expect'] !== 'caught' && headers['expect'] !== 'uncaught') {
    throw new Error(`${path}: expect must be 'caught' or 'uncaught', got '${headers['expect']}'`)
  }
  if (headers['expect'] === 'uncaught' && (headers['todo'] === undefined || headers['todo'] === '')) {
    throw new Error(`${path}: 'expect: uncaught' requires a 'todo:' saying what is missing`)
  }
  if (edits.length === 0) throw new Error(`${path}: no edits`)

  return {
    path,
    id: headers['id'],
    title: headers['title'],
    expect: headers['expect'],
    expectTests,
    todo: headers['todo'] ?? '',
    proves,
    edits,
  }
}

/**
 * Apply every edit to `root`, asserting each one landed.
 *
 * The assertion is the point of this function. A mutation that silently fails to apply
 * leaves the mirror unmutated, the suite green, and the gate reporting the guard as
 * uncontrolled — or, for an `expect: uncaught` entry, reporting a known gap that was
 * never actually exercised. Both are lies, so a non-applying edit throws.
 */
export function applyMutation(mutation, root) {
  const applied = []
  for (const edit of mutation.edits) {
    const full = safeJoin(root, edit.file)

    if (edit.kind === 'create') {
      if (existsSync(full)) {
        throw new Error(`${mutation.id}: new-file '${edit.file}' already exists in the mirror`)
      }
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, edit.content.endsWith('\n') ? edit.content : edit.content + '\n', 'utf8')
      const back = readFileSync(full, 'utf8')
      if (!back.startsWith(edit.content)) {
        throw new Error(`${mutation.id}: created '${edit.file}' does not read back as written`)
      }
      applied.push(`create ${edit.file} (${String(edit.content.length)} bytes)`)
      continue
    }

    if (!existsSync(full)) {
      throw new Error(`${mutation.id}: target '${edit.file}' does not exist in the mirror`)
    }
    const before = readFileSync(full, 'utf8')
    const found = countOccurrences(before, edit.find)
    if (found !== edit.count) {
      throw new Error(
        `${mutation.id}: STALE MUTATION. '${edit.file}' contains the FIND text ` +
          `${String(found)} time(s), the mutation requires exactly ${String(edit.count)}. ` +
          'The code it targets has changed; update the mutation before trusting the gate.\n' +
          `--- FIND ---\n${edit.find}\n------------`,
      )
    }
    const after = replaceAllLiteral(before, edit.find, edit.replace)
    if (after === before) {
      throw new Error(`${mutation.id}: FIND and REPLACE are identical in '${edit.file}'`)
    }
    writeFileSync(full, after, 'utf8')

    // Read back from disk rather than trusting the in-memory string: a failed write, a
    // read-only mirror or a path that resolved somewhere else all look fine until here.
    const verify = readFileSync(full, 'utf8')
    const nowReplace = countOccurrences(verify, edit.replace)
    if (nowReplace < edit.count) {
      throw new Error(
        `${mutation.id}: REPLACE text is present ${String(nowReplace)} time(s) in ` +
          `'${edit.file}' after writing, expected at least ${String(edit.count)}`,
      )
    }
    if (!edit.replace.includes(edit.find) && countOccurrences(verify, edit.find) !== 0) {
      throw new Error(`${mutation.id}: FIND text survives in '${edit.file}' after writing`)
    }
    applied.push(`edit ${edit.file} (${String(edit.count)} site(s))`)
  }
  return applied
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function main(argv) {
  const [command, ...rest] = argv
  if (command === 'field') {
    const [file, field] = rest
    const m = parseMutation(file)
    const table = {
      id: m.id,
      title: m.title,
      expect: m.expect,
      // One per line: the gate reads them with `while read` and passes each as its own
      // argument to vitest-summary.mjs, so a test title containing spaces stays intact.
      'expect-test': m.expectTests.join('\n'),
      todo: m.todo,
      files: m.edits.map((e) => e.file).join(' '),
    }
    const value = table[field]
    if (value === undefined) throw new Error(`unknown field '${String(field)}'`)
    process.stdout.write(value + '\n')
    return
  }
  if (command === 'apply') {
    const [file, root] = rest
    const m = parseMutation(file)
    const applied = applyMutation(m, root)
    for (const line of applied) process.stdout.write('  applied: ' + line + '\n')
    return
  }
  if (command === 'validate') {
    for (const file of rest) {
      const m = parseMutation(file)
      // The byte counts are not decoration. A parser that silently truncates a block
      // produces a mutation that applies and does the wrong thing, which the gate then
      // reports as a misattributed catch. Printing the sizes makes a truncated block
      // visible here, before fifteen minutes of suite runs.
      const shape = m.edits
        .map((e) =>
          e.kind === 'create'
            ? `create ${e.file} ${String(e.content.length)}B`
            : `${e.file} find=${String(e.find.length)}B replace=${String(e.replace.length)}B x${String(e.count)}`,
        )
        .join('; ')
      process.stdout.write(`  ok ${m.id}\t${m.expect}\t${m.title}\n       ${shape}\n`)
    }
    return
  }
  throw new Error('usage: mutation.mjs <field|apply|validate> ...')
}

// Run the CLI only when this file IS the entry point. lib/selftest.mjs imports
// parseMutation/applyMutation from here, and an unconditional main() would fire on that
// import with the selftest's own argv and abort it.
//
// Exit code 2 is reserved for "the mutation definition or its application is broken",
// which the gate treats as a hard failure and never as evidence about a guard.
const entry = process.argv[1]
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write('mutation.mjs: ' + (error instanceof Error ? error.message : String(error)) + '\n')
    process.exit(2)
  }
}
