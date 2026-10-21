import { defineConfig } from 'vitest/config'

// Integration suite. One cloned database per worker PROCESS, so `isolate: false` is
// load-bearing rather than a performance tweak: with the default `isolate: true` the
// forks pool starts a fresh process per test file, VITEST_POOL_ID is reused by a
// different process, and the "per-worker" database would either be recreated per file
// or shared between files that believe they own it.
//
// `passWithNoTests` is deliberately NOT set. The suite currently contains no test files,
// so `npm run test:integration` exits non-zero until the first one lands. An integration
// gate that reports success while executing nothing is the exact failure mode §8 exists
// to prevent.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    isolate: false,
    maxWorkers: 4, // one cloned database per worker; bounds CREATE DATABASE cost
    globalSetup: ['tests/integration/support/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000, // the first worker may wait on a template build
    reporters: ['default'],
  },
})
