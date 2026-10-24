# ADR-0019 — CSRF origin verification is retired: its precondition was removed

**Status:** Accepted, implemented
**Date:** 2026-10-24
**Supersedes:** nothing. **Superseded by:** nothing.
**Relates to:** ADR-0015 (static export on GitHub Pages with Supabase), canon §12.1 item 1,
threat `T-46`, test case `TC-SEC-046`, residual `R-16`.

## Context

Canon §12.1 item 1 puts CSRF origin verification in P0 scope, "on every state-changing Server
Action and Route Handler", and states plainly that `SameSite=Lax` is not the control. It also
requires an ADR recording the mechanism. `docs/adr/RESERVED.md` reserved a number for exactly
that.

`docs/implementation-plan.md` task 6.11 implements it, in `src/server/http/**` and
`src/middleware.ts`, verified by `npm run e2e -- csrf`.

**Every clause of that task points at something that does not exist.** Measured on this tree at
commit `0c43f66`:

| The task presupposes | Observed |
|---|---|
| `src/server/http/**` | `ls src/server` → No such file or directory |
| `src/middleware.ts` | No such file or directory |
| Server Actions | `grep -rl 'use server' src/` → 0 files |
| Route Handlers | `find src -name 'route.ts' -o -name 'route.tsx' -o -name 'route.js'` → 0 |
| A static export that could still carry a server | `next.config.ts:107` → `output: 'export'` |
| An ambient session cookie | The only match for `cookie` in `src/` is prose at `src/app/page.tsx:405` saying there is none |
| `npm run e2e -- csrf` | No `e2e` script; no Playwright config anywhere |

The cause is ADR-0015. Moving to a static export talking to Supabase from the browser removed
the server request boundary that origin verification is defined against. The control did not
become hard to build; **its subject stopped existing.**

The threat as written is also stale in its mechanism. `T-46` describes "AC-02 induces AC-01's
browser to invoke a state-changing Server Action … using AC-01's **ambient cookie**", and adds
that "`SameSite=Lax` on the session cookie remains in place". There is no session cookie.
`docs/decisions.md` D1 still describes "own session-cookie authentication with a server-side
session table", which is the premise `T-46` was built on and which ADR-0015 reversed.

## Decision

**Retire origin verification as inapplicable, and enforce its precondition instead.**

Writes now leave the browser as `fetch` calls to PostgREST carrying
`Authorization: Bearer <access_token>`, where the token is read from `localStorage`
(`persistSession: true`, `src/lib/supabase/client.ts:393`) by the page's own JavaScript and
attached explicitly by `supabase-js`.

Classical CSRF requires a credential the browser attaches **ambiently** to a cross-origin
request. A bearer token read from `localStorage` is not such a credential: `localStorage` is
partitioned by origin, so an attacker's page cannot read it, and nothing causes it to be
attached to a request that page initiates. A cross-origin write without the token reaches
PostgREST unauthenticated, leaving `auth.uid()` NULL — which ADR-0015 lines 77-78 measured
against a Supabase-shaped target as **0 rows affected and no error**, the silent-denial
semantics the whole RLS model is built on.

So the attack `T-46` describes has no path, and the control it demands has nothing to attach to.

### A client-side origin check is rejected, not adopted as a consolation

The obvious half-measure is to re-home the wrapper in the browser and have it compare
`window.location.origin` before writing. This ADR rejects that explicitly, so nobody
re-derives it later as a partial win: **the only party who can bypass a check that runs in the
browser is the party who controls the browser**, which is the attacker in every threat this
control was for. It would add code, add a passing test, and reduce no risk — security theatre
with a green gate, which is worse than an honest absence because it ends the enquiry.

### What is traded for the retirement

A retirement is only honest if the precondition is **enforced**, because it is one file away
from false. A single `route.ts`, a `'use server'` directive or a `src/middleware.ts` would
reintroduce a request boundary, and the retired control would silently become necessary again
with nothing to say so.

