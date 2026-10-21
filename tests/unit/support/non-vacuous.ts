/**
 * globalSetup for the UNIT suite: the anti-vacuous-pass control.
 *
 * THE DEFECT THIS EXISTS TO MAKE IMPOSSIBLE. `vitest.unit.config.ts` globs
 * `tests/unit/**` and `tests/smoke/**`. Before this directory existed the first
 * glob matched nothing, the second matched three toolchain assertions, and
 * `npm run test:unit` reported a green "unit gate" that could not fail for any
 * product reason. A gate that cannot fail is not a gate.
 *
 * Counting files is therefore part of the run, not a convention. Two legs, and
 * each one can go red:
 *
 *   1. `tests/unit/` holds at least one `*.test.ts`. Red if the directory is
 *      emptied of tests — and red a second way if the directory is deleted
 *      outright, because this file goes with it and Vitest then cannot resolve
 *      its own globalSetup. The control is inside the thing it guards on
 *      purpose: there is no arrangement in which the unit layer disappears and
 *      this check survives to pass.
 *
 *   2. `tests/smoke/` still holds at least one `*.test.ts`. The smoke file is a
 *      deliberate toolchain canary — Vitest 5.0.5 does not declare support for
 *      Node 25.5.0, so "does the runner execute anything at all on this
 *      runtime" is a real question with a real answer. It earns its place; it
 *      just must not BE the unit gate. Losing it silently would remove the one
 *      check that distinguishes "the product is fine" from "the runner is".
 *
 * `passWithNoTests` is deliberately NOT set in the unit config either, for the
 * same reason `vitest.integration.config.ts` says it is not set there.
 */
import { readdirSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const UNIT_DIR = resolve(HERE, '..')
const SMOKE_DIR = resolve(HERE, '..', '..', 'smoke')

const TEST_FILE = /\.test\.ts$/

/**
 * Every `*.test.ts` under `dir`, recursively.
 *
 * A missing directory returns the empty list rather than throwing, so leg 1 and
 * leg 2 fail with their own message — "there are no unit tests" rather than an
 * ENOENT from somewhere inside the harness.
 */
function testFilesUnder(dir: string): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...testFilesUnder(full))
    } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
      found.push(full)
    }
  }
  return found
}

/**
 * Abort the run, with the reason actually readable.
 *
 * MEASURED on this toolchain: when a `globalSetup` throws, Vitest 5.0.5 tries to
 * source-map the stack and Vite's printer dies first —
 * `TypeError: code.charCodeAt is not a function` at
 * `extractInlineSourceMap (vite/dist/node/module-runner.js)` — and the run then
 * reports only a "Startup Error" plus a misleading "No test files found". The
 * exit code is still 1, so the gate does fail, but the message that explains WHY
 * never reaches the operator. Both failure legs below were reproduced in exactly
 * that state before this wrapper existed.
 *
 * `console.error` does not go through the source-map printer, so the diagnosis is
 * written out BEFORE the throw. The throw stays: it is what makes the run fail.
 */
function abort(reason: string): never {
  const message = `UNIT SUITE ABORTED — ${reason}`
  console.error(`\n${message}\n`)
  throw new Error(message)
}

export function setup(): void {
  const unit = testFilesUnder(UNIT_DIR)
  const smoke = testFilesUnder(SMOKE_DIR)

  if (unit.length === 0) {
    abort(
      `no *.test.ts under ${UNIT_DIR}.\n` +
        '  The unit gate would then consist of the toolchain smoke file alone, which ' +
        'cannot fail for any product reason. An unexecuted check is NOT RUN, never ' +
        'PASSED (canon §8.6).',
    )
  }

  if (smoke.length === 0) {
    abort(
      `no *.test.ts under ${SMOKE_DIR}.\n` +
        '  The toolchain canary is gone. Vitest 5.0.5 does not declare support for ' +
        `Node ${process.version}, so without it a runner-level failure and a product ` +
        'failure are no longer distinguishable.',
    )
  }

  console.log(
    `[unit] ${String(unit.length)} unit test file(s), ${String(smoke.length)} smoke file(s)`,
  )
}
