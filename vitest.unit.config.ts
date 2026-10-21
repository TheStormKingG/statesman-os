import { defineConfig } from 'vitest/config'

// Unit suite: pure logic only. Nothing here opens a database connection, so the
// whole file set runs in one process with no fixture, no template clone and no
// role guard.
//
// `globalSetup` is the anti-vacuous-pass control, not a fixture. `tests/unit/`
// did not exist when this config was written, so the first include glob matched
// nothing and the "unit gate" was three toolchain assertions in `tests/smoke/`
// that cannot fail for any product reason. `tests/unit/support/non-vacuous.ts`
// counts the files in both globs and aborts the run when either is empty — and
// it lives inside `tests/unit/`, so deleting that directory makes Vitest fail to
// resolve its own globalSetup rather than quietly falling back to smoke.
//
// `passWithNoTests` is deliberately NOT set, for the same reason
// `vitest.integration.config.ts` says it is not set there: a gate that reports
// success while executing nothing is the exact failure mode §8 exists to
// prevent.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/smoke/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/unit/support/non-vacuous.ts'],
    reporters: ['default'],
  },
})
