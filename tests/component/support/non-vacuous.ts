/**
 * globalSetup for the COMPONENT suite: the anti-vacuous-pass control.
 *
 * Same argument as `tests/unit/support/non-vacuous.ts`, which this mirrors
 * deliberately rather than abstracting: a gate whose file glob matches nothing
 * reports success while executing nothing, and `passWithNoTests` is not set in
 * any of the three configs for that reason. The control lives INSIDE the
 * directory it guards, so deleting `tests/component/` takes this file with it
 * and Vitest then cannot resolve its own globalSetup — there is no arrangement
 * in which the component layer disappears and this check survives to pass.
 *
 * One leg only, because this suite has no sibling canary: the unit config's
 * second leg guards `tests/smoke/`, which belongs to that gate.
 */
import { readdirSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMPONENT_DIR = resolve(HERE, '..')

const TEST_FILE = /\.test\.tsx$/

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
 * Written out before the throw for the reason the unit control records: a
 * throwing `globalSetup` is reported by Vitest 5.0.5 as a bare "Startup Error"
 * plus a misleading "No test files found", because Vite's source-map printer
 * dies first. The exit code is still 1, so the gate fails either way; this is
 * what makes the reason reach the operator.
 */
function abort(reason: string): never {
  const message = `COMPONENT SUITE ABORTED — ${reason}`
  console.error(`\n${message}\n`)
  throw new Error(message)
}

export function setup(): void {
  const found = testFilesUnder(COMPONENT_DIR)
  if (found.length === 0) {
    abort(
      `no *.test.tsx under ${COMPONENT_DIR}.\n` +
        '  The component gate would then be green while asserting nothing about any ' +
        'screen. An unexecuted check is NOT RUN, never PASSED (canon §8.6).',
    )
  }
  console.log(`[component] ${String(found.length)} component test file(s)`)
}
