# ADR-0017 — One smoke assertion per transport, and a register of what the suite does not traverse

* **Status:** Accepted, implemented (`scripts/verify-rest-exposure.sh`, `docs/transport-blind-spots.md`, the out-of-band block in `scripts/gates.sh`)
* **Date:** 2026-10-23
* **Supersedes:** nothing. **Amends:** ADR-0009 (no gate without a positive control) by naming a class of gate it did not reach; ADR-0016, whose HTTP probe this generalises and extends from one function to three.
* **Requirements touched:** FR-04, FR-05, FR-12 (reachability of the write path); NFR-01, NFR-02.
* **New namespace:** `TBS-nn`, owned by `docs/transport-blind-spots.md` (canon §12).

## Context

ADR-0016 fixed a specific defect: schema `app` was not in PostgREST's exposed-schema list,
so the lifecycle write path was unreachable from the browser and the product had no working
submit button. It also recorded, in one sentence, the thing that should have been alarming:

> **Nothing in the repository could see this**: the integration suite connects to PostgreSQL
> directly and never crosses PostgREST, so 121 tests and a green mutation gate coexisted with
> a dead write path.

By the time the defect was found the count was 133 tests and a 30-mutation gate with zero
escapes. ADR-0016 closed the hole and added `app.verify_rest_exposure()` plus an HTTP probe.
What it did **not** do is treat the blindness itself as a defect with its own remedy, so the
remedy it did produce covered one setting and one function.

**The generalisation is the decision this ADR records.** A suite's blind spot is exactly the
set of components it does not traverse. A suite that connects by a privileged, direct or
in-process channel — this one does, for the entirely good reason that `gates.sh` must run
offline with no credentials — has chosen a different path than the user takes. Everything on
the production path and not on the test path is invisible, and **its absence is
indistinguishable from its correctness.** No coverage percentage can show it, because the
uncovered component has no lines in this repository.

The failure mode is worse than a gap, because the knowledge existed. `src/lib/supabase/client.ts`
carried a comment stating the schema had to be exposed, marked `UNVERIFIED`, written by a task
forbidden from contacting the project. **Nothing executable depended on it.** Prose is not a
control; ADR-0009 already says a control nothing can observe has already failed, and a
requirement recorded only in a comment is the same defect one layer up.

## Decision

Three parts. The first alone decays, the second alone is unenforced, and the third is what
keeps the first two from quietly disappearing.

### 1. One smoke assertion per transport, on the real path, graded on the exact expected answer

For any transport or gateway between a client and the thing under test, at least one
assertion must cross it. It does not need to be broad — one request, compared against an
explicit expected code, turns "unreachable" from invisible into loud.

`scripts/verify-rest-exposure.sh` is extended from one entry point to **all three**
(`app.submit_decision`, `app.append_revision`, `app.stamp_milestone`), because the properties
in play are per function, not per schema: PostgREST resolves an RPC by schema, then name,
then by matching posted JSON keys against its own cache, and the `EXECUTE` grant is three
separate `GRANT` lines that every migration's `revoke execute on all functions in schema app`
strips. Probing one function certifies that one function.

**That is measured, not argued.** With one argument key renamed, two functions reported
healthy and the third returned `PGRST202` in the same run. One green function is not evidence
about its siblings.

Grading is on the specific expected code and nothing else:

| leg | call | expected | what the answer proves |
|---|---|---|---|
| 1, anon | each of the three | `42501` | the schema is served, this function's cached signature matches the keys the client sends, and the anonymous role is refused at the schema boundary before any policy or body |
| 2, authed | `submit_decision` | `ST010` | the body ran: the draft lookup matched nothing |
| 2, authed | `append_revision` | `ST011` | the body ran: the submitted-decision lookup matched nothing |
| 2, authed | `stamp_milestone` | `ST005` | the body ran: the row-count assertion fired |

Anything else — including an answer the script has no case for — exits non-zero. **"Not the
error I was looking for" is forbidden as a pass condition**, because that is a restatement of
the original defect: a check that accepts any unrecognised response has the same blind spot as
a check that was never written.

