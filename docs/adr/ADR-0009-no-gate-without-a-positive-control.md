# ADR-0009: Test doctrine — no gate without a positive control

**Status:** Accepted | **Date:** 2026-10-20

## Context

The adversarial pass over the design found **56 gates that would pass while exercising nothing**.
They were not sloppy tests; their assertions are satisfied by the absence of the thing they check.
Two executed facts explain the class:

- **V18** — an empty table with RLS and one with **no** RLS both return 0 to the app role, so a
  tenancy test over empty data passes identically whether or not RLS exists.
- **V19** — under RLS with no DELETE policy, a cross-user `DELETE` returns `DELETE 0` with **no
  error**, byte-identical to deleting a nonexistent id, so `rowCount === 0` is not evidence of
  denial.

## Decision

The governing rule:

> **A test that cannot be made to fail has not been shown to work.** Every denial assertion is
> paired with a positive control, and every instrument has a test in which it must report the
> negative.

Concretely:

- **Sentinels.** A migration seeds exactly one row per protected table owned by reserved UUID
  `00000000-0000-0000-0000-00000000dead`, committed into the template database. `assertAppRole`
  checks **both** directions on non-empty data: with no context every protected table returns 0;
  as the sentinel user each returns exactly 1. A table shipped without RLS now leaks its sentinel
  and the run dies.
- **Paired denials.** `A sees the row (1) → B sees 0 → B's write raises nothing → A still sees
  1`, plus, inside a rolled-back transaction, **drop the policy** and assert the row becomes
  visible.
- **Instrument tests, harness-fatal.** `waitUntilBlocked` must return `false` when two sessions
  lock different rows; the revision-number read helper run sequentially must produce **different**
  values.
- **An accessibility canary.** A `/__a11y-canary` route, mounted only under `E2E_FAULTS=1`,
  carrying a known serious axe violation and a 400px fixed block; the axe gate and the 320px
  overflow detector must **fail** on it.
- **Focus as a difference.** Focus indication is asserted as a difference between focused and
  blurred computed styles plus a ≥3:1 contrast ratio.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Assert `rowCount === 0` for denial | V19: identical to deleting a nonexistent id. Proves nothing about the policy. |
| Tenancy tests over empty tables | V18: passes with or without RLS. |
| Lock-wait detection as the race negative control | V23: an unguarded read-then-write **never blocks** — the follower inserted and committed while the leader's transaction was open, and no Lock wait ever appeared. V24: a non-privileged observer of `pg_stat_activity` sees `state` and `wait_event_type` as NULL, so "cannot observe" is reported as "never blocked". Replaced by an application rendezvous plus an `xact_start` overlap assertion and a positive observability assertion. |
| Presence check on `outlineStyle` for focus | Can never fail: UA stylesheets give `:focus-visible` elements `outline-style: auto` regardless of the author's CSS. |
| `TRUNCATE` between tests | Forbidden by the immutability triggers, by design (ADR-0004, V15). Per-worker `CREATE DATABASE … TEMPLATE statesman_test_template`, dropped at teardown. |
| A hand-maintained migration list in the test path | A new migration is silently omitted from the tested schema. Lexical glob `migrations/0*.sql` instead. |
| Exit-code assertions in `gates:selftest` | Five fixtures asserting only `code === 2` let a checker that returns 0/2 pass seven of ten. Assert deep equality against an expected per-requirement object. |
| Seed test data as the owner or a superuser | Bypasses the INSERT policy whose absence the test should expose, and V1/V4 make the bypass invisible. Seeding goes through `withUser` as `statesman_app`. |

## Consequences

**Positive.** Each gate carries proof of its own liveness. A removed policy, a dropped trigger or
a mis-wired instrument fails the run instead of quietly becoming a no-op.

**Negative.** Roughly double the test volume on security boundaries, and three permanent
artefacts that look like defects: a sentinel row in every protected table, a deliberately broken
accessibility route, and a fault-injection environment variable. Export and deletion paths must
not treat the sentinel as user data. Sentinel seeding must bracket `NO FORCE`/`FORCE` (ADR-0003,
V8), because an owner-run insert under `FORCE` would otherwise do nothing — silently, which is the
failure this ADR exists to stop.

**What this now requires.** The sentinel migration; `assertAppRole` in both directions; the two
harness-fatal instrument tests; the canary route and the two gates that must fail on it; the
`gates:selftest` deep-equality fixtures; and the per-worker template clone.

**Status:** PLANNED / NOT RUN. No test has been executed, because no application code exists.
The 56 findings were made against the design, not against a suite.

## Evidence

- **V18** — empty tables return 0 with and without RLS; sentinels are required.
- **V19** — cross-user `DELETE` returns `DELETE 0` with no error; denials need paired positive controls and after-state reads.
- **V23** — an unguarded read-then-write never blocks; the race negative control cannot use lock-wait detection.
- **V24** — a non-privileged `pg_stat_activity` observer sees NULLs; "cannot observe" otherwise reads as "never blocked".
- **V15, V8** — why the harness cannot truncate, and why sentinel seeding must bracket `NO FORCE`/`FORCE`.
- **V20** — `pg_policies.qual` is NULL for INSERT-only policies, so a soundness query reading only `qual` flags every INSERT policy and aborts; posture rule 8 reads both columns.
