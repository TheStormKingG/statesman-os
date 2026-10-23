# ADR-0018 — A component-level instrument for the Desk's state transitions

**Status:** Accepted, implemented
**Date:** 2026-10-23
**Supersedes:** nothing. **Superseded by:** nothing.

## Context

On 2026-10-23 the Decision Desk left every field editable and `Save draft`
offered after a submission had already succeeded. `frozen` is derived from
`data.decision.submittedAt` — the decision as it was **loaded** — so it stays
false in the gap between a successful submit and the next page load. In that gap
the database refuses the saves as a frozen draft (ST003) while autosave reports
`Not saved. Your text is still here.`, which is text with nowhere to go.

The defect was found by signing in and using the product. Nothing in this
repository could have found it:

| layer | why it could not see this |
|---|---|
| unit (`tests/unit/`) | pure logic, `environment: 'node'`, no DOM |
| integration (`tests/integration/`) | speaks SQL over `pg`; never renders a component |
| mutation gate | runs the integration config, so it can only kill guards those tests reach |
| E2E | canon §8.7 lists "E2E + axe" in the CI order. `@playwright/test` is a devDependency with **no spec, no config and no npm script**. The step does not exist. |

`docs/transport-blind-spots.md` already records this class: **TBS-08**, the
browser runtime, status OPEN, remedy **None**. Its own wording is the argument
against closing this by hand: *"a manual run is evidence that it worked once,
not a check that it still does."*

Three options were available once the defect was fixed.

1. **Verify by hand on the live project.** Rejected. It needs a fresh draft, and
   the one published case already carries a submitted decision, so it needs a
   new `decision` row written to production data. More importantly it produces
   exactly the evidence TBS-08 says is insufficient — a second manual run.
2. **Add a "start another attempt" affordance** so a fresh draft can be created
   through the UI. Rejected as a *verification* strategy: it changes the product
   to make a test possible, and whether a case may be attempted twice is a
   product decision belonging to the PRD, not to this ADR. It may well be worth
   building on its own merits; that is a separate question.
3. **A component-level suite** that renders the screen in a DOM with the data
   layer mocked. Chosen.

## Decision

Add a third test layer: `vitest.component.config.ts`, `environment: 'jsdom'`,
globbing `tests/component/**/*.test.tsx`, wired into `scripts/gates.sh` as a
gate between `test:unit` and `test:integration`. `Desk` is exported from
`src/app/desk/page.tsx` as a declared test seam.

It runs offline with no credentials and no database, so it belongs inside the
gate suite, unlike `scripts/verify-rest-exposure.sh` (ADR-0016, ADR-0017) which
cannot.

### What this layer is for, and what it is not for

It asserts **state transitions a screen derives from its own props and local
state**. The first test pins the regression above: after a mocked-successful
`submitDecision`, every control is disabled and both buttons are withdrawn
**while the loaded decision is still an open draft**. That last clause is the
whole point — a test that re-fetched, or that asserted only "disabled after
submit", would pass against the defective version too, because the defective
version does lock, one reload later.

It is **not** a browser and **does not close TBS-08**. `supabase-js` is mocked,
so the claim that the product serialises a call the way the `curl` probes do
remains an assumption. TBS-08 keeps its OPEN status and now names what exists
and what is still missing.

## Positive control — measured, not asserted

Canon §4: a test that cannot be made to fail has not been shown to work.
Measured on 2026-10-23 by reintroducing the defect (`const locked = frozen`) and
running the suite from that state:

```
× locks every field and withdraws both controls the moment a submit succeeds, with no reload
  AssertionError: expected [ <textarea …(4)></textarea>, …(13) ] to have a length of +0 but got 14
✓ CONTROL: an open draft is editable, and both controls are offered
Tests  1 failed | 1 passed (2)
```

Fourteen fields stayed enabled, which is the original defect exactly. The
CONTROL test correctly still passed: an open draft is editable in both versions,
which is what makes it a control for the *second* test rather than a duplicate
of it. The source was then restored and the suite returns `2 passed`.

## Known gap, recorded rather than hidden

**No registered mutation can catch these tests yet**, so this gate's own teeth
are not provable the way every other gate's are. `scripts/mutation-check.sh`
runs `vitest run --config vitest.integration.config.ts` and nothing else. That
config is `environment: 'node'` with `isolate: false`, which is load-bearing for
its per-worker database model, so a jsdom project cannot simply join it: files
share one process and one environment.

Closing it means either teaching the harness to run two suites and merge two
JSON reports, or introducing a Vitest workspace so one command produces one
report. Both are changes to the harness that has just been hardened
(`negative-control: true`, the waiver counter, `assert-shipped`), so neither is
bundled in here. Until then the control above is a dated measurement, which is
the same standing the applier self-test's own control has in
`docs/mutation-testing.md`.

## Consequences

* `scripts/gates.sh` is **8 gates**, not 7. Every count in prose that says seven
  is stale from this commit.
* Three new devDependencies: `jsdom`, `@testing-library/react`,
  `@testing-library/dom`, pinned exactly, dev-only, `npm audit` clean at
  install. The §5 audit criterion blocks on high or critical in a **production**
  dependency, so dev-only advisories here would be recorded, not blocking.
* jsdom does not implement `HTMLDialogElement.showModal`/`close`, and `next/link`
  needs an app-router context. Both are shimmed in
  `tests/component/support/setup.ts`, which states that the shims are not a
  modal implementation and that no test asserts anything about modality.
* `src/lib/supabase/client.ts` throws at module load without `NEXT_PUBLIC_*`, so
  the config supplies placeholder values pointing at `.invalid`. Every call that
  would use them is mocked; a request actually reaching `.invalid` is a bug in a
  mock, which is the behaviour wanted.