### 2. A positive control per probe, with its measurement recorded next to the check

ADR-0009's rule applies here and is strengthened in one respect: the control runs **per
function, before that function is graded**, and if it fails the script refuses to grade the
real request at all rather than falling back to reporting on a probe it has just shown it
cannot trust.

Five runs on 2026-10-23 — A to C against the live project, D on the control's own logic —
recorded in the script header so the next reader does not have to take the teeth on faith:

| run | what was changed | result | exit |
|---|---|---|---|
| 0 | nothing | `PGRST106` control ×3, then `42501` ×3; leg 2 NOT RUN | **0** |
| A | graded probe pointed at `auth` — a schema that **exists** on the project but is not exposed | `PGRST106` → "THE EXPOSURE IS MISSING" | **1** |
| B | the control pointed at `app`, which **is** exposed, so the control can no longer detect the fault | `42501` ≠ `PGRST106` → "CONTROL FAILED", nothing graded | **1** |
| C | one argument key renamed | two healthy, one `PGRST202` → "NOT RESOLVED" | **1** |
| D | leg 2's grading-table control, extracted and run against a sound table and a broken one | three distinct codes OK; two functions sharing one code → "CONTROL 2 FAILED" | **0** / **1** |

Run A is deliberately a real-but-unexposed schema rather than a nonexistent one: it
distinguishes "not served" from "not there", which is the distinction the defect turned on.

**One of these controls was written wrong first, and the error is recorded rather than
quietly fixed**, because it is the same error this ADR exists to prevent. Leg 2's mutual
control originally compared `submit_decision`'s answer with `append_revision`'s *after*
grading both and asserted they differed. That assertion **could never fail**: the loop above
it already exits non-zero unless each function returns its own code, so by the time the
comparison ran the two answers were necessarily `ST010` and `ST011`. It was a gate that
exercised nothing — one of the 56 ADR-0009 was written about — produced while implementing
the rule against them, and caught by reading rather than by running.

The replacement checks the one claim the loop cannot: that the grading **table** still offers
three distinct codes for three functions. If it ever did not, a misdirected route sending two
calls to one body would grade as healthy. It runs before any request is made, and run D shows
it failing.

**The general lesson, which belongs in the register's rules:** an assertion placed after a
stricter check that subsumes it cannot fail. A control must be positioned where the thing it
doubts is still possible.

### 3. A register of the untraversed components, owned by one file

`docs/transport-blind-spots.md` lists, with a `TBS-nn` id each, every component on the
production path that the gate suite does not reach: the exposed-schema list, the per-function
schema cache, the `EXECUTE` grant as the gateway exercises it, the JWT-to-role mapping, TLS,
the published GitHub Pages bundle, the Supabase Auth endpoints, and the browser runtime.

**The register is the durable artefact; the check is its first entry.** A test closes one row.
A register makes the remaining rows reviewable, and makes a *new* transport's blind spot
visible the day it is introduced rather than the day it breaks. Statuses are design statuses
(`COVERED`, `OPEN`, `ACCEPTED`) — per canon §9, `PASS`/`FAIL`/`NOT RUN` are execution outcomes
and are not representable in a committed document.

Four rows are `OPEN` with no instrument at all. That is the honest state and is recorded as
such: three of the eight components have never been crossed by anything in this repository,
and leg 2 of the probe — the only thing that would prove a *signed-in* user can execute the
RPCs — **has never been executed**, because no probe credential exists on this machine.

## Alternatives considered

### (a) Add the live check to `scripts/gates.sh` as an eighth gate — rejected

This is the obvious move and it is wrong twice over. `gates.sh` treats NOT RUN as a failure
(canon §8.6, correctly), and it must pass with no credentials and no network — that property
is what makes it runnable at all, in a fresh clone and on a bare runner. An eighth gate would
be permanently red offline, and a permanently red gate is not a signal; it is a thing people
learn to ignore and then delete.

