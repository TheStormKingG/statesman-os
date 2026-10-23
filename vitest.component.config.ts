import { defineConfig } from 'vitest/config'

// Component suite: the Desk's own state transitions, in a DOM, with the data
// layer mocked.
//
// WHY THIS SUITE EXISTS. On 2026-10-23 the Desk left every field editable and
// `Save draft` offered after a submission had succeeded. `frozen` is derived
// from the decision as it was LOADED, so it is still false in the gap between a
// successful submit and the next page load, and the database then refuses those
// saves as a frozen draft (ST003). Nothing in the repository could see it: the
// unit suite is pure logic, the integration suite speaks SQL, and
// `docs/transport-blind-spots.md` TBS-08 records the browser runtime as a blind
// spot with no instrument at all. The defect was found by hand, by signing in.
//
// This is that instrument, for the half of TBS-08 that needs no network: the
// screen's own handler and the state it derives. It does NOT close TBS-08 —
// there is no real browser here and `supabase-js` is mocked, so the claim that
// the product serialises the call the way the HTTP probes do remains an
// assumption. ADR-0018 states the boundary.
//
// `environment: 'jsdom'` is why this cannot simply join the integration suite:
// that config is `environment: 'node'` with `isolate: false`, so the files share
// one process and one environment. That is also why no registered mutation can
// catch these tests yet — the mutation gate runs the integration config alone.
// ADR-0018 records it as a known gap, with the positive control taken by
// measurement in the meantime.
//
// `passWithNoTests` is deliberately NOT set, for the same reason the unit and
// integration configs say it is not set there.
export default defineConfig({
  test: {
    include: ['tests/component/**/*.test.tsx'],
    environment: 'jsdom',
    globalSetup: ['tests/component/support/non-vacuous.ts'],
    setupFiles: ['tests/component/support/setup.ts'],
    reporters: ['default'],
    // `src/lib/supabase/client.ts` throws a ConfigurationError at MODULE LOAD
    // when either value is absent, and it is imported transitively by the
    // component under test. Both are publishable by design (ADR-0015): the
    // bundle ships them to every browser. These are placeholders, and every
    // call that would use them is mocked — a request reaching `.invalid` is a
    // bug in the mock, which is the behaviour wanted.
    env: {
      NEXT_PUBLIC_SUPABASE_URL: 'https://component-suite.invalid',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'component-suite-placeholder-not-a-credential',
    },
  },
})