`tests/unit/no-server-surface.test.ts` (scanner: `tests/unit/support/server-surface.ts`) fails
the unit gate if any of four things appears: a `'use server'` directive, a Route Handler under
`app/`, a `middleware.ts`, or a `next.config.ts` that does not pin `output: 'export'`. It runs
in `scripts/gates.sh` **and** in `pages.yml`, so it also guards the deploy path.

**The control was measured on the real target, not only on fixtures.** Planting
`src/app/api/route.ts` in this repository:

```
× finds no server surface anywhere in this repository
  AssertionError: expected [ Array(1) ] to strictly equal []
Tests  1 failed | 89 passed (90)
```

and after removing it, `90 passed`. The fixture leg separately proves the scanner detects each
of the four mechanisms **and attributes each to the right file with a stated reason** — a
control whose expected result is a failure is satisfied by every cause of that failure,
including the scanner having crashed or scanned nothing, so the verdict alone would not have
been evidence. A further test asserts that prose and comments naming `'use server'` do **not**
flag a file, because this repository's own plan and threat model discuss the directive by name
and a check that fired on prose would be loosened until it fired on nothing.

## The residuals, which are real and are a different shape

Retiring `T-46` must not retire its budget. Two risks survive, and neither was ever addressed
by origin verification:

1. **UI redress / clickjacking.** A framed page is a different attack from a forged request,
   and the control for it is `frame-ancestors` — **a response header, which this platform
   cannot emit at all.** GitHub Pages serves static files and sets no custom headers, and a
   `<meta http-equiv>` CSP explicitly ignores `frame-ancestors`. So this is not merely unbuilt,
   it is **unbuildable on the current deployment**, and it belongs in the gap register as an
   undischarged §8 obligation rather than inside a retired threat.
2. **Session fixation via `detectSessionInUrl: true`** (`src/lib/supabase/client.ts:398`).
   `supabase-js` reads a session out of the URL fragment on load. The attack is planting a
   fragment, not forging a request, so it needs its own threat row and its own control.

Both are recorded as their own **residual rows** — `R-23` (clickjacking) and `R-24`
(`detectSessionInUrl`) in `docs/threat-model.md` — rather than folded into `T-46`, whose
status becomes
`NOT_APPLICABLE` — not `PASS`, because nothing was verified, and not `DEFERRED`, because
nothing is waiting.

## Consequences

* **`requirements.yaml` gains a third design status.** Its declared
  `status_vocabulary: [PLANNED, DEFERRED]` cannot express "out of scope because the precondition
  was removed". `NOT_APPLICABLE` is added, and it is a design property of scope that is stable
  between runs — the test `status_is` already states — not a run outcome. `PASS`, `FAIL` and
  `NOT RUN` remain unrepresentable in committed documents (canon §9).
* **`TC-SEC-046` is re-pointed, never deleted.** `requirements.yaml` owns threat and test ids,
  and a deleted id means no tagged test can ever match it. It now names the replacement control,
  and `requirements-traceability.md` is re-rendered in the same commit so the two cannot diverge.
* **`RESERVED.md`'s reservation for this ADR was already broken.** It reserves **0015** for the
  CSRF mechanism, while `ADR-0015-static-github-pages-plus-supabase.md` occupies that number —
  the second collision that file carries. Per its own never-reuse rule the row is marked
  **abandoned** and points here, rather than being freed.
* **`docs/decisions.md` gains D15**, because retiring a P0 threat-model control is a departure
  from PRD and threat-model intent, which §8 requires be recorded rather than silently applied.
  D1 is flagged there as stale: the build no longer departs from the master prompt's Supabase
  Auth default, it returned to it.
* **`implementation-plan.md` task 6.11 is corrected at source**, since that document owns file
  layout: the `src/server/http/**` and `src/middleware.ts` paths are struck, and the stale
  reference to `scripts/check-import-boundary.ts` is corrected to the real
  `scripts/check-import-boundaries.ts`.
* **This does not close the §12.1 obligation to record a mechanism — it discharges it by
  recording that there is no mechanism to choose**, and why.