Instead the summary prints the live-only checks **out of band**, as NOT RUN, on every run,
touching neither the counters nor the exit status. That keeps the absence visible without
making it a verdict. The precedent is `pages.yml`, which already prints the two gates it
cannot run as NOT RUN in its job summary (`docs/deployment.md` §7), and ADR-0016, which put
`verify-rest-exposure.sh` and `npx supabase db push` outside the gate run for exactly this
reason.

### (b) Mock PostgREST, or run it locally in the emulation — rejected

A mock reproduces the author's model of the gateway, which is the model that produced the
blind spot. The defect here was a value in the *project's* configuration; a local PostgREST
would be configured by the same hand that wrote the test and would have been configured
correctly. This is the V1/V34 mistake in a new costume — a stand-in under test, passing
vacuously — and this project has already made it twice.

Running the genuine platform stack locally is also unavailable: ADR-0001 records that there
is no container runtime on this machine.

### (c) Assert the setting from SQL — already done, and already known to be insufficient

`app.verify_rest_exposure()` rule E1 does exactly this. ADR-0016 states its limit plainly:
it reads `pg_roles.rolconfig`, which is the recorded intent, and would keep passing if the
platform's own copy took precedence. It is record-keeping handed to an instrument that cannot
see the thing it is about. That is why there is an HTTP probe at all.

### (d) Rely on the manual browser check that found the bug — rejected

A person signing in and submitting a decision found this defect and is excellent evidence
that the path worked once, on one day. It is not a check. It does not run, it does not fail,
and nobody is notified when it stops being true. Recorded as such in `TBS-08`.

## Consequences

### Accepted cost 1 — leg 2 is written and has never run

The three authenticated expected codes are read from the function bodies in
`20261023080000_audit_event.sql`. **A reading is not a round trip**, and this project's
standing rule is that the two are not interchangeable. Leg 2 reports NOT RUN, is never counted
as a pass, and must not be described as working until someone executes it with
`STATESMAN_PROBE_EMAIL` / `STATESMAN_PROBE_PASSWORD`. `TBS-04` carries this as `OPEN`.

Creating the account or setting the password is the owner's action, not a script's.

### Accepted cost 2 — three blind spots remain uninstrumented

`TBS-06` (the published bundle), `TBS-07` (the Auth endpoints) and `TBS-08` (the browser
runtime) have no check. They are named rather than closed. Naming them is the point of the
register: before this ADR they were not gaps, they were nothing at all, and a green run was
read as covering the system.

### Accepted cost 3 — the probe writes nothing, and that limits what it can prove

Every call targets an all-zeros decision id with a random idempotency token, so each function
raises before its `INSERT` (or, for `stamp_milestone`, updates zero rows and rolls back). The
probe therefore proves the path is *reachable and the bodies execute*; it does not prove a
successful write. Proving a write means writing, and this runs against the live project with
the owner's real journal in it. The reachability claim is the one that was false for a day;
the successful-write claim belongs to the integration suite, which can roll back.

### Not changed

`app.verify_security_posture()` (ST099) and `app.verify_rest_exposure()` (ST097) are
untouched, as is `migrate.sh`. No migration is added: this ADR changes no database object.
`gates.sh` gains 31 lines and loses none; its step list, counters and exit status are
identical.

## Evidence

- Run 0, A, B, C above: `scripts/verify-rest-exposure.sh` against project
  `onpkspfxfmjkqpomcsse`, 2026-10-23, recorded in the script's own header.
- V1/V34 (a privileged role under test makes isolation checks pass vacuously) — the reason
  alternative (b) is rejected.
- V2/V30 (`PUBLIC` receives `EXECUTE` by default; the revoke is repeated in every migration)
  — the reason the `EXECUTE` grant is a per-function property and `TBS-03` exists.
- ADR-0016's measurement that `notify pgrst, 'reload config'` alone leaves the schema admitted
  and its contents uncached — the reason `PGRST202` is a graded state and not an error branch.
- Canon §4 (no gate without a positive control; a test that cannot be made to fail has not
  been shown to work) and canon §9 (a committed status carries no run outcome).
- Observation 0483 in the skill-observation log states the general rule this ADR implements.
