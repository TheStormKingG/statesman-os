# STATESMAN OS — Implementation Plan

**Doc ID:** SOS-PLAN-001
**Date:** 2026-10-20
**Status:** Planned. **Nothing in this plan has been implemented.**
**Derived from:** `docs/superpowers/specs/2026-10-20-statesman-os-p0-mvp-design.md` (SOS-DESIGN-001, the canon), `docs/PRD.md` (SOS-PRD-001 v1.0), `docs/MASTER_PROMPT.md` §3.5 and §10.

> The canon is the single source of truth. Where this plan appears to disagree with it, the
> canon wins and this plan is the bug. Facts cited as `(V7)` are rows of the canon's verified
> facts register (§3) and are not re-derived here. Facts cited as `(E2)` were established by
> command while writing this plan and are listed in §1.2.

---

## 0. How to read this plan

### 0.1 Implementation status

| Item | Status |
|---|---|
| Application code | NOT STARTED — no `package.json`, `src/`, `app/` or `migrations/` exists (E1) |
| Database schema | NOT STARTED — no `statesman` database created by this plan |
| Tests | NOT WRITTEN — every test named below is a specification, not an artefact |
| CI | NOT CONFIGURED |
| Every gate in §11 | NOT RUN |

No statement in this document asserts that anything works, is secure, is tested or is
production-ready. Status vocabulary is **PLANNED**, **NOT RUN**, **DEFERRED**. There is no
PASS in this document, because nothing has been executed except the four checks in §1.2.

### 0.2 Task format

Every task carries:

- **Requirement** — the FR, NFR or invariant id the task delivers, where it delivers one. A task
  that names an id owns that id's acceptance condition, not merely a mechanism near it.
- **Files** — exact targets to create or edit. This plan **owns** migration filenames and the
  source and test file layout (canon §12); `docs/requirements.yaml`'s implementation paths are
  rewritten to match these, never the reverse.
- **Behaviour** — what must be true of the system afterwards.
- **RED** — the test file, and the specific assertion that must fail before the behaviour
  exists. A task whose RED test passes on first run has not been shown to test anything
  (canon §8). Where the task's assertion is a **denial**, the RED also names the positive
  control that must flip the outcome: an assertion that cannot be made to fail has not been
  shown to work, and absence is not denial.
- **Verify** — the exact command and its expected exit status.

### 0.3 Complexity scale

**S** / **M** / **L** / **XL** is relative implementation effort and risk only. It is not a
duration. This plan contains **no dates, no hours, no sprint allocations and no calendar
commitments**, per `MASTER_PROMPT.md` §3.5.

### 0.4 Exit-status conventions

| Tool | Pass | Fail |
|---|---|---|
| `vitest run` | 0 | non-zero (1 on assertion failure) |
| `playwright test` | 0 | non-zero |
| `tsc --noEmit` | 0 | non-zero |
| `eslint` | 0 | non-zero |
| `psql -v ON_ERROR_STOP=1` | 0 | 1 on SQL error, 2 on connection failure (E4) |
| custom scripts | 0 | non-zero; `gates:selftest` fixtures assert a deep-equal object, never a bare code (canon §8.6) |

### 0.5 Environment preconditions for every DB command

`export LC_ALL=en_US.UTF-8` — the postmaster aborts without it on this macOS build (V27), and
`brew services start postgresql@17` because the running server is not brew-managed and does
not survive a reboot (V26). Both belong in the README runbook (task 0.8).

---

## 1. Baseline

### 1.1 Repository state

There is **no application code**: no dependency manifest, no `src/`, no `app/`, no
`migrations/` and no CI configuration (E1). Slice 0 therefore creates the application baseline
rather than inspecting one.

The first-deliverable document set of `MASTER_PROMPT.md` §3 was authored in parallel with this
plan by agents that could not see each other's output. **This plan does not state which of those
documents exist.** Repository-state claims about sibling documents are owned by nobody
(canon §12), and the parallel-authoring arrangement is exactly what makes such a claim wrong by
the time it is read. The durable claim — that no application code exists — is above.

Every Slice 0 document task is therefore written to **reconcile and audit against the canon,
never to recreate**. A task whose artefact is already written reconciles it; a task whose
artefact is absent writes it. The task does not change, and neither does its RED assertion,
which tests content rather than existence.

No document in that set has been audited against the canon by this plan. Task 0.9 is that audit.
Until it has run, nothing downstream of Slice 0 may cite those documents as authority.

### 1.2 Checks executed while writing this plan

These are plan-time empirical checks, distinct from the canon's V-register. They were run on
2026-10-20 against this machine.

| # | Finding | Command |
|---|---|---|
| E1 | No application code exists in the repository: no dependency manifest, no `src/`, no `app/`, no `migrations/` | `ls -d src app package.json migrations` → all absent, on two separate checks |
| E2 | In a **BEFORE UPDATE** row trigger, `NEW.<stored generated column>` is **NULL** while `OLD.<same column>` is populated; in an **AFTER UPDATE** row trigger both are populated | `psql -d postgres -f` a rolled-back script creating a temp table with a `generated always as (…) stored` enum column plus `before update` and `after update` row triggers raising `NOTICE` with `OLD.state`/`NEW.state`; output: `BEFORE UPDATE: OLD.state=[draft] NEW.state=[<NULL>]`, `AFTER UPDATE: OLD.state=[draft] NEW.state=[submitted]` |
| E3 | A user-declared `IMMUTABLE` SQL function returning an enum via **per-branch** casts is accepted inside `GENERATED ALWAYS AS (…) STORED` on PostgreSQL 17.11 | same harness, `create function pg_temp.derive(...) returns … language sql immutable`, used as the generation expression; `CREATE TABLE` succeeded and the column computed `submitted` after an update |
| E4 | `psql` exit statuses on this install: 0 success, 1 SQL error under `ON_ERROR_STOP=1`, 2 connection failure | `psql -d postgres -v ON_ERROR_STOP=1 -c "select 1/0"; echo $?` → 1; `-c "select 1"` → 0; `-d no_such_db_xyz` → 2 |

**E2 and E3 reproduce canon V28 and V29 independently, on this cluster.** `NEW.<generated
column>` is NULL in a `BEFORE UPDATE` row trigger, so a transition trigger must never read
`NEW.state` (V28); and a user-declared `IMMUTABLE` SQL function **is** accepted both inside a
`GENERATED ALWAYS AS … STORED` expression and as the trigger's derivation of the prospective
state (V29). Canon §4.4 specifies exactly that design — one `IMMUTABLE`
`app.derive_decision_state()` used by **both** the generated column and the `BEFORE UPDATE`
guard — and task 3.2 implements it with the all-32-combination meta-test §4.4 requires. Two
instruments agree; this plan raises no disagreement with the canon here.

### 1.3 Scope held constant

In scope: the five P0 component groups of canon §1.1. Deferred: canon §1.2 P1+ list.
Prohibited and never implemented: the canon §1.2 prohibition list — in particular any
composite readiness/character/viability score, and any AI-awarded maturity level 3 or 4.

---

## 2. Slice 0 — Discovery, guardrails and baseline

**Goal:** Reconcile and audit the first-deliverable document set against the canon, and stand up
a pinned, runnable toolchain whose gate commands all exist and all exit 0 on an empty
application. Every gate in §11 must be able to **pass from the end of this slice**: a blocking
gate that is unpassable until a later slice is the same defect shape as a committed generation
timestamp, and is not accepted here.

**Dependencies:** none.

### Tasks

#### 0.1 Scaffold the application and pin versions

- **Files:** `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.ts`,
  `postcss.config.mjs`, `tailwind.config.ts`, `eslint.config.mjs`, `.prettierrc`,
  `vitest.config.ts`, `playwright.config.ts`, `src/app/layout.tsx`, `src/app/page.tsx`,
  `.gitignore` (add `reports/`, `.env*`).
- **Behaviour:** Next.js App Router + React + TypeScript with `"strict": true` and
  `noUncheckedIndexedAccess`. Installed with **npm 11.8.0** on **Node v25.5.0** (canon §2).
  Every dependency pinned to an exact version in `package.json` — no ranges (O3). Record the
  resolved versions in a **pinned-toolchain ADR** by reading them back from the lockfile, never
  from memory (O4).
  **ADR numbers are owned by `docs/adr/README.md`** (canon §12) and this plan allocates none.
  The allocation is a rule, not a fixed number: take the next free number after the highest that
  README has allocated, and enter it in `docs/adr/RESERVED.md` **at the moment it is first
  cited**, so `docs:check` can resolve the reference before the ADR itself is written (task 0.3).
  Where this plan names `ADR-0013` (this task's pinned toolchain) or `ADR-0012` (session
  resolution, task 6.4) it is citing a reserved entry, not claiming the number. If the owner
  allocates different numbers, the owner wins and this plan is the bug.
- **RED:** `tests/unit/baseline/tsconfig.test.ts` — asserts
  `compilerOptions.strict === true` and `compilerOptions.noUncheckedIndexedAccess === true`
  read from `tsconfig.json`. Fails with ENOENT before the file exists.
- **Verify:** `npm run typecheck && npm run lint && npm run build` → exit 0.

#### 0.2 Declare every gate script up front

- **Files:** `package.json` (`scripts`), `scripts/` stubs.
- **Behaviour:** All scripts in §11 exist from Slice 0 onward. A script whose slice has not
  arrived exits **non-zero with an explicit "not implemented in this slice" message** — never
  0. A gate that exits 0 because it does nothing is the failure mode canon §8 exists to stop.
- **RED:** `tests/unit/baseline/scripts.test.ts` — asserts the script-name set in
  `package.json` equals the committed expected list exactly (deep equality, not subset).
- **Verify:** `npm run -s gates:list` → exit 0 and prints the same set.

#### 0.3 Architecture decision records

- **Files:** `docs/adr/*`, `docs/adr/README.md`, `docs/adr/RESERVED.md`, `docs/decisions.md`.
- **Behaviour:** Reconcile and audit — **do not recreate an ADR that is already written.** Four
  things:
  1. **The canon's ADR citations resolve to documents that say what the canon says they say.**
     Canon §2 cites ADR-0001 for local Postgres; canon §10 cites ADR-0003 for keeping `FORCE`;
     canon §6 cites **ADR-0002** for the argon2id parameters, with the pinned values
     `memoryCost = 19456` KiB, `timeCost = 2`, `parallelism = 1`, 16-byte salt, 32-byte output.
     Check each citation against the document it names. Any divergence goes in
     `docs/canon-audit.md` (task 0.9), and the canon wins.
  2. **`docs/adr/RESERVED.md`.** Every ADR number cited anywhere in `docs/` that is not yet a
     written ADR must appear in this committed reserved-numbers list with the citing task and a
     one-line subject. This is what makes `docs:check` passable from the end of Slice 0 while
     ADRs that later slices write — the session-resolution ADR of task 6.4, the CSRF-mechanism
     ADR of task 6.11 — are still unwritten. The list is maintained by `docs/adr/README.md`,
     which owns the number namespace (canon §12).
  3. **`docs/decisions.md`.** `MASTER_PROMPT.md` §0.2 requires conflicts with PRD intent and
     departures from the prompt's own §4 defaults to be **recorded rather than silently
     applied**. The file must index at least: Supabase Auth + RLS replaced by own session-cookie
     auth; managed Postgres replaced by local Homebrew Postgres; one persistence strategy with
     hand-written SQL migrations and no ORM; the **NFR-06** deferral; the **NFR-07** deferral
     (§11, and canon §12.2); the **coverage-threshold** resolution; and the **dependency-audit
     threshold**. Each entry resolves to the ADR or the canon section that carries it.
  4. **No ADR and no decision entry may claim review, approval or sign-off by anyone**, because
     none has occurred.
- **RED (two):**
  1. `tests/unit/docs/adr.test.ts` — asserts every ADR number referenced anywhere in `docs/`
     either resolves to a file in `docs/adr/` **or** appears in `docs/adr/RESERVED.md`, and that
     each written ADR contains a `## Decision` and an `## Alternatives considered` heading. The
     RED condition is this plan's own citations: the session-resolution and CSRF ADR references
     resolve to neither a file nor a reserved entry until `RESERVED.md` lists them, so the
     assertion fails until item 2 is done. Its positive control adds a reference to an
     unallocated ADR number in a scratch copy of `docs/` and asserts the checker reports it.
  2. `tests/unit/docs/decisions.test.ts` — asserts `docs/decisions.md` names every
     `MASTER_PROMPT.md` §4 default this build replaced and resolves each to an ADR or a canon
     section, and that it carries an entry for each of NFR-06, NFR-07, the coverage threshold
     and the dependency-audit threshold. Its positive control deletes one entry from a scratch
     copy and asserts the checker reports the gap.
- **Verify:** `npm run docs:check` → exit 0.

#### 0.4 `docs/architecture.md`

- **Files:** `docs/architecture.md`.
- **Behaviour:** Reconcile and audit against the canon — **do not rewrite.** Verify it carries,
  and add what it does not: context, component and trust-boundary diagrams (Mermaid), the
  `withUser` runtime flow in the seven ordered steps of canon §6.1, the three-role database
  topology of canon §4.1, the deployment and backup model (dump as the bootstrap superuser,
  V10), and the provider-agnostic AI adapter seam. Trust-boundary ids are **adopted verbatim
  from `docs/threat-model.md`**, which owns the `TB-1..TB-9` namespace (canon §12); architecture
  defines no competing set. It states O1 (no encryption-at-rest mechanism) as an open release
  item in the deployment section rather than implying NFR-02 is met, and it **links** requirement
  design status rather than restating it (canon §12: status is owned by `requirements.yaml`).
- **RED:** `tests/unit/docs/architecture.test.ts` — asserts the file names all three database
  roles, all seven `withUser` steps **in order**, and the string `O1`; and asserts it contains no
  `PLANNED`/`DEFERRED` status token against a requirement id, which belongs to
  `requirements.yaml`. The step-order assertion is the RED: it fails against any prose that
  names the steps without the eager-validation call in position 4.
- **Verify:** `npm run docs:check` → exit 0.

#### 0.5 `docs/threat-model.md`

- **Files:** `docs/threat-model.md`.
- **Behaviour:** Reconcile and audit against the canon — **do not rewrite.** Assets, actors,
  trust boundaries, threats, mitigations, residual risk and the test case that covers each. Must
  include the `MASTER_PROMPT.md` §8 attack list (IDOR, direct API access, CSRF/session misuse,
  injection, stored XSS through journal fields and model output, prompt injection through
  scenario/source text, leaked secrets, excessive model data sharing, privilege escalation,
  deletion gaps, accidental public exposure), the worked prompt-injection example and the
  stopping layer required by canon §7.4, and the residual-risk rows for O1 and the deliberate
  cuts in canon §6 (no pepper, no lockout, no circuit breaker).
  This document **owns** the trust-boundary ids `TB-1..TB-9`, the threat ids `T-nn` and the
  test-case ids `TC-SEC-nnn` (canon §12). Two consequences are reconciled here: every other
  document adopts its numbering verbatim, and every `T-nn` and `TC-SEC-nnn` must be registered
  in `docs/requirements.yaml` under its `threats:` key — an unregistered id can never be matched
  by a tagged test, so the coverage claim for it is unfalsifiable.
  The four controls canon §12.1 lifts out of `UNDESIGNED` — CSRF origin verification, log and
  telemetry redaction, stored-XSS rendering plus CSP, and NFR-10 source status and archival — are
  **in scope for P0** and are delivered by tasks 6.11, 6.12, 6.6 and 6.13. The threat model's
  rows for them must name those tasks and their test cases instead of reading `UNDESIGNED`.
- **RED:** `tests/unit/docs/threat-model.test.ts` — asserts every threat id in the file has a
  non-empty test-case cell, that every `T-nn` and `TC-SEC-nnn` it defines is present in
  `docs/requirements.yaml`, and that no row for the four canon §12.1 controls reads `UNDESIGNED`.
  The registration assertion is the RED: it fails while the ids live only in the threat model.
- **Verify:** `npm run docs:check` → exit 0.

#### 0.6 Requirements register and traceability document

- **Files:** `docs/requirements.yaml`, `docs/requirements-traceability.md`.
- **Behaviour:** Reconcile and audit against the canon — **do not rewrite.** The register lives
  under `docs/`, so every script and reporter resolves `docs/requirements.yaml`, never a
  repo-root path.
  `docs/requirements.yaml` **owns** requirement ids, invariant ids `INV-nn` and instrument ids
  `INS-nn` (canon §12) — **FR-01..FR-19** and **NFR-01..NFR-10**, spelled exactly as in
  `docs/PRD.md` §6 and §11, in the PRD's own US spelling — with priority, PRD reference,
  acceptance condition, verification method, intended implementation paths and the identities of
  the covering tests. It also carries the `threats:` key registering the threat-model's `T-nn`
  and `TC-SEC-nnn` ids (task 0.5).
  `docs/requirements-traceability.md` is a **deterministic render** of it: no timestamps, no
  counts typed by hand, and divergence between the two — including in punctuation and spelling —
  is a `trace:check` failure. Per canon §8.6 as amended, that document **may** carry a *design*
  status from the closed vocabulary `{PLANNED, DEFERRED}`, because scope is stable between runs
  and `MASTER_PROMPT.md` §3 item 2 asks for it. It may **not** carry a *run* status: `PASS`,
  `FAIL` and `NOT RUN` are outcomes of an execution and are not representable in that file at
  all. They live in the volatile `reports/trace.json` + `reports/traceability-run.md`
  (gitignored, task 6.7).
  **This plan owns migration filenames and the source/test file layout** (canon §12). The
  register's `implementation_paths` are rewritten to match the paths named in this document,
  never the reverse, and a path named in the register that no task in this plan creates is a
  defect.
- **RED (two):**
  1. `tests/unit/docs/requirements.test.ts` — asserts the id set parsed from
     `docs/requirements.yaml` deep-equals the 29 expected ids; that each appears in
     `docs/requirements-traceability.md`; and that the committed document contains **no** `PASS`,
     `FAIL` or `NOT RUN` token (canon §8.6 as amended). The run-status assertion is the RED: it
     fails against any register render that carries per-run outcomes.
  2. `tests/unit/docs/paths-resolve.test.ts` — extracts every `implementation_paths` entry from
     `docs/requirements.yaml` and asserts each one is named in a **Files** line of
     `docs/implementation-plan.md`. Its positive control adds a path no task creates and asserts
     the checker reports it. This is the mechanism for canon §12's rule that an uncreated
     registered path is a defect.
- **Verify:** `npm run docs:check` → exit 0.

#### 0.7 `CLAUDE.md`

- **Files:** `CLAUDE.md`.
- **Behaviour:** Reconcile and audit against the canon — **do not rewrite.** It must be concise
  and non-duplicative of the PRD: P0 scope and exclusions, the canon §4.4 invariants, the gate
  commands, coding conventions, the data-sensitivity rules of `MASTER_PROMPT.md` §6, the
  definition of done from §12, and the explicit prohibition list from canon §1.2. Must state
  that the canon outranks it.
  Two numbers that are passed at discretion unless written down must be stated here explicitly
  (canon §12.2): the **dependency-audit threshold** — `npm audit` blocks on any `high` or
  `critical` advisory in production dependencies, while `moderate` and `low` are recorded in
  `docs/gap-register.md` and do not block — and the **domain-service coverage threshold** of
  §11. Both are decisions, recorded in `docs/decisions.md`, not measurements.
- **RED:** `tests/unit/docs/claude-md.test.ts` — asserts the file names the canon path, contains
  the prohibition on a composite readiness score, and states a dependency-audit threshold token
  matched against the `npm run audit` script's own flags in `package.json`. The threshold
  assertion is the RED: it fails while the gate's severity level exists only in the script.
- **Verify:** `npm run docs:check` → exit 0.

#### 0.8 `.env.example`, README skeleton and runbook

- **Files:** `.env.example`, `README.md`.
- **Behaviour:** Create or reconcile, as found. `.env.example` lists `DATABASE_URL`, `STATESMAN_AI_MODE`,
  `ANTHROPIC_API_KEY`, `SESSION_COOKIE_NAME`, `E2E_FAULTS` with **placeholder values only and
  no real secrets**. README runbook carries `brew services start postgresql@17` (V26) and
  `export LC_ALL=en_US.UTF-8` (V27) as literal commands, and states that a mistyped role name
  in `DATABASE_URL` connects successfully as whatever role it names under this cluster's
  `trust` auth (V1).
- **RED:** `tests/unit/docs/env-example.test.ts` — asserts the `.env.example` key set
  deep-equals the expected set and that no value matches a secret-shaped pattern. The deep-equal
  assertion is the RED: a subset check passes against a file missing half its keys.
- **Verify:** `npm run secrets` → exit 0; `npm run docs:check` → exit 0.

#### 0.9 Audit the first-deliverable document set against the canon

- **Files:** `docs/architecture.md`, `docs/threat-model.md`, `docs/requirements.yaml`,
  `docs/requirements-traceability.md`, `docs/adr/*`, `docs/decisions.md`, `CLAUDE.md`,
  `docs/canon-audit.md`.
- **Behaviour:** The audited set is the whole first-deliverable document set, this plan
  included. None of it has been audited against the canon by this document. Read each against
  SOS-DESIGN-001 and record in `docs/canon-audit.md` every place where one of them states
  something the canon does not, or contradicts it. The canon wins every disagreement (canon
  preamble). Nothing downstream of Slice 0 may cite these documents as authority until this
  audit exists.
  The audit explicitly checks the three collision classes canon §12 assigns an owner:
  trust-boundary and threat ids against `docs/threat-model.md`; requirement, `INV-nn` and
  `INS-nn` ids against `docs/requirements.yaml`; migration filenames and source/test paths
  against this plan. It also checks that **no document in the set asserts which other documents
  exist** — that claim has no owner and is wrong by construction under parallel authoring.
- **RED:** `tests/unit/docs/canon-audit.test.ts` — asserts `docs/canon-audit.md` names every
  file in the audited set and carries a verdict line for each of the three owned namespaces. Its
  positive control removes one file from a scratch copy of the audit and asserts the checker
  reports the omission. A second case greps the set for sibling-existence claims (`does not
  exist`, `is empty`, `still to write` against a `docs/` path) and asserts none is found.
- **Verify:** `npm run docs:check` → exit 0.

#### 0.10 Review records and manual verification legs

- **Files:** `docs/reviews/README.md`, `docs/reviews/slice-0.md`,
  `docs/reviews/retention-notice.md` (named, not filled), `scripts/docs-check.ts`.
- **Behaviour:** Two things the gates cannot otherwise see.
  1. **Slice review records.** `MASTER_PROMPT.md` §11 requires two independent passes at the end
     of every slice. Each slice's findings live in `docs/reviews/slice-N.md`, one file per
     slice, each finding carrying `file:line`, severity, reproduction and recommended fix, and
     each critical or high finding carrying the gates rerun after the fix with their **before
     and after exit statuses**. `docs/reviews/README.md` states the required shape. A review
     record that exists but records nothing is a failure, not a pass — see the RED.
  2. **Manual verification legs** (canon §12.3). `FR-16` and `NFR-02` cannot be discharged by a
     command. Each such row in `docs/requirements-traceability.md` must name its evidence
     record — `docs/reviews/retention-notice.md` for FR-16's retention and backup disclosure,
     the deployment-encryption record for NFR-02 — and the rule is that **a requirement with a
     manual leg reaches at most `NOT RUN` in the volatile report until that record exists and is
     referenced**. No sign-off name and no date is to be invented in either record.
- **RED (two):**
  1. `tests/unit/docs/reviews.test.ts` — asserts every slice named in this plan has a
     `docs/reviews/slice-N.md`, and that a file containing only headings **fails** the check: a
     record must carry at least one finding row or an explicit "no findings, and here is what was
     examined" statement. Fails against an existence-only check, which an empty file passes.
  2. `tests/unit/docs/manual-legs.test.ts` — asserts every traceability row whose verification
     method includes `manual` names an evidence record path, and that the path is referenced
     from the row rather than only existing on disk. Its positive control strips the reference
     from a scratch copy and asserts the checker reports it.
- **Verify:** `npm run docs:check` → exit 0.

### Acceptance checkpoint — Slice 0

| # | Observable condition |
|---|---|
| 1 | `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build` each exit 0 |
| 2 | `npm run docs:check` exits 0; every one of the 29 requirement ids resolves |
| 3 | `npm run -s gates:list` prints a set deep-equal to the committed list; every not-yet-implemented gate exits non-zero when invoked |
| 4 | Every ADR number the canon cites (ADR-0001 local Postgres, ADR-0002 argon2id parameters, ADR-0003 keeping `FORCE`) resolves to a document that says what the canon says it says, or the divergence is recorded in `docs/canon-audit.md` |
| 5 | Every ADR number cited in `docs/` but not yet written appears in `docs/adr/RESERVED.md`, so `docs:check` is passable at the end of this slice and not only after Slice 6 |
| 6 | `npm run secrets` exits 0 and `.env.example` contains no real credential |
| 7 | The pinned-toolchain ADR's versions were read back from `package-lock.json`, not asserted from memory |
| 8 | `docs/canon-audit.md` names every file in the audited set, carries a verdict for each of the three owned namespaces, and the sibling-existence grep finds nothing |
| 9 | `docs/decisions.md` carries an entry for each replaced `MASTER_PROMPT.md` §4 default and for NFR-06, NFR-07, the coverage threshold and the dependency-audit threshold |
| 10 | Pass A and Pass B findings for this slice are recorded in `docs/reviews/slice-0.md` with `file:line`, severity, reproduction and fix; every critical or high finding is resolved and the affected gates rerun with before and after exit statuses |

**Complexity: M** — breadth of artefacts, no domain logic, no security surface.

---

## 3. Slice 1 — Secure foundation

**Goal:** A database whose security posture is asserted by the build on every migration run in
every environment, reached only through one fail-closed data entry point, with the denial tests
and the concurrency instruments that make later results believable.

**Dependencies:** Slice 0 complete.

> This slice carries the project's whole authorization surface. It is deliberately large. The
> two concurrency **instrument** tests (canon §8.4) belong here, not to Slice 3: an instrument
> must be validated before any result read from it is believed.

### Tasks

#### 1.1 Cluster bootstrap (outside the ordered migration sequence)

- **Files:** `scripts/bootstrap.sql`, `scripts/bootstrap.sh`, `scripts/assert-bootstrap.sql`.
- **Behaviour:** Exactly the canon §4.1 statements: `statesman_owner` (`noinherit nologin`),
  `statesman_app` (`login noinherit nobypassrls nosuperuser nocreatedb nocreaterole`),
  `statesman_migrator` (`login noinherit`, granted `statesman_owner`),
  `revoke temporary on database statesman from public` (V22),
  `revoke create on schema public from public`,
  `alter role statesman_app set search_path = 'public'`. Run as the bootstrap superuser.
  Passwords come from the environment, never from a file written by this project.
  Because both app roles are `noinherit`, the migration runner must issue
  `set role statesman_owner` explicitly (task 1.2).
- **RED:** `tests/integration/db/bootstrap.test.ts` — asserts `statesman_app` has
  `rolsuper=false`, `rolbypassrls=false`, **and** `pg_has_role('statesman_app', r, 'MEMBER')`
  is false for every `rolbypassrls` role (V3 — the attribute check alone is insufficient), and
  that `has_database_privilege('statesman_app','statesman','TEMPORARY')` is false (V22). Fails
  before bootstrap because the roles do not exist.
- **Verify:** `npm run db:bootstrap && psql -v ON_ERROR_STOP=1 -f scripts/assert-bootstrap.sql`
  → exit 0; exit 1 on any failed assertion (E4).

#### 1.2 Ordered migration runner with a mandatory posture call

- **Files:** `scripts/migrate.ts`, `src/server/db/migration-runner.ts`,
  `migrations/` (directory).
- **Behaviour:** Connect as `statesman_migrator`, `set role statesman_owner`, enumerate
  `migrations/0*.sql` by **lexical glob** — never a hand-maintained list (canon §8.3) — apply
  each unapplied file in its own transaction, record it in `schema_migrations`, and call
  `app.verify_security_posture()` **at the end of every run in every environment**, failing the
  run on a raise. The posture call is unconditional: not test-only, not env-gated, not
  skippable by a flag.
- **RED (two, both required):**
  1. `tests/integration/db/migration-runner.test.ts` — writes a throwaway
     `migrations/0099_probe.sql` into a scratch copy of the directory and asserts the runner
     applied it **without any registration step**. Fails if the runner reads a manifest.
  2. same file — stubs the posture function to raise, runs the runner, and asserts the run
     rejects **and** that `schema_migrations` does not record the final file. Fails while the
     posture call is absent, because the run succeeds.
- **Verify:** `npm run db:migrate` → exit 0; `npm run test:int -- migration-runner` → exit 0.

#### 1.3 Schema, context accessor and the volatility gate

- **Files:** `migrations/0001_schema_and_context.sql`.
- **Behaviour:** `create schema app`; `app.require_user_id()` exactly as canon §4.3 —
  `language plpgsql stable`, `set search_path = pg_catalog`, raising `28000` when the GUC is
  null **or the empty string** (V5); `app.current_user_id()` as a thin non-raising alias,
  documented as the only Supabase port seam and **never referenced by a policy**. Both
  functions: `revoke all … from public`, then one explicit `grant execute … to statesman_app`
  line each (V2).
- **RED:** `tests/integration/db/context.test.ts` — three assertions: calling
  `app.require_user_id()` with no context raises SQLSTATE `28000`; calling it after
  `set_config('app.current_user_id','',true)` also raises `28000` (V5); and
  `select provolatile from pg_proc where proname='require_user_id'` equals `s`. The second
  assertion fails against a naive `current_setting(...) is null` implementation.
- **Verify:** `npm run test:int -- context` → exit 0.

#### 1.4 `app.verify_security_posture()` — all ten rules

- **Files:** `migrations/0002_verify_security_posture.sql`,
  `migrations/allowlist/reference_tables.sql`.
- **Behaviour:** One SQL function raising unless all ten canon §4.8 rules hold. Rules 1 and 2
  are **column-name independent** — no `attname='user_id'` selector, which was proven to
  exclude `app_user` and every indirectly scoped table. Rule 8 reads **both** `qual` and
  `with_check`, because `pg_policies.qual` is NULL for INSERT-only policies (V20) and a
  qual-only reader aborts on every INSERT policy.
  The rule-2 allowlist is version-controlled and has **two** explicit sections: global
  reference tables, and the three grant-protected tables (`app_user`, `user_session`,
  `auth_attempt`), whose entries additionally assert that `statesman_app` holds **zero** table
  privileges on them. See §10 item 1 — the canon's rule-2 wording provides only the reference-
  table category, and this is flagged rather than silently resolved.
- **RED:** `tests/integration/db/posture.test.ts` — **ten positive controls**, one per rule,
  each inside a rolled-back transaction that breaks exactly that rule and asserts the function
  raises: create an unforced table with a grant (1); create a table absent from the allowlist
  (2); reassign a table to `statesman_app` (3); `grant execute … to public` (4); create a view
  without `security_invoker` (5); `alter function app.require_user_id() immutable` (6);
  `grant truncate` (7); add a `using (true)` policy and separately an INSERT-only
  `with check (true)` policy on a non-audit table (8); delete a sentinel row (9); drop a
  `not null` on a `user_id` column (10). A rule with no failing control has not been shown to
  work (canon §8).
- **Verify:** `npm run db:verify` → exit 0 (`psql -v ON_ERROR_STOP=1 -c "select
  app.verify_security_posture()"`, exit 1 on raise, E4); `npm run test:int -- posture` → exit 0.

#### 1.5 Privileges fail closed

- **Files:** `migrations/0003_privileges.sql`.
- **Behaviour:** `revoke all on all functions in schema public, app from public` **and**
  `alter default privileges in schema public, app revoke execute on functions from public`
  (V2 — `REVOKE … ON ALL TABLES` does not touch `EXECUTE`). Deliberately **no**
  `alter default privileges … grant` for tables: each migration grants per table, one line
  each, so a forgotten grant yields an invisible table rather than an exposed one.
- **RED:** `tests/integration/db/privileges.test.ts` — creates a `security definer` function
  in a rolled-back transaction with no explicit grant and asserts `statesman_app` **cannot**
  execute it. Fails before the default-privileges revoke, because `pg_proc.proacl IS NULL`
  means `EXECUTE` to `PUBLIC` (V2).
- **Verify:** `npm run test:int -- privileges` → exit 0.

#### 1.6 Reference tables

- **Files:** `migrations/0004_reference_tables.sql`.
- **Behaviour:** `scenario`, `scenario_version`, `source`, `scenario_claim`, `rubric_version`,
  `schema_migrations` — readable by any authenticated user, written only by migration and seed.
  `grant select` to `statesman_app`; **no** insert/update/delete grant. Listed in the rule-2
  allowlist. `scenario_version` carries `is_fiction boolean not null`,
  `as_of_date date not null`, `unique (id)`, `unique (scenario_id, version_no)`.
  `scenario_claim` is keyed `(scenario_version_id, claim_id)` with an FK to `source` and is the
  grounding whitelist consumed in Slice 4.
- **RED:** `tests/integration/db/reference-tables.test.ts` — as `statesman_app`, asserts a
  `select` on `scenario` succeeds and an `insert` raises `42501`. The insert assertion fails
  while a blanket default grant exists.
- **Verify:** `npm run test:int -- reference-tables` → exit 0.

#### 1.7 Identity tables with no grants, reached only by definer functions

- **Files:** `migrations/0005_identity.sql`.
- **Behaviour:** `app_user` (`email text not null` plus `unique index on (lower(email))` —
  `citext` is available but not installed and cannot be created in `public` (V21);
  `password_hash`, `algo_ver smallint`, `privilege_epoch integer not null default 1`),
  `user_session` (`token_hash bytea not null unique` — the token itself is never stored —
  `absolute_expires_at`, `idle_expires_at`, `last_seen_at`, `revoked_at`,
  `privilege_epoch_at_issue`), `auth_attempt`. **No direct grants to `statesman_app`.** The
  nine `SECURITY DEFINER` functions of canon §4.6 are owned by `statesman_owner`, each with
  `set search_path = pg_catalog, public`, each granted to `statesman_app` only, one explicit
  line each. `app.erase_self()` derives identity internally and **never takes a uuid** (V2).
- **RED:** `tests/integration/db/identity-grants.test.ts` — as `statesman_app`, asserts
  `select from app_user` raises `42501` **and** that `app.create_user(...)` succeeds. A single
  assertion either way is passable by an over- or under-granted schema; the pair is not.
- **Verify:** `npm run test:int -- identity-grants` → exit 0.

#### 1.8 User-owned tables, RLS enabled and forced, policies without `TO`

- **Files:** `migrations/0006_user_owned.sql`.
- **Behaviour:** The twelve user-owned tables of canon §5. Each: `user_id uuid not null`,
  `unique (id, user_id)`, composite FKs to parents so ownership is a schema constraint
  (canon §4.5), `enable` **and** `force row level security`, and a tenancy policy that
  **omits the `TO` clause** (V9 — policies scoped `TO statesman_app` are what made owner access
  fail, not `FORCE` itself; canon §10). `audit_event` additionally gets the split policy of
  canon §5.1: `for select using (user_id = app.require_user_id())` and
  `for insert with check (true)` so a deletion's `actor_user_id IS NULL` row is insertable,
  with no UPDATE or DELETE policy. `on delete restrict` from `app_user`, never cascade
  (canon §5.2). Per-table grants, one line each.
- **RED:** `tests/integration/db/rls-shape.test.ts` — asserts, for every table the posture
  function classifies as protected, that `polroles` is `{0}` (i.e. `PUBLIC`, no `TO` clause),
  that `relforcerowsecurity` is true, and that `confrelid`-joined FKs to a parent include the
  `user_id` column. The `polroles` assertion fails against a `TO statesman_app` policy.
- **Verify:** `npm run test:int -- rls-shape` → exit 0.

#### 1.9 Sentinel seed

- **Files:** `migrations/0007_sentinels.sql`.
- **Behaviour:** Exactly one row per protected table owned by reserved UUID
  `00000000-0000-0000-0000-00000000dead`, committed into the test template (V18 — an empty RLS
  table and an empty non-RLS table both return 0, so "0 rows" cannot prove RLS works). Requires
  a sentinel `app_user` row with a reserved email that cannot authenticate: the stored
  `password_hash` is a hash of unrecoverable random bytes, never an issued credential. Because
  the tables are `FORCE`d, the seed sets `app.current_user_id` to the sentinel uuid for the
  duration of the insert rather than bracketing `no force`/`force` — the seed then exercises the
  INSERT policy instead of bypassing it. See §10 item 3.
- **RED (two):**
  1. `tests/integration/db/sentinels.test.ts` — asserts each protected table has exactly one
     row for the reserved uuid. Fails before the seed.
  2. same file — asserts `app.find_credentials('<sentinel email>')` returns a row whose hash
     verifies against **no** candidate password tried by the test, and that a sign-in attempt
     with the reserved email fails. Fails if the seed writes a guessable placeholder hash.
- **Verify:** `npm run test:int -- sentinels` → exit 0.

#### 1.10 Per-worker template-cloned test harness connecting as `statesman_app`

- **Files:** `tests/support/db-template.ts`, `tests/support/global-setup.ts`,
  `tests/support/assert-app-role.ts`, `vitest.config.ts`.
- **Behaviour:** Global setup builds `statesman_test_template` by running the real migration
  runner (so the posture call and the lexical glob are on the test path too), then each worker
  does `create database statesman_test_w<n> template statesman_test_template` and drops it at
  teardown. **Not `TRUNCATE`** — the immutability triggers forbid it, by design (canon §8.3).
  Tests connect as `statesman_app`; a wrong-role connection is **harness-fatal**, not a warning.
  `assertAppRole` checks **both directions on non-empty data** (canon §8.1): with no context,
  every protected table returns 0; as the sentinel user, each returns exactly 1. Seeding goes
  through `withUser`, so a missing INSERT policy surfaces instead of being bypassed.
- **RED:** `tests/integration/harness/app-role.test.ts` — points the fixture at a
  `statesman_migrator` connection string and asserts the harness **aborts**. Fails while the
  harness merely logs. A second case drops RLS from one table in a rolled-back transaction and
  asserts `assertAppRole` reports the leaked sentinel.
- **Verify:** `npm run test:int -- harness` → exit 0.

#### 1.11 Paired cross-user denial with a policy-dropped positive control

- **Files:** `tests/integration/db/cross-user-denial.test.ts`.
- **Behaviour:** The canon §8.2 sequence, in order: A sees the row (1) → B sees 0 → B's write
  raises **nothing** → A still sees 1. Then, inside a rolled-back transaction, **drop the
  policy** and assert the row becomes visible to B. A bare `rowCount === 0` proves nothing: a
  cross-user `DELETE` under RLS returns `DELETE 0` with no error, byte-identical to deleting a
  nonexistent id (V19), and a failing `USING` clause affects zero rows and raises nothing (V7).
  Every denial case asserts the **after-state** read, not only the row count.
- **RED:** the positive control itself — with the policy dropped, the test must observe the row.
  A run in which the control does not flip the outcome means the test was measuring absence,
  not denial, and the case fails.
- **Verify:** `npm run test:int -- cross-user-denial` → exit 0.

#### 1.12 Concurrency instrument tests (canon §8.4) — harness-fatal

- **Files:** `tests/support/concurrency.ts`, `tests/integration/harness/instruments.test.ts`.
- **Behaviour:** Two mandatory instrument validations, before any race result is believed:
  1. `waitUntilBlocked` must return **false** when two sessions lock **different** rows.
  2. The revision-number read helper, run sequentially, must produce **different** values.
  Plus the observability precondition: assert a **positive** observation of another session in
  `pg_stat_activity`, because a non-privileged observer gets one row per pid with `state` and
  `wait_event_type` NULL (V24), and "cannot observe" otherwise reports as "never blocked".
- **RED:** each instrument test is itself the control — it asserts the instrument reports the
  **negative** case. `waitUntilBlocked` returning true for different rows, or the read helper
  returning equal values sequentially, fails the harness and blocks the slice.
- **Verify:** `npm run test:int -- instruments` → exit 0. A failure here is fatal: Slice 3's
  race tests may not be written until this exits 0.

#### 1.13 `withUser` / `withMigrator` — the only data entry points

- **Files:** `src/server/db/index.ts`, `src/server/db/with-user.ts`,
  `src/server/db/assert-unprivileged.ts`, `src/server/db/brands.ts`.
- **Behaviour:** The two exported signatures of canon §6.1 and nothing else; the `Pool` is
  module-private. **`withUser` takes no session parameter** — it calls `requireSession()`
  itself, because identity-as-argument type-checks perfectly when handed a victim's id and RLS
  then faithfully enforces the attacker's chosen identity. Body in order: cached
  `assertUnprivilegedOnce()` (V1, V3) → `BEGIN` → `select set_config('app.current_user_id',$1,
  true)` → `select app.require_user_id()` as **eager** validation (V6 — with no context, a
  select on a nonexistent id returns rc=0, zero rows and no error) → caller work → `COMMIT`/
  `ROLLBACK` → `finally: DISCARD ALL` then release. `AuthenticatedSession` and
  `UserScopedClient` are branded with a `unique symbol` producible only inside
  `requireSession`/`withUser`. `set local statement_timeout` goes through
  `set_config($1,$2,true)` with a Zod-validated number — zero interpolated values in
  transaction setup. **No rollback branch and no `process.env` reference** in `withUser`;
  per-test transaction isolation is injected by test-only code through an optional provider
  (canon §8.3).
- **RED (four):**
  1. `tests/unit/db/with-user.test.ts` — asserts the module's export names deep-equal
     `['withUser','withMigrator']`. Fails while a `Pool` or a raw `query` is exported.
  2. same file — asserts the compiled source of `withUser` contains no `process.env` and no
     `rollback`-on-env branch (canon §8.3).
  3. `tests/integration/db/eager-validation.test.ts` — calls `withUser` with the context step
     removed by a test double and asserts the transaction raises `28000` **before** the
     caller's query runs. Fails against a lazy implementation, which returns zero rows quietly
     (V6).
  4. `tests/integration/db/discard-all.test.ts` — sets a session-level GUC inside `withUser`,
     releases, re-acquires the same pooled connection and asserts the GUC is gone. Fails
     without `DISCARD ALL`.
- **Verify:** `npm run test:unit -- with-user && npm run test:int -- eager-validation
  discard-all` → exit 0.

#### 1.14 Authentication

- **Requirement:** FR-14 (private account; unauthorized users read no response, journal or
  action), with the denial half discharged by tasks 1.11 and 4.9, and NFR-01.
- **Files:** `src/server/auth/password.ts`, `src/server/auth/session.ts`,
  `src/server/auth/rate-limit.ts`, `src/app/(auth)/sign-in/page.tsx`,
  `src/app/(auth)/sign-up/page.tsx`, `src/app/api/auth/*/route.ts`,
  `migrations/0008_privilege_epoch.sql`.
- **Behaviour:** argon2id via `@node-rs/argon2` with the parameters canon §6 pins —
  `memoryCost = 19456` KiB, `timeCost = 2`, `parallelism = 1`, 16-byte salt, 32-byte output, the
  RFC 9106 / OWASP low-memory baseline — recorded in **ADR-0002** (canon §6; **not** ADR-0005,
  which is the privilege decision). These are a **decision, not a measurement**: the option
  *names* and defaults must be read back from the installed `@node-rs/argon2` release before use
  (O4), and a unit test asserts the hashing call uses exactly these values so later drift fails
  the build. `algo_ver` permits rehash-on-login. **No pepper** (canon §6 — it would live in the
  same env as `DATABASE_URL`). Token: 32 bytes from `crypto.randomBytes`, base64url, **only its
  SHA-256 hash stored**. Cookie `HttpOnly`, `SameSite=Lax`, `Path=/`, explicit `Max-Age`,
  `Secure` and the `__Host-` prefix **in production only**. Absolute 30-day and idle 7-day
  timeouts; the idle window slides **conditionally** (`last_seen_at < now() - interval '15
  minutes'`), fire-and-forget, and `app.resolve_session` is a **pure read** — otherwise
  framework prefetches renew the window with no user activity and the idle control is hollow
  while its test still passes. Sign-out revokes the session **row** first, then clears the
  cookie with full matching attributes. Privilege epoch: `AFTER UPDATE` trigger with **no column
  list**, comparing `to_jsonb(NEW) - 'privilege_epoch' - 'last_seen_at'` against the same
  projection of OLD, deleting the user's sessions; a `BEFORE UPDATE` guard raises on a
  decreasing epoch. Rate limiting is per-identifier progressive delay with the DB client
  **released before sleeping**; the aggregate threshold raises an alert, never a block; **no
  lockout, no instance-wide circuit breaker** (canon §6).
  Rehash-on-login must run **before** `app.create_session`, or the no-column-list epoch trigger
  deletes the session that login just created — see §10 item 2.
- **RED (eight):**
  1. `tests/integration/auth/idle-window.test.ts` — resolves a session 20 times inside the
     15-minute threshold and asserts `last_seen_at` is **unchanged**. Fails against an
     unconditional touch.
  2. `tests/integration/auth/sign-out.test.ts` — replays the **captured cookie** after sign-out
     and asserts the server rejects it. Asserting the cookie is gone proves nothing about the
     server, so a cookie-only assertion is not accepted for this requirement.
  3. `tests/integration/auth/privilege-epoch.test.ts` — adds a **new** privilege-bearing column
     in a rolled-back transaction, updates it, and asserts the sessions were deleted. Fails
     against a hardcoded column allowlist.
  4. same file — asserts a decreasing epoch raises, and that deleted session rows cannot be
     resurrected.
  5. `tests/integration/auth/rehash-on-login.test.ts` — signs in with an `algo_ver` older than
     current and asserts the session issued by that same login still resolves afterwards. Fails
     if the rehash update fires the epoch trigger after session creation.
  6. `tests/integration/auth/token-storage.test.ts` — asserts no row in `user_session` contains
     the issued token bytes, only its SHA-256 hash.
  7. `tests/unit/auth/argon2-params.test.ts` — asserts the hashing call is made with exactly the
     canon §6 values (`memoryCost = 19456`, `timeCost = 2`, `parallelism = 1`, 16-byte salt,
     32-byte output) by capturing the options object passed to `@node-rs/argon2`, and asserts
     the option **names** used are the ones the installed release actually accepts (O4 — read
     back, never asserted from memory). Fails against defaults, and fails later if a parameter
     drifts without ADR-0002 being amended.
  8. `tests/integration/auth/simultaneous-sessions.test.ts` — one user holding **two** live
     sessions (`MASTER_PROMPT.md` §9 adversarial list). Asserts that signing out of session A
     revokes **only** A's row and that B's captured cookie still resolves; then that a
     privilege-epoch bump deletes **both**. Its positive control is the pair itself: a
     sign-out implementation that clears the cookie or revokes by `user_id` passes the first
     half and fails the second, and an epoch trigger scoped to the issuing session passes the
     second and fails the first.
- **Verify:** `npm run test:int -- auth && npm run test:unit -- argon2-params` → exit 0.

#### 1.15 Posture check as integration test #1, and the CI wiring

- **Files:** `vitest.config.ts` (integration project ordering), `.github/workflows/ci.yml` or
  the equivalent runner config chosen in Slice 0.
- **Behaviour:** The posture check runs as the **first** integration test, in addition to its
  end-of-migration call. `eslint` is **its own step** — `next build` may not be relied on to
  lint (canon §8.7). No credentials are written to any handoff file; workers read connection
  bases from their own environment; `reports/` is gitignored.
- **RED:** `tests/integration/_000-posture.test.ts` ordered first by filename; a CI dry run
  with a deliberately broken policy must fail at this step, not later.
- **Verify:** the §11 pipeline up to and including `test:int` → exit 0 on a clean tree.

### Acceptance checkpoint — Slice 1

| # | Observable condition |
|---|---|
| 1 | `npm run db:bootstrap`, `npm run db:migrate`, `npm run db:verify` each exit 0 from a clean cluster |
| 2 | `app.verify_security_posture()` has **ten** positive controls, each demonstrated to make it raise |
| 3 | The runner applies a newly dropped-in `migrations/0*.sql` with no registration step, and rejects the run when the posture function raises |
| 4 | `assertAppRole` passes in both directions: 0 rows with no context, exactly 1 as the sentinel user |
| 5 | The cross-user denial test's policy-dropped positive control flips the outcome |
| 6 | Both concurrency instruments report their negative case; the harness is fatal on a wrong-role connection |
| 7 | `src/server/db` exports exactly `withUser` and `withMigrator`; `withUser` has no session parameter, no `process.env`, no rollback branch |
| 8 | Captured-cookie replay after sign-out is rejected by the server |
| 9 | The privilege-epoch test passes with a **newly added** column, not an allowlisted one |
| 10 | Two live sessions for one user behave independently on sign-out and are both deleted by an epoch bump |
| 11 | The argon2id call is asserted against the canon §6 values, with the option names read back from the installed release |
| 12 | `npm run test:int` exits 0 with the posture check as test #1 |
| 13 | Pass A and Pass B findings for this slice are recorded in `docs/reviews/slice-1.md` with `file:line`, severity, reproduction and fix; every critical or high finding is resolved and the affected gates rerun with before and after exit statuses |

**Complexity: XL** — the entire authorization surface, ten posture rules each needing a control,
and the instrument validations other slices depend on.

---

## 4. Slice 2 — Credible case content

**Goal:** Seed one explicitly fictional, dated dengue training case with zero unverified
real-world claims, plus the source register and the `scenario_claim` whitelist that Slice 4's
grounding depends on.

**Dependencies:** Slice 1 tasks 1.2, 1.4, 1.6 complete.

> **No authoring UI and no publish workflow.** Both were cut as over-engineering (canon §11);
> content enters through a seed migration and a documented import pathway.

### Tasks

#### 2.1 Seed the fictional case

- **Files:** `migrations/0009_seed_demo_ph_001.sql`, `content/demo-ph-001.json`.
- **Behaviour:** `scenario` + `scenario_version` for **DEMO-PH-001, "A Regional Dengue Response
  Under Uncertainty"** (`docs/PRD.md` Appendix A): `is_fiction = true`, an explicit
  `as_of_date`, the simulated role, the 72-hour window, the constraints and the required
  decision. Every proper noun is fictional. **No Guyanese statute, budget figure, price,
  institutional position or health statistic appears anywhere in the content** — Guyana-first is
  editorial context, not licence to invent (canon §1.2). The version is immutable once
  `published_at` is set.
- **RED:** `tests/unit/content/fiction-labels.test.ts` — asserts `is_fiction === true` and
  `as_of_date` is non-null for every seeded `scenario_version`, and that the content text
  matches none of a committed deny-list of real-institution and real-statute patterns. Fails
  before the seed.
- **Verify:** `npm run db:migrate && npm run test:int -- seed` → exit 0.

#### 2.2 Source register

- **Files:** `migrations/0009_seed_demo_ph_001.sql` (same file), `content/sources.json`.
- **Behaviour:** `source` rows carry title, publisher, URI, publication date and retrieved date
  (NFR-10). For a wholly fictional case the register's entries are **labelled scenario
  fiction** rather than presented as external citations. No URI is invented to look real.
- **RED:** `tests/unit/content/source-register.test.ts` — asserts every `source` row either has
  a dated, resolvable-shaped URI **or** `kind = 'scenario_fiction'`, with no third state. Fails
  against a row with a bare URI and no date.
- **Verify:** `npm run test:int -- seed` → exit 0.

#### 2.3 `scenario_claim` whitelist

- **Files:** `migrations/0009_seed_demo_ph_001.sql` (same file).
- **Behaviour:** One `scenario_claim` row per factual assertion in the case, keyed
  `(scenario_version_id, claim_id)` with its FK to `source`. This table **is** the grounding
  whitelist: a model citation naming a `claim_id` absent from it is rejected server-side
  (canon §5.1, consumed in task 4.4).
- **RED:** `tests/unit/content/claim-coverage.test.ts` — walks every factual assertion marked
  in `content/demo-ph-001.json` and asserts each has a `scenario_claim` row; separately asserts
  that an assertion with no claim id and no fiction flag **fails** the check (the positive
  control). Fails before the claim rows exist.
- **Verify:** `npm run test:int -- seed` → exit 0.

#### 2.4 Reference-content read path and the brief's six required elements

- **Requirement:** **FR-01** — "User sees task, assumed role, timeline, available resources,
  missing information and topic before starting" (`docs/PRD.md` §6.1) — and FR-02.
- **Files:** `src/server/content/scenario.ts`, `src/app/(app)/scenario/[id]/page.tsx`,
  `src/components/case-brief.tsx`.
- **Behaviour:** Read scenarios through `withUser` as `statesman_app` (select only). The Decision
  Desk brief renders the source register, the `as_of_date`, the fiction label and the data gaps
  **before** the response form (FR-02, `docs/PRD.md` §5.2). FR-01's acceptance condition is a
  content condition, not a grant condition: the brief must render all **six** named elements —
  task, assumed role, timeline, available resources, missing information, topic — and each is a
  distinct addressable element of the rendered brief, not prose a reader might infer them from.
  The six are structured fields of the seeded case file, so a case missing one fails at the
  content gate rather than rendering a silently incomplete brief.
- **RED (two):**
  1. `tests/integration/content/read-only.test.ts` — asserts the app role can read a published
     `scenario_version` and that an `update` on it raises `42501`.
  2. `tests/e2e/case-brief.spec.ts` — opens the seeded DEMO-PH-001 brief and asserts all six
     FR-01 elements are present and rendered **above** the response form, located by stable test
     ids rather than by text matching. Its positive control removes one element from the fixture
     case file and asserts the test **fails** — a brief shipped without the assumed role, the
     timeline or the missing-information section must not pass. A grants-only assertion does not
     discharge FR-01 and is not accepted for it.
- **Verify:** `npm run test:int -- content` → exit 0; `npm run e2e -- case-brief` → exit 0.

#### 2.5 Documented import pathway for the 10–15 anticipated cases

- **Files:** `docs/content-pipeline.md`, `scripts/import-case.ts`.
- **Behaviour:** The editorial states of `docs/PRD.md` §8.2 (draft → source verification →
  subject-matter/ethics review → approved → published → refresh/archive) are documented as a
  **process over seed migrations**, with the importer validating a case file against the
  schema and refusing a file with an unclaimed factual assertion. No reviewer identity,
  approval or sign-off is recorded for content that has not been reviewed.
- **RED:** `tests/unit/content/importer.test.ts` — asserts the importer rejects a case file
  containing a factual assertion with no `claim_id` and no fiction flag, with a non-zero exit.
- **Verify:** `npm run test:unit -- importer` → exit 0.

### Acceptance checkpoint — Slice 2

| # | Observable condition |
|---|---|
| 1 | Exactly one scenario is seeded; `is_fiction` is true and `as_of_date` is set |
| 2 | The deny-list test finds no real institution, statute, budget figure or health statistic in the content |
| 3 | Every factual assertion in the case file resolves to a `scenario_claim` row, and the no-claim positive control fails the check |
| 4 | The app role can read and cannot write reference content |
| 5 | The Decision Desk brief shows the fiction label, `as_of_date` and source register above the form |
| 6 | The brief renders all six FR-01 elements above the form, and removing one from the fixture makes the test fail |
| 7 | No authoring UI and no publish workflow exist in the codebase |
| 8 | Pass A and Pass B findings for this slice are recorded in `docs/reviews/slice-2.md` with `file:line`, severity, reproduction and fix; every critical or high finding is resolved and the affected gates rerun with before and after exit statuses |

**Complexity: M** — mostly content discipline and one seed migration; the hard part is the
claim-coverage control, not the SQL.

---

## 5. Slice 3 — Decision workflow

**Goal:** Drafts that survive interruption, a locking submission transaction that cannot
double-write, and append-only revisions whose arbitration is a row lock rather than a hope.

**Dependencies:** Slices 1 and 2 complete. **Task 1.12 must be GREEN** — the race tests here
are read through those instruments.

### Tasks

#### 3.1 Draft persistence with a payload-only grant

- **Files:** `migrations/0010_decision.sql`, `src/server/decision/draft.ts`,
  `src/app/(app)/desk/[scenarioVersionId]/page.tsx`.
- **Behaviour:** `decision` with `unique (id, user_id)`, `draft_payload jsonb`, the five
  milestone timestamps, and a partial unique index enforcing **one open draft per user per
  scenario version**. `grant update (draft_payload)` **only**; `draft_updated_at` is set by a
  trigger, so a payload-only update cannot evade the frozen-draft check. Autosave writes the
  structured fields of `docs/PRD.md` §5.2 in the specified order; incomplete drafts reopen
  without loss (FR-03).
- **RED:** `tests/integration/decision/draft.test.ts` — asserts an `update` naming
  `draft_updated_at` directly raises `42501`, **and** that a `draft_payload` update still
  advances `draft_updated_at`. The first assertion fails against a whole-row update grant.
- **Verify:** `npm run test:int -- draft` → exit 0.

#### 3.2 State derivation and the transition whitelist

- **Files:** `migrations/0010_decision.sql` (same file),
  `migrations/0011_decision_state.sql`, `tests/integration/decision/state.test.ts`.
- **Behaviour:** **One derivation function, used twice** (canon §4.4). `app.derive_decision_state(
  p_submitted, p_challenged, p_reflected, p_action, p_closed)` is `IMMUTABLE`, returns
  `app.decision_state`, and uses **per-branch** enum casts — never a cast of the `CASE` result,
  which is rejected as not immutable because `enum_in` is STABLE (V12). It is the sole
  definition of what the state is.
  - The `state` column is `GENERATED ALWAYS AS (app.derive_decision_state(...)) STORED`. A
    user-declared `IMMUTABLE` function is accepted in that position (V29, reproduced as E3).
  - The `BEFORE UPDATE` trigger derives the **prospective** state by calling **that same
    function** on `NEW`'s milestone timestamps, compares `OLD.state → prospective` against the
    whitelist, and raises **uppercase** custom SQLSTATEs (V13 — a lowercase SQLSTATE silently
    resolves to `42704`) that the API maps to distinct HTTP statuses.
  - **The trigger must never read `NEW.state`.** It is NULL in a `BEFORE UPDATE` trigger on a
    generated column (V28, reproduced as E2), so a trigger that reads it compares against NULL
    on every transition and therefore permits everything or rejects everything. A trigger
    written the obvious way is **inert**, and inert is indistinguishable from working in any
    test that only exercises legal transitions.
  One function serving both the column and the guard is what makes them unable to drift; this is
  the design, not an optimisation. RLS never encodes transitions (V7, and it makes 404
  indistinguishable from 409).
  Also settle by command, before relying on it: whether `create or replace` on a function a
  generated column depends on is permitted, and whether stored values are recomputed. Record
  the answer in the ADR that cites it (O4).
- **RED (three):**
  1. `state.test.ts` — the **meta-test canon §4.4 requires as a control**: over **all 32**
     combinations of the five milestone timestamps being null / non-null, assert that
     `app.derive_decision_state()`'s result and the **stored generated column** agree, for every
     combination, and that the trigger's prospective derivation equals both. 32 is the whole
     domain, not a sample. Fails against a trigger that reads `NEW.state`, because every
     comparison sees NULL; fails against any second definition of the state machine, because the
     two definitions disagree somewhere in the 32.
  2. same file — asserts an illegal transition (e.g. `closed → draft`) raises the expected
     uppercase SQLSTATE, and that the raised code is **not** `42704` (V13 round-trip). Its
     positive control is a **legal** transition in the same test, asserted to succeed: a guard
     that rejects everything passes the illegal-transition assertion on its own.
  3. same file — asserts the generation expression rejects a `CASE`-result cast, documenting
     V12 as a live constraint rather than a comment.
- **Verify:** `npm run test:int -- state` → exit 0.

#### 3.3 Locking submission transaction

- **Files:** `migrations/0012_submit.sql`, `src/server/decision/submit.ts`.
- **Behaviour:** One transaction: lock the `decision` row, insert `decision_revision`
  `revision_no = 1` with `scenario_version_id` pinned by composite FK, set `submitted_at`,
  write the `submission` audit event. `decision_revision` carries
  `confidence smallint check (confidence between 0 and 100)`, `forecast text not null`,
  `horizon` and `rationale text not null` (**FR-05**), so a submission missing the confidence
  value, the expected outcome or the timeframe is rejected by the schema and not only by the
  form. `decision_revision` is append-only: no UPDATE, DELETE or
  TRUNCATE grant, plus `BEFORE UPDATE OR DELETE` triggers **and** a
  `BEFORE TRUNCATE … FOR EACH STATEMENT` trigger, because `TRUNCATE` bypasses row-level
  triggers (V15). **Every privileged write asserts its row count** (canon §4.4):
  `get diagnostics n = row_count; if n <> 1 then raise … using errcode = 'ST005'`. Silence is
  not success (V7). The UI requires explicit confirmation that submission is irreversible
  (`docs/PRD.md` §5.2).
- **RED (four):**
  1. `tests/integration/decision/submit.test.ts` — asserts an `update` on a submitted
     `decision_revision` raises, a `delete` raises, and `truncate` raises (three separate
     assertions; the truncate case fails against row-level triggers alone, V15).
  2. same file — removes the row-count assertion by a test double and asserts a submission
     whose update matched **zero** rows is rejected rather than reported as succeeded.
  3. same file — asserts the `submission` audit row exists with the correct `user_id` and
     non-null `actor_user_id`.
  4. same file — asserts a submission with `confidence = 101`, with a null `forecast`, and with
     a null `rationale` each raise at the database, independently of client validation
     (**FR-05**). Fails against columns that are merely form-validated.
- **Verify:** `npm run test:int -- submit` → exit 0.

#### 3.4 `append_revision` with `SELECT FOR UPDATE` as the arbitration

- **Files:** `migrations/0012_submit.sql` (same file),
  `src/server/decision/append-revision.ts`.
- **Behaviour:** A submitted decision is never overwritten; a correction appends
  `decision_revision` with `revision_no = max + 1` and a `rationale`, both revisions remaining
  traceable (FR-04, FR-12). The arbitration is an explicit `select … for update` on the parent
  `decision` row before reading `max(revision_no)` — not an advisory lock, not a retry loop
  around a unique-violation. `unique (decision_id, revision_no)` is the backstop, not the
  mechanism. `idempotency_token uuid unique` makes a replayed request return the existing
  revision rather than creating a second one.
- **RED:** `tests/integration/decision/append-revision.test.ts` — two clients, explicit
  `BEGIN`, interleaved statements, both appending to the same decision; asserts exactly two
  revisions exist with `revision_no` 2 and 3 and **no** unique violation surfaced to either
  caller. Fails against an unguarded read-then-write, which never blocks (V23).
- **Verify:** `npm run test:int -- append-revision` → exit 0.

#### 3.5 Genuinely concurrent double-submit, with its negative control

- **Files:** `tests/integration/decision/double-submit.test.ts`.
- **Behaviour:** Two clients, explicit `BEGIN`, interleaved statements, and an overlap probe
  (canon §8.4). Concurrent submissions are idempotent or explicitly rejected — never duplicated
  (`MASTER_PROMPT.md` §6). The negative control is an **application rendezvous plus an
  `xact_start` overlap assertion**, not lock-wait detection: an unguarded read-then-write never
  blocks and no lock wait ever appears (V23). A **positive** observability assertion
  distinguishes a NULLed `pg_stat_activity` from "not yet blocked" (V24). Row counts are
  asserted, never inferred.
- **RED:** the negative control — with the row lock removed, the test must observe **two**
  submissions and overlapping `xact_start` values. A control that cannot produce the duplicate
  has not demonstrated the guard.
- **Verify:** `npm run test:int -- double-submit` → exit 0, and the instruments of task 1.12
  still exit 0 in the same run.

#### 3.6 Today and Decision Desk surfaces

- **Files:** `src/app/(app)/today/page.tsx`, `src/app/(app)/desk/[…]/*`,
  `src/components/*`.
- **Behaviour:** Today shows one prominent Today's Decision card with sector, jurisdiction,
  `as of` date, the ~15-minute practice estimate, the fiction label, recent activity and open
  corrective actions. **No fake activity counters and no composite readiness score** of any
  kind (`MASTER_PROMPT.md` §5A, canon §1.2). Decision Desk renders the brief first, then the
  structured fields in PRD order, with field validation, autosave and an explicit irreversible-
  submission confirmation.
- **RED:** `tests/e2e/decision-loop.spec.ts` (first portion) — new account → Today → open
  scenario → fill draft → reload the page mid-draft → assert every field value survived →
  submit → assert the lock confirmation was required. Fails before the surfaces exist.
  Plus `tests/unit/ui/no-composite-score.test.ts` — asserts no component file and no API
  response contains an aggregate score field name from a committed deny-list.
- **Verify:** `npm run e2e -- decision-loop` → exit 0; `npm run test:unit -- no-composite-score`
  → exit 0.

#### 3.7 Audit events for the decision path

- **Files:** `src/server/audit/write.ts`, `migrations/0012_submit.sql`.
- **Behaviour:** `audit_event` rows for submission, revision and action-state change, carrying
  `user_id` (the subject) **and** `actor_user_id` (the actor; nullable). Sensitive payloads are
  minimized — no journal body text in audit rows or logs (`MASTER_PROMPT.md` §6, NFR-03).
- **RED:** `tests/integration/audit/immutability.test.ts` — asserts an `update` and a `delete`
  on `audit_event` both raise, that no UPDATE or DELETE policy exists, and that no audit row
  contains a substring of the decision's rationale text.
- **Verify:** `npm run test:int -- audit` → exit 0.

#### 3.8 Field validation at the application boundary (FR-03, FR-05)

- **Requirement:** **FR-03** (required decision fields are validated; incomplete drafts reopen
  without loss) and **FR-05** (0–100 confidence plus a stated expected outcome and timeframe).
- **Files:** `src/server/validation/decision.ts`,
  `tests/unit/validation/decision.test.ts`.
- **Behaviour:** One Zod schema module is the submission's validation boundary, covering the
  structured fields of `docs/PRD.md` §5.2 in their specified order. The database checks of task
  3.3 stay exactly as they are: they are an **independent backstop**, not a substitute. Two
  layers are the point — the schema gives the user a field-level error, the column makes the
  bad row unwritable even if a caller bypasses the schema, and either alone is a single point of
  failure. Boundary values are part of the contract, not an edge case: confidence `0` and `100`
  are **accepted**, `-1` and `101` are **rejected**, a non-integer confidence is rejected, and a
  submission with an absent `forecast` or an absent `horizon` is rejected.
- **RED:** `tests/unit/validation/decision.test.ts` — a table-driven case per boundary:
  `{0, 100}` accepted; `{-1, 101, 50.5}` rejected; absent `forecast` rejected; absent `horizon`
  rejected; absent `rationale` rejected; and every `docs/PRD.md` §5.2 required field asserted
  present in the schema's key set by **deep equality**, so a field dropped from the form is a
  test failure rather than a silently optional input. The accept half is the positive control:
  a validator that rejects everything passes all the rejection cases.
- **Verify:** `npm run test:unit -- validation/decision` → exit 0.

### Acceptance checkpoint — Slice 3

| # | Observable condition |
|---|---|
| 1 | A draft survives a mid-form reload with every field intact (FR-03) |
| 2 | `draft_updated_at` cannot be written directly; a payload update still advances it |
| 3 | The state meta-test agrees for all 32 milestone combinations — function result, stored column and the trigger's prospective derivation — and the trigger reads no `NEW.state` |
| 4 | An illegal transition raises an uppercase custom SQLSTATE that is not `42704` |
| 5 | Update, delete **and** truncate on a submitted revision each raise |
| 6 | Removing the row-count assertion makes a zero-row submission fail, not succeed |
| 7 | Two interleaved appends produce revisions 2 and 3 with no unique violation reaching a caller |
| 8 | The double-submit negative control produces a duplicate when the lock is removed, with overlapping `xact_start` |
| 9 | No composite score appears in any component or API response |
| 10 | Confidence `0` and `100` are accepted and `-1`, `101`, a non-integer, an absent forecast and an absent horizon are each rejected at the validation boundary **and** at the database |
| 11 | `npm run test:int` and `npm run e2e -- decision-loop` exit 0 |
| 12 | Pass A and Pass B findings for this slice are recorded in `docs/reviews/slice-3.md` with `file:line`, severity, reproduction and fix; every critical or high finding is resolved and the affected gates rerun with before and after exit statuses |

**Complexity: XL** — the concurrency surface and the state machine, both of which have a
documented way of appearing to work.

---

## 6. Slice 4 — AI and challenge

**Goal:** Five-lens challenges whose citations cannot be fabricated, produced by an adapter
that works with no API key at all.

**Dependencies:** Slices 1–3 complete; task 2.3 (`scenario_claim`) is the grounding source.

### Tasks

#### 4.1 Fixture adapter first

- **Files:** `src/server/ai/adapter.ts`, `src/server/ai/fixture-adapter.ts`,
  `tests/fixtures/ai/*.json`.
- **Behaviour:** **The fixture adapter is built before any provider client.** The application
  must be fully exercisable with no credential. The fixture module **throws on import** when
  `NODE_ENV === 'production'` (canon §7.1). Deterministic fixtures, one per lens, plus failure
  fixtures (timeout, malformed JSON, missing citation, unapproved source id).
- **RED:** `tests/unit/ai/fixture-adapter.test.ts` — sets `NODE_ENV='production'` and asserts
  the dynamic import **rejects**. Fails while the module imports cleanly.
- **Verify:** `npm run test:unit -- fixture-adapter` → exit 0, with `ANTHROPIC_API_KEY` unset.

#### 4.2 Explicit mode, never key-presence

- **Files:** `src/server/env.ts`, `src/server/ai/mode.ts`.
- **Behaviour:** `STATESMAN_AI_MODE: 'live' | 'fixture' | 'unavailable'`, default
  `'unavailable'`, validated by Zod at startup. **Never keyed on the absence of
  `ANTHROPIC_API_KEY`** — an implicit trigger ships canned feedback as the production default.
  A missing key in `live` mode renders the NFR-08 unavailable/retry state and does not fall
  back. Provenance is derived from the provider by **one** mapping function and tied by the
  database `CHECK ((provider = 'fixture') = (provenance = 'fixture'))` (canon §5.1). The UI
  labels every fixture-backed response as such.
- **RED:** `tests/unit/ai/mode.test.ts` — asserts that with `STATESMAN_AI_MODE` unset the mode
  is `'unavailable'`, and that setting `ANTHROPIC_API_KEY` alone **does not** produce
  `'fixture'` or `'live'`. The second assertion fails against key-presence inference.
  Plus `tests/integration/ai/provenance-check.test.ts` — asserts an insert with
  `provider='fixture', provenance='live'` raises a check violation.
- **Verify:** `npm run test:unit -- mode && npm run test:int -- provenance-check` → exit 0.

#### 4.3 Zod schemas and the `freeText` factory

- **Files:** `src/server/ai/schemas/challenge.ts`,
  `src/server/ai/schemas/assessment.ts`, `src/server/ai/schemas/free-text.ts`.
- **Behaviour:** The challenge contract of `docs/PRD.md` §9.2 and the assessment contract of
  `MASTER_PROMPT.md` §7, validated server-side. **Every** model-facing string comes from one
  `freeText(min,max)` factory applying URI and control-character rejection.
- **RED:** `tests/unit/ai/schema-walk.test.ts` — a **meta-test** that walks both schemas' type
  trees and fails any `ZodString` leaf not produced by the factory. Its own positive control
  adds a raw `z.string()` leaf to a copy of the schema and asserts the walker **reports it**.
  A walker that cannot flag the planted leaf has not been shown to work.
- **Verify:** `npm run test:unit -- schema-walk` → exit 0.

#### 4.4 Citation whitelist and relational grounding

- **Files:** `src/server/ai/grounding.ts`, `migrations/0013_challenge.sql`.
- **Behaviour:** Every `evidence_ref` and `source_claim` is checked against `scenario_claim` for
  the **pinned** `scenario_version_id`; an unknown id is rejected server-side. Grounding is then
  enforced **relationally**, not by application check alone: the citation row references
  `(scenario_version_id, source_id, claim_id)` **and** the owning challenge's `(id, user_id)`
  by composite FK, so a fabricated citation cannot be persisted. The same chain exists for
  assessments via `assessment_observation_source_claim` — without it the gate covers challenges
  only. A challenge whose citations do not all resolve is **dropped individually** and the drop
  recorded with a `failure_code`.
- **RED (three):**
  1. `tests/integration/ai/grounding.test.ts` — a fixture response citing an unapproved
     `claim_id` is rejected and **nothing** is persisted for that challenge.
  2. same file — bypass the application check by a test double and attempt the insert directly;
     assert the composite FK raises. Fails if grounding lives only in TypeScript.
  3. same file — the assessment path with an unapproved claim id raises too.
- **Verify:** `npm run test:int -- grounding` → exit 0.

#### 4.5 Post-parse refinement enforcement (V25)

- **Files:** `src/server/ai/validate.ts`, `src/server/ai/metrics.ts`.
- **Behaviour:** `z.toJSONSchema()` **drops refinements** (V25), so `.check()` rules never
  reach a constrained decoder. Every refinement is therefore **re-enforced server-side after
  parse**, and violations are counted.
- **RED:** `tests/unit/ai/refinements.test.ts` — asserts that
  `z.toJSONSchema(challengeSchema)` contains **no** trace of a refinement that the schema
  declares (making V25 a live, failing-if-changed assertion), **and** that a response violating
  that refinement is rejected after parse with the violation counter incremented. The second
  assertion fails while enforcement relies on the decoder.
- **Verify:** `npm run test:unit -- refinements` → exit 0.

#### 4.6 No free-text JSON recovery

- **Files:** `src/server/ai/parse.ts`.
- **Behaviour:** `extractJson` does not exist (canon §11). On a parse failure: **one** repair
  attempt through the operator channel, then `{code:'schema_invalid'}`.
- **RED:** `tests/unit/ai/no-extract-json.test.ts` — asserts the adapter source contains no
  substring-or-regex JSON recovery (a committed pattern list) and that a malformed response
  yields exactly one repair attempt and then `schema_invalid`.
- **Verify:** `npm run test:unit -- no-extract-json` → exit 0.

#### 4.7 Resilience, budget and idempotency

- **Files:** `src/server/ai/run.ts`, `migrations/0013_challenge.sql` (same file).
- **Behaviour:** Timeouts, a retry cap of **2** with structured backoff, request ids, and a
  token/cost budget **reserved in the same atomic statement that increments the call counter**,
  rejecting on the returned total — otherwise the dollar cap is decorative while the call
  counter is the only real limit. Per-minute and per-decision allowances are separate, so a
  legitimate five-lens run plus repairs is not rejected. `challenge_run_one_live` is unique over
  `(decision_revision_id, kind, lens) NULLS NOT DISTINCT` where status is in
  `('pending','succeeded','abstained')` — `UNIQUE` treats NULLs as distinct by default, so a
  partial index would not constrain `lens IS NULL` rows (V14). A **failed** run is retryable.
  The model call happens **outside** the write transaction; only the validated result is
  written, inside one. A failing call must not delete a draft, mutate a locked revision, or mark
  review complete.
- **RED (three):**
  1. `tests/integration/ai/budget.test.ts` — asserts a cost-exceeding run is rejected on the
     **returned total** from the same statement that incremented the counter, with two
     concurrent clients. Fails against a read-then-check budget.
  2. `tests/integration/ai/idempotency.test.ts` — asserts a second live run for the same
     `(revision, kind, lens)` is refused, that a `lens IS NULL` duplicate is **also** refused
     (V14), and that a `failed` run can be retried.
  3. `tests/integration/ai/failure-isolation.test.ts` — injects a timeout mid-run and asserts
     the draft, the locked revision and the review state are all unchanged.
- **Verify:** `npm run test:int -- ai` → exit 0.

#### 4.8 Challenge Review surface and the dispute path

- **Files:** `src/app/(app)/challenge/[decisionRevisionId]/page.tsx`,
  `src/server/challenge/respond.ts`.
- **Behaviour:** Five lens cards — legal, financial, ethical/equity, operational, community
  (FR-07). Each challenge shows the targeted passage or assumption, its `basis_type`
  (`fact`/`inference`/`hypothetical`/`value_judgment`), its `uncertainty` level including
  `insufficient_evidence`, the risk pathway and the limitations (FR-08). Every response is
  labelled **AI-generated formative analysis**; fixture-backed responses are labelled as
  fixtures. No impersonation of a real official or institution. The user may reply, disagree or
  flag the challenge incorrect; `flagged_incorrect` is **its own state, excluded from
  "addressed"**, and the disagreement is preserved (FR-09). NFR-08: on model failure the input
  is preserved and an honest retry state is shown, never a claim of successful feedback.
- **RED:** `tests/e2e/decision-loop.spec.ts` (second portion) — asserts five lens cards render,
  that a `flagged_incorrect` challenge is **not** counted as addressed, and that the
  `unavailable` mode path shows the retry state with the draft intact.
  Plus `tests/unit/challenge/addressed-count.test.ts` — asserts the addressed count excludes
  `flagged_incorrect`. Fails against a count of all responses.
- **Verify:** `npm run e2e -- decision-loop` → exit 0; `npm run test:unit -- addressed-count`
  → exit 0.

#### 4.9 Adversarial evaluation suite

- **Files:** `tests/adversarial/*.test.ts`, `tests/fixtures/adversarial/*`,
  `docs/ai-evaluation.md`.
- **Behaviour:** Prompt injection through scenario and source text; missing citations; invented
  legal authority; unapproved source id; contradictory case facts; sycophantic praise;
  stereotyping; unjustified certainty; **IDOR against another user's `decision_revision` and
  `challenge_run`, including through every view**; and a **pooled-identity leak across two
  sequential requests on one warmed client**. Structural defences are what is tested: role
  separation, generated boundary tokens, schema-constrained output, server-side
  post-validation, the citation whitelist. **No reliance on instructing the model to ignore
  instructions** (canon §7.4).
  Structural cases — schema violation, unapproved source, zero-citation gap, IDOR, identity
  leak — are **release blockers scored automatically**. Judgemental cases — sycophancy,
  stereotyping — go to the `docs/PRD.md` §12.3 reviewer-sample protocol and are **not** scored
  by this suite, because a fixture suite scored against responses we wrote ourselves verifies
  our validators, not the model. `docs/ai-evaluation.md` must say so plainly.
- **RED (two, both structural):**
  1. `tests/adversarial/idor.test.ts` — enumerates **every** view and table reachable by the
     app role and asserts user B cannot read user A's revision or run through any of them. Its
     positive control drops one view's `security_invoker` in a rolled-back transaction and
     asserts the leak appears (V11).
  2. `tests/adversarial/pooled-identity.test.ts` — two sequential requests for different users
     on one warmed pooled client; asserts the second sees only its own rows. Fails if
     `DISCARD ALL` or the eager context validation is missing.
- **Verify:** `npm run test:int -- adversarial` → exit 0.

### Acceptance checkpoint — Slice 4

| # | Observable condition |
|---|---|
| 1 | The full loop runs end to end with `ANTHROPIC_API_KEY` unset and `STATESMAN_AI_MODE=fixture` |
| 2 | Importing the fixture adapter under `NODE_ENV=production` rejects |
| 3 | Key presence alone never selects a mode; the provenance `CHECK` rejects the mismatched pair |
| 4 | The schema walker flags a planted raw `z.string()` leaf |
| 5 | An unapproved `claim_id` is rejected, and the direct-insert bypass is stopped by the composite FK |
| 6 | The V25 assertion holds and post-parse refinement violations are counted |
| 7 | No substring/regex JSON recovery exists in the adapter |
| 8 | The budget rejects on the returned total under two concurrent clients; a failed run is retryable; a `lens IS NULL` duplicate is refused |
| 9 | `flagged_incorrect` is excluded from the addressed count |
| 10 | IDOR is denied through every view, with the `security_invoker`-dropped positive control flipping it; the pooled-identity case is clean |
| 11 | Pass A and Pass B findings for this slice are recorded in `docs/reviews/slice-4.md` with `file:line`, severity, reproduction and fix; every critical or high finding is resolved and the affected gates rerun with before and after exit statuses |

**Complexity: XL** — the grounding chain, the budget atomicity and the adversarial suite each
carry their own control burden.

---

## 7. Slice 5 — Reflection and development

**Goal:** Five-dimension formative feedback with no single score, actions linked to the feedback
that caused them, a full evidence trail, and real export and deletion.

**Dependencies:** Slices 1–4 complete.

### Tasks

#### 5.1 `dimension_assessment` with the AI ceiling in the schema

- **Files:** `migrations/0014_assessment.sql`, `src/server/assessment/*`.
- **Behaviour:** `dimension`, `observed_level smallint check (observed_level between 0 and 4)`,
  `assessor_kind check (assessor_kind in ('ai','human_reviewer'))`, `evidence_quality`,
  `provisional_comment`, plus
  `constraint ai_never_awards_practice_levels check (assessor_kind <> 'ai' or observed_level <= 2)`.
  The full 0–4 domain stays in the database; **the AI is constrained, not the product**
  (canon §5.1). A trigger additionally forbids any AI-path update of a `human_reviewer` row.
- **RED:** `tests/integration/assessment/ai-ceiling.test.ts` — asserts an `ai` row with
  `observed_level = 3` raises, that a `human_reviewer` row with `observed_level = 4` is
  accepted, and that an AI-path update of a `human_reviewer` row raises. The middle assertion
  fails against a schema that caps the column itself.
- **Verify:** `npm run test:int -- ai-ceiling` → exit 0.

#### 5.2 Grounded observations

- **Files:** `migrations/0014_assessment.sql` (same file).
- **Behaviour:** `assessment_observation` with quoted anchors, and
  `assessment_observation_source_claim` closing the grounding chain for the assessment path
  (canon §7.3 item 3). Each rated dimension carries observations, evidence anchors, evidence
  quality and limitations — and **no aggregate** (FR-10).
- **RED:** `tests/integration/assessment/observation-grounding.test.ts` — asserts an
  observation citing an unapproved claim id cannot be persisted, by composite FK.
- **Verify:** `npm run test:int -- observation-grounding` → exit 0.

#### 5.3 Reflection

- **Files:** `migrations/0015_reflection.sql`,
  `src/app/(app)/reflect/[decisionId]/page.tsx`.
- **Behaviour:** The Screen D content of `docs/PRD.md` §5.4: five dimensions with evidence level
  and confidence indicator, strengths, issues, and an explicit visual distinction between **AI
  formative feedback** and **human validation**. `reflected_at` is set through the transition
  trigger of task 3.2, never by a direct timestamp write.
- **RED:** `tests/e2e/decision-loop.spec.ts` (third portion) — asserts the five dimensions
  render with evidence quality, that the AI-vs-human labelling is present, and that no element
  displays a combined or averaged score.
- **Verify:** `npm run e2e -- decision-loop` → exit 0.

#### 5.4 Development actions linked to their origin

- **Files:** `migrations/0016_development_action.sql`,
  `src/server/development/*`, `src/app/(app)/actions/*`.
- **Behaviour:** `description`, `owner`, `due_date`, `status`, `completion_evidence`,
  `completed_at`, `origin_challenge_id`, `origin_dimension_assessment_id`,
  `reassessment_decision_id`. FR-11 requires the link to the originating feedback; FR-12
  requires **both** attempts to remain visible after a reassessment. Action-state changes write
  audit events.
  `status` carries a **transition whitelist**, enforced by a `BEFORE UPDATE` trigger in the same
  migration: `open → in_progress → completed`, `open → cancelled`, `in_progress → cancelled`,
  and `completed → open` only through an explicit reopen that records a reassessment. Anything
  else raises an uppercase custom SQLSTATE (V13). `MASTER_PROMPT.md` §9's unit list names
  "action state transitions" alongside the decision state machine; leaving this column
  unconstrained would make it the one state in the product that fails unpredictably.
  `completed` additionally requires `completion_evidence` to be non-null and `completed_at` to
  be set, so a completion claim cannot be recorded without its evidence.
- **RED (three):**
  1. `tests/integration/development/origin-link.test.ts` — asserts an action with neither
     `origin_challenge_id` nor `origin_dimension_assessment_id` is rejected.
  2. `tests/integration/development/reassessment.test.ts` — after a reassessment, asserts both
     the original and the new decision remain readable and linked. Fails against an
     implementation that repoints the action.
  3. `tests/integration/development/status-transitions.test.ts` — asserts a rejected pair
     (`completed → in_progress`, and `open → completed` skipping `in_progress`) raises the
     expected uppercase SQLSTATE, with the **legal-transition control** in the same test
     (`open → in_progress → completed` with evidence succeeds). Also asserts `completed`
     without `completion_evidence` raises. A rejection-only test passes against a trigger that
     rejects every update.
- **Verify:** `npm run test:int -- development` → exit 0.

#### 5.5 History and the evidence trail

- **Files:** `src/app/(app)/history/page.tsx`,
  `src/app/(app)/history/[decisionId]/page.tsx`, `src/server/history/trail.ts`.
- **Behaviour:** A usable simple list (FR-06 search/filter is DEFERRED to P1) where each record
  reconstructs the exact scenario version, the original locked response, later revisions, the
  generated challenges, the model and prompt version, the human responses, the reflection, the
  action and the timestamps (FR-15). Navigation runs **action → challenge → decision version →
  case sources**. Any view introduced for this is created
  `WITH (security_invoker = true)` (V11) and is covered by posture rule 5 and the task 4.9 IDOR
  enumeration.
- **RED:** `tests/e2e/decision-loop.spec.ts` (fourth portion) — from a development action,
  navigate to the challenge, then the decision revision, then the case source, asserting each
  hop displays the pinned version identifiers. Plus
  `tests/integration/history/view-posture.test.ts` — asserts every view the trail uses has
  `security_invoker = true`.
- **Verify:** `npm run e2e -- decision-loop` → exit 0; `npm run test:int -- view-posture` → exit 0.

#### 5.6 Export

- **Files:** `src/app/api/export/route.ts`, `src/server/export/build.ts`.
- **Behaviour:** Real, usable JSON covering decisions, revisions, challenges, responses,
  reflections, actions and audit rows (FR-16, NFR-09), in a documented schema. The route is a
  Route Handler and therefore depends on the O2 settlement (task 6.4) for session resolution —
  it must not rely on `cache()` outside a render context until that is settled. An
  `export_requested` audit row is written.
- **RED:** `tests/integration/export/completeness.test.ts` — builds a full loop for user A and
  one for user B, exports as A, and asserts the payload deep-equals the expected A-only object
  **and** contains no identifier belonging to B. A presence-only assertion is not accepted.
- **Verify:** `npm run test:int -- export` → exit 0.

#### 5.7 Deletion

- **Files:** `migrations/0017_erase_self.sql`, `src/app/api/account/delete/route.ts`,
  `src/app/(app)/privacy/page.tsx`.
- **Behaviour:** `app.erase_self()` derives identity internally and **never takes a uuid** (V2);
  enumerates owner columns from a **single shared classification**; writes the `account_deleted`
  audit row with `actor_user_id IS NULL`; **resets its erasure flag explicitly** because
  `set_config(…, true)` inside a function carrying a `SET` clause persists after return (V17);
  and guards on `pg_trigger_depth() > 1 AND current_setting('app.erasure', true) = 'on'`
  **together**, because depth alone cannot distinguish authorised erasure from an ops mistake
  (V16). `on delete restrict` from `app_user` means the audit history survives (NFR-03, FR-16).
  The privacy notice states the real retention behaviour **including backups**, with **no
  immediate-erasure promise**.
  FR-16 carries a `manual` verification leg (canon §12.3): the wording of that notice is read by
  a person, not a command. Its evidence record is `docs/reviews/retention-notice.md` (named in
  task 0.10), the traceability row references it, and FR-16 reaches at most `NOT RUN` in the
  volatile report until the record exists and states what was read against what. No sign-off
  name and no date is invented.
- **RED (three):**
  1. `tests/integration/deletion/erase-self.test.ts` — asserts a plain owner-typed parent
     `DELETE` without the erasure flag is **refused**, and that `erase_self()` succeeds.
  2. same file — asserts `current_setting('app.erasure', true)` is **not** `'on'` after
     `erase_self()` returns (V17). Fails without the explicit reset.
  3. same file — asserts the `account_deleted` audit row exists with `actor_user_id IS NULL`
     and that it survived the deletion.
- **Verify:** `npm run test:int -- deletion` → exit 0.

#### 5.8 No composite score, enforced

- **Files:** `tests/unit/ui/no-composite-score.test.ts` (extended from task 3.6).
- **Behaviour:** Extend the deny-list to the assessment and reflection surfaces: no readiness,
  character, viability, overall, total or averaged score anywhere in schema, API response or
  UI (canon §1.2, `docs/PRD.md` §1.4 principle 7, FR-10).
- **RED:** the test's own positive control — plant a `readiness_score` field in a copy of the
  API response type and assert the checker reports it.
- **Verify:** `npm run test:unit -- no-composite-score` → exit 0.

#### 5.9 Scenario-version pinning, controlled (INV-07)

- **Requirement:** **INV-07** (a submitted decision's trail resolves the scenario version it was
  submitted against), covering FR-02 and FR-15. Read together with task 5.5, whose trail
  assertions it makes meaningful.
- **Files:** `tests/support/publish-scenario-version.ts`,
  `tests/integration/history/version-pinning.test.ts`.
- **No migration.** Reference tables carry no app grants, so v2 is published through the
  **migrator path** by a test-support helper inside the worker's own cloned database — not by a
  committed seed migration, which would ship a second published version to every environment and
  change which version a new draft is opened against. `withUser` cannot do it and must not be
  given the grant to.
- **Behaviour:** Pinning is enforced structurally by the composite FK of task 3.3, and task
  5.5's trail asserts that each hop *displays* pinned version identifiers. Neither publishes a
  second version, so neither can distinguish a pinned trail from a product that has only ever
  had one version to resolve. This task supplies the control canon §8.7 requires for a critical
  invariant: publish `scenario_version` **v2** for the seeded scenario **after** a decision has
  been submitted against v1, then assert the decision, its revisions and its challenges all
  still resolve **v1**.
  The second assertion is what makes the first mean anything: assert as a **positive control**
  that v2 is independently readable by the same user. Without it, a test passes identically when
  v2 was never published, when the publish silently failed, and when v2 is unreachable for an
  unrelated reason.
- **RED:** the pair, in one test. Fails against an implementation that resolves "latest
  version" anywhere in the trail — which is the defect this exists to catch, and which is
  invisible until a second version exists.
- **Verify:** `npm run test:int -- version-pinning` → exit 0.

### Acceptance checkpoint — Slice 5

| # | Observable condition |
|---|---|
| 1 | An `ai` assessment at level 3 raises; a `human_reviewer` row at level 4 is accepted |
| 2 | An AI-path update of a `human_reviewer` row raises |
| 3 | An observation citing an unapproved claim id cannot be persisted |
| 4 | An action with no origin link is rejected; after reassessment both attempts remain visible |
| 5 | The trail navigates action → challenge → revision → source with pinned version ids at every hop |
| 6 | Every view the trail uses has `security_invoker = true` |
| 7 | The export deep-equals the expected object and contains no other user's identifiers |
| 8 | A depth-2 owner `DELETE` without the flag is refused; `erase_self()` leaves the flag off |
| 9 | The `account_deleted` audit row survives with `actor_user_id IS NULL` |
| 10 | The composite-score checker reports a planted score field |
| 11 | A rejected action-status pair raises; the legal path `open → in_progress → completed` with evidence succeeds; `completed` without evidence raises |
| 12 | With `scenario_version` v2 published after submission, the trail still resolves v1 **and** v2 is independently readable (INV-07) |
| 13 | FR-16's manual verification leg names its evidence record, and the requirement reads no better than `NOT RUN` in the volatile report until that record exists |
| 14 | Pass A and Pass B findings for this slice are recorded in `docs/reviews/slice-5.md` with `file:line`, severity, reproduction and fix; every critical or high finding is resolved and the affected gates rerun with before and after exit statuses |

**Complexity: L** — wide surface, but it reuses Slice 1's authorization machinery rather than
extending it.

---

## 8. Slice 6 — Hardening and UX

**Goal:** Make each remaining gate demonstrably able to fail, build the four controls canon §12.1
lifts out of `UNDESIGNED` into P0 scope, settle O2 by command, and close the operational
documentation.

**Dependencies:** Slices 0–5 complete.

> The four canon §12.1 controls are tasks 6.11 (CSRF origin verification), 6.12 (log and
> telemetry redaction), 6.6 (stored-XSS rendering through one escaping component plus a CSP) and
> 6.13 (NFR-10 source status and archival). Task 6.14 delivers FR-19. None of them is optional
> hardening: each is a P0 requirement or a threat-model control with no other home.

### Tasks

#### 6.1 `/__a11y-canary` and the two gate positive controls

- **Files:** `src/app/__a11y-canary/page.tsx`, `tests/e2e/a11y.spec.ts`,
  `tests/e2e/responsive.spec.ts`, `tests/e2e/canary.spec.ts`.
- **Requirement:** NFR-05 (WCAG 2.2 AA target) and NFR-04 (primary flow usable on a small
  phone screen) are gated here; this task makes those gates capable of failing.
- **Behaviour:** A route mounted **only** under `E2E_FAULTS=1`, carrying a known **serious** axe
  violation and a 400px fixed-width block. The axe gate and the 320px overflow detector must
  **fail** on it. A gate that has never been shown to fail has not been shown to work
  (canon §8.5).
- **RED:** `canary.spec.ts` — runs both gates against the canary with `E2E_FAULTS=1` and
  asserts **each reports a failure**. Fails if either gate passes the canary, which is the
  defect this task exists to catch.
- **Verify:** `E2E_FAULTS=1 npm run e2e -- canary` → exit 0 (the spec asserts the failures);
  `npm run e2e -- a11y responsive` → exit 0 with the canary route absent.

#### 6.2 Focus indication asserted as a difference

- **Files:** `tests/e2e/focus.spec.ts`.
- **Behaviour:** Focus visibility is asserted as a **difference** between focused and blurred
  computed styles **plus** a ≥3:1 contrast ratio. A presence check on `outlineStyle` can never
  fail, because UA stylesheets give `:focus-visible` elements `outline-style: auto` regardless
  of the author's CSS (canon §8.5).
- **RED:** the spec's own control — a test fixture with author focus styling removed must
  **fail** the difference assertion while still reporting `outline-style: auto`.
- **Verify:** `npm run e2e -- focus` → exit 0.

#### 6.3 AST import-boundary check

- **Files:** `scripts/check-import-boundaries.ts`,
  `tests/unit/tooling/import-boundary.test.ts`.
- **Behaviour:** The `pg` package may be imported only within `src/server/db/**`. The checker
  walks the TypeScript API and sees **static imports, `require` and dynamic `import()`**.
  `no-restricted-imports` matches the specifier string, not the resolved path, and a grep for
  `new Pool(` is evaded by an alias — neither is sufficient alone (canon §6.1). The same
  checker bans `as AuthenticatedSession` and `as UserScopedClient`, because a brand is erasable
  with one assertion.
- **RED:** `import-boundary.test.ts` — four planted fixtures outside `src/server/db`: a static
  import, a `require`, a dynamic `import()`, and an aliased re-export; plus one `as
  UserScopedClient` assertion. Asserts the checker reports **all five**. A checker that catches
  only the static import fails this test.
- **Verify:** `npm run ast:imports` → exit 0; `npm run test:unit -- import-boundary` → exit 0.

#### 6.4 Settle open item O2 empirically

- **Files:** `scripts/probe-cache-identity.ts`, `src/server/auth/resolve-per-handler.ts`, the
  **session-resolution ADR** (number allocated per task 0.1 and entered in
  `docs/adr/RESERVED.md` from the moment this plan cites it; this plan has been citing it as
  ADR-0012).
- **Behaviour:** React `cache()` outside a render context — used for session resolution in Route
  Handlers, including the export route that dumps a full journal — is **settled by command
  before being relied on** (canon O2): put a `randomUUID()` in the uncached implementation and
  fire **two concurrent requests**; the ids must differ. If they do not, resolve per handler
  explicitly and remove `cache()` from that path. Record the observed output and the installed
  Next.js version in that ADR. Until this task completes, task 5.6's export route resolves the
  session explicitly per handler.
- **RED:** `tests/integration/auth/route-handler-identity.test.ts` — two concurrent requests
  for **different** users against the export route; asserts each response contains only its own
  user's identifiers. Fails if a cached resolution is shared across requests.
- **Verify:** `npm run probe:cache-identity` → exit 0 and prints two **different** uuids;
  `npm run test:int -- route-handler-identity` → exit 0.

#### 6.5 Migration lint

- **Files:** `scripts/lint-migrations.ts`.
- **Behaviour:** Reject an unmatched `alter table … no force` within a migration file —
  backfills must bracket `no force`/`force` in the same file (V8, canon §4.4 and §10). Also
  reject a lowercase custom SQLSTATE literal (V13) and a `create view` without
  `security_invoker` (V11), as cheap static backstops to posture rules 5 and 8.
- **RED:** `tests/unit/tooling/migration-lint.test.ts` — three planted fixtures (unmatched
  `no force`, lowercase SQLSTATE, view without `security_invoker`); asserts all three are
  reported.
- **Verify:** `npm run migration:lint` → exit 0; `npm run test:unit -- migration-lint` → exit 0.

#### 6.6 Stored-XSS rendering through one escaping component, plus the CSP

> **The CSP half is delivered, by a different mechanism than this task specifies.** Setting it in `next.config.ts` has no mechanism under `output: 'export'` — there is no server to send a header, as that file's own comment at line 93 states — and a RED test asserting a response header deep-equals a map could never pass. Delivered instead as a `<meta http-equiv>` tag with per-file sha256 hashes, injected post-build by `scripts/csp.mjs` and gated by `npm run csp:check` in `pages.yml`. See [ADR-0020](adr/ADR-0020-csp-as-a-meta-tag-with-per-build-hashes.md), which also owns the directive map that no document previously owned.
>
> **Still outstanding from this task: 6.6a**, the single escaping component and its AST rendering-boundary checker. The CSP is the second layer; `freeText` not rejecting HTML metacharacters is why the first one is load-bearing.

- **Requirement:** Canon §12.1 item 3 — the threat model's stored-XSS control, in P0 scope.
- **Files:** `next.config.ts`, `src/app/error.tsx`, `src/app/not-found.tsx`,
  `src/components/rendered-text.tsx`, `scripts/check-rendering-boundary.ts`,
  `tests/e2e/security-headers.spec.ts`, `tests/integration/rendering/xss.test.ts`,
  `tests/unit/tooling/rendering-boundary.test.ts`.
- **Behaviour:** **All** journal text and **all** model output is rendered through one
  component, `src/components/rendered-text.tsx`, which escapes; nothing else renders untrusted
  text. Content-Security-Policy and the other headers of `MASTER_PROMPT.md` §8 are set in
  `next.config.ts`. Safe error pages disclose no internals. The custom SQLSTATEs of task 3.2
  map to distinct HTTP statuses, so a 409 is never reported as a 404.
  **The residual is stated, not glossed:** the `freeText` factory of task 4.3 rejects URIs and
  control characters but **not** HTML metacharacters. Escaping at render is therefore
  **load-bearing** — it is the control, not defence in depth — and the CSP is the second layer
  behind it, not the first. That is why the boundary is enforced by a checker rather than by
  convention: one component that forgets to escape is a stored-XSS hole, and there is nothing
  upstream that would have stripped the payload.
- **RED (three):**
  1. `tests/integration/rendering/xss.test.ts` — stores `<img src=x onerror=…>` in a journal
     field **and** in a fixture challenge body, renders both, and asserts the markup appears as
     **text** in each.
  2. `tests/unit/tooling/rendering-boundary.test.ts` — the checker walks the TypeScript API and
     reports any `dangerouslySetInnerHTML`, and any render of a journal or model-output field
     that does not pass through `rendered-text.tsx`. Three planted fixtures: a
     `dangerouslySetInnerHTML`, a direct interpolation of a journal field, and a direct
     interpolation of a challenge body. Asserts all three are reported. A checker that only
     greps for `dangerouslySetInnerHTML` fails this test.
  3. `security-headers.spec.ts` — asserts the response header set **deep-equals** the expected
     map, including the CSP directives, and that the CSP is not report-only.
- **Verify:** `npm run e2e -- security-headers && npm run test:int -- xss &&
  npm run test:unit -- rendering-boundary` → exit 0.

#### 6.7 Traceability tooling and `gates:selftest`

- **Files:** `scripts/trace-check.ts`, `reporters/vitest-tags.ts`,
  `reporters/playwright-tags.ts`, `scripts/gates-selftest.ts`,
  `tests/fixtures/gates/*`.
- **Behaviour:** Coverage is matched by **structural tags** emitted by custom Vitest and
  Playwright reporters into `reports/tags-*.json` — never by parsing concatenated test titles,
  which is silently empty for every `it.each` test (canon §8.6). Requirement ids come from
  `docs/requirements.yaml`; the count in the committed document is generated from it.
  `npm run trace:check` diffs **only** the deterministic committed file, which carries no
  timestamp — embedding a generation timestamp makes `--check` unpassable by construction.
  A requirement is `PASS` only if a tagged test exists, **ran**, and passed; **unexecuted is
  `NOT RUN`, never `PASSED`**. `gates:selftest` fixtures assert **deep equality against an
  expected per-requirement object**, not an exit code — five fixtures asserting only
  `code === 2` let a checker that returns 0/2 pass seven of ten.
  `reports/` is gitignored; no credentials are written to any handoff file.
- **RED (three):**
  1. `tests/unit/tooling/tags-reporter.test.ts` — an `it.each` suite; asserts the reporter
     emits one tag per **case**. Fails against title parsing.
  2. `tests/unit/tooling/trace-check.test.ts` — a requirement with a tagged test that did not
     run; asserts the status is `NOT RUN` and `trace:check` exits non-zero if the committed
     document claims otherwise.
  3. `scripts/gates-selftest.ts` fixtures — ten fixtures asserting deep-equal per-requirement
     objects; a checker that returns the right exit code with the wrong per-requirement map
     must fail.
- **Verify:** `npm run trace:check` → exit 0; `npm run gates:selftest` → exit 0.

#### 6.8 Dependency audit and secret scanning

- **Files:** `package.json` scripts, `scripts/secret-scan.ts` or the tool confirmed available
  in Slice 0 (O4 — settled by command, never assumed).
- **Behaviour:** The secret scan runs **before and after** the test gates, so generated
  artefacts are covered (canon §8.7). The dependency audit **blocks on any `high` or `critical`
  advisory in production dependencies**; `moderate` and `low` are recorded in
  `docs/gap-register.md` and do not block. The threshold is stated in `CLAUDE.md` and recorded
  in `docs/decisions.md`, not left to live only in the script's flags — a blocking gate whose
  threshold is defined nowhere is passed at discretion (canon §12.2).
- **RED:** `tests/unit/tooling/secret-scan.test.ts` — plants a fake credential in a generated
  `reports/` artefact and asserts the **post-test** scan reports it. Fails against a pre-test-only
  scan.
- **Verify:** `npm run secrets` → exit 0 on a clean tree.

#### 6.9 Resilience and full-journey E2E

- **Files:** `tests/e2e/decision-loop.spec.ts`, `tests/e2e/keyboard.spec.ts`,
  `tests/e2e/mobile.spec.ts`, `tests/e2e/resilience.spec.ts`.
- **Behaviour:** The complete P0 journey of `MASTER_PROMPT.md` §5 in one spec: new account →
  Today → scenario → draft/save/reload → submit → challenge → respond/flag → reflect → create
  action → history → export. Plus a keyboard-only path, the 320px viewport (**NFR-04**;
  no horizontal overflow), accessible labels and contrast (**NFR-05**), a model-failure retry
  path, a browser refresh **after** submission, and the error/empty/loading states.
- **RED:** `resilience.spec.ts` — refresh immediately after submission and assert exactly one
  revision exists; interrupt the network mid-AI-call and assert the draft and locked revision
  are intact with an honest retry state shown.
- **Verify:** `npm run e2e` → exit 0.

#### 6.10 README, runbook and the candid gap register

- **Files:** `README.md`, `docs/gap-register.md`.
- **Behaviour:** Setup, credentials, seed, run, test, release, backup and limitations, plus
  `.env.example`, migrations, CI, ADRs, AI-evaluation instructions and the threat model
  (`MASTER_PROMPT.md` §12 item 8). Backup is `pg_dump` **as the bootstrap superuser** — a
  non-superuser owner dump under `FORCE` fails with rc=1, so the silently-empty-backup hazard
  does not exist (V10). The runbook carries `brew services start postgresql@17` (V26) and
  `export LC_ALL=en_US.UTF-8` (V27). `docs/gap-register.md` lists every open item honestly,
  including O1 (no encryption-at-rest mechanism; FileVault locally, a managed or encrypted
  volume on any deploy) as an **open release item, not a met requirement**.
- **RED:** `tests/unit/docs/readme.test.ts` — asserts the README contains every gate command in
  §11 verbatim and that each resolves to a script in `package.json`. Fails on a drifted command.
- **Verify:** `npm run docs:check` → exit 0.

#### 6.11 CSRF origin verification — **RETIRED, superseded by ADR-0019**

> **This task is closed by a decision, not by an implementation.** ADR-0015 removed the server
> request boundary origin verification is defined against, so every file and command named below
> pointed at something absent: `src/server` does not exist, `grep -rl 'use server' src/` returns
> 0 files, no `route.ts` exists anywhere under `src/`, `next.config.ts` pins `output: 'export'`,
> there is no cookie, and there is no `e2e` script or Playwright config. The paths below are
> struck rather than quietly ignored, because this document owns file layout and a later reader
> would otherwise create `src/server/**` to satisfy it.
>
> What was built instead is the enforcement of the precondition —
> `tests/unit/no-server-surface.test.ts`, which fails the unit gate if a Server Action, Route
> Handler, `middleware.ts` or non-export config appears, and which was **measured** failing on the
> real tree. `T-46` is `NOT_APPLICABLE`; `TC-SEC-046` is re-pointed, not deleted; the residuals
> origin verification never covered are now `R-23` (clickjacking — unbuildable on GitHub Pages)
> and `R-24` (`detectSessionInUrl` session fixation). See
> [ADR-0019](adr/ADR-0019-retire-csrf-origin-verification.md) and `docs/decisions.md` D15.

- **Requirement:** Canon §12.1 item 1 — the threat model's CSRF control, in P0 scope; NFR-01.
- **Files:** ~~`src/server/http/verify-origin.ts`, `src/server/http/action-guard.ts`,
  `src/middleware.ts`, `tests/e2e/csrf.spec.ts`,
  `tests/unit/http/verify-origin.test.ts`~~ — **struck: no server surface exists.** Replaced by
  `tests/unit/no-server-surface.test.ts` and `tests/unit/support/server-surface.ts`, plus
  `docs/adr/ADR-0019-retire-csrf-origin-verification.md` (the ADR canon §12.1 item 1 requires,
  discharged by recording that there is no mechanism to choose, and why).
- **Behaviour:** **Every** state-changing Server Action and Route Handler verifies the request
  origin server-side: the `Origin` header (falling back to `Referer` only where the browser omits
  `Origin`) must match the configured application origin, and a request with a missing or
  mismatched origin is rejected before any handler body runs. The guard is applied by one
  wrapper that every mutating entry point goes through, and a checker asserts no mutating route
  or action bypasses it — the same shape as task 6.3, because an opt-in guard is a guard that is
  one forgotten call site from absent.
  **`SameSite=Lax` is not the control.** It is a browser-side default that does not cover
  top-level navigations with side effects, does not apply to non-browser clients, and silently
  does nothing if a future cookie attribute changes. The ADR records that reasoning and the
  mechanism chosen, so the decision is not re-derived from memory later.
- **RED (two):**
  1. `tests/e2e/csrf.spec.ts` — a **cross-origin** state-changing request (submission, challenge
     response, action update, account deletion) carrying the session cookie, asserted to be
     rejected with no row written; with the **same-origin positive control** making the
     identical request and asserting it succeeds. The pair is the test: the rejection alone
     passes against a handler that is broken for everyone.
  2. `tests/unit/http/verify-origin.test.ts` — the bypass checker, with planted fixtures: a
     Route Handler exporting `POST` without the wrapper, and a Server Action file without it.
     Asserts both are reported.
- **Verify:** `npm run e2e -- csrf && npm run test:unit -- verify-origin` → exit 0.

#### 6.12 Log and telemetry redaction

- **Requirement:** Canon §12.1 item 2 — the threat model's redaction control, in P0 scope;
  NFR-03 and `MASTER_PROMPT.md` §6 ("no private content in application logs/telemetry").
- **Files:** `src/server/observability/field-classification.ts`,
  `src/server/observability/redact.ts`, `src/server/observability/logger.ts`,
  `tests/integration/observability/redaction.test.ts`.
- **Behaviour:** One **field classification** names every field as `public`, `internal` or
  `private`; journal text, model output, forecasts, rationales, tokens and connection strings
  are `private`. The logger is the only logging entry point and redacts `private` fields by
  classification, not by a regex over message strings — a regex catches the shapes someone
  thought of, and a new journal field added later is not one of them. Errors are logged by code
  and request id; the error's own message is passed through the same redaction.
- **RED (two):**
  1. `tests/integration/observability/redaction.test.ts` — runs a **full loop** (sign-in, draft,
     submit, challenge, respond, reflect, action, export) with every log and telemetry payload
     captured, and asserts that **no** journal field value, session token or connection string
     appears in any captured record. The field values are distinctive seeded strings, so a match
     is unambiguous.
  2. same file — the **positive control**: a deliberately-logging fixture that writes a journal
     field value straight to the logger, asserted to be **reported by the same assertion**. A
     capture harness that silently captures nothing passes part 1 and fails this.
- **Verify:** `npm run test:int -- redaction` → exit 0.

#### 6.13 NFR-10 source status and archival

- **Requirement:** **NFR-10** — "Source links stored with dates; broken/withdrawn sources
  flagged and cases reviewable or archived" (`docs/PRD.md` §11). Canon §12.1 item 4.
- **Files:** `migrations/0018_source_status.sql`, `src/server/content/source-status.ts`,
  `scripts/check-source-status.ts`,
  `tests/integration/content/source-status.test.ts`.
- **Behaviour:** `source` gains `status` with a check constraint over
  `('active','withdrawn','unreachable')`, defaulting to `active`, and `scenario_version` gains an
  **archival flag** with the date it was archived. Stored dates alone do not satisfy NFR-10: the
  PRD requires that a withdrawn or broken source be **flagged** and that the affected case be
  reviewable or archivable. The surface consequence is explicit — a case brief whose source is
  `withdrawn` or `unreachable` labels that source as such, and an archived `scenario_version`
  cannot be opened for a **new** decision while existing pinned trails continue to resolve it
  (task 5.9). Status is set by migration or seed; the app role keeps select-only grants on both
  tables.
- **RED (two):**
  1. `tests/integration/content/source-status.test.ts` — seeds one `withdrawn` source against
     the demo case and asserts `npm run sources:check` **reports it and exits non-zero**, and
     that the brief renders the withdrawn label. This is the CI assertion canon §12.1 item 4
     requires.
  2. same file — the control: with every source `active`, the same command exits 0 and the
     report is empty. A checker that always reports, or always exits 0, fails one half.
     Separately asserts an archived `scenario_version` is refused for a new decision **and**
     still resolves from an existing submitted decision's trail.
- **Verify:** `npm run sources:check` → exit 0 on an all-active tree;
  `npm run test:int -- source-status` → exit 0.

#### 6.14 FR-19 data-domain separation

- **Requirement:** **FR-19** (P0) — "No private journal content is public or accessible to later
  Pathway/Service products by default" (`docs/PRD.md` §6.1). This task exists because FR-19 was
  reachable by no task: the posture controls of 1.4 test the ten posture rules generically and
  4.9 tests cross-user IDOR, and neither tests FR-19's own clause — that **no route or surface
  exposes journal content without an authenticated owner session**.
- **Files:** `tests/integration/routes/unauthenticated-exposure.test.ts`,
  `scripts/enumerate-routes.ts`, `docs/gap-register.md` (the P1 Pathway/Service seam note).
- **Behaviour:** The mechanism is **grant-absence plus forced RLS** (canon §4.6, §4.3):
  `app_user`, `user_session` and `auth_attempt` carry no app grants at all, every user-owned
  table is RLS-enabled **and forced** with a tenancy policy, and `withUser` raises `28000`
  before a query runs when there is no user context (task 1.13). **Route omission is not a
  mechanism.** A surface that is private only because no one wired a route to it becomes public
  the moment someone does, and nothing in the build would notice.
  The route list is **enumerated from the filesystem** by `scripts/enumerate-routes.ts`, never
  hand-maintained: a hand-written list is exactly how a new route escapes the test. Every
  enumerated application route — pages, Route Handlers and Server Action endpoints, including
  `/api/export` and `/api/account/delete` — is requested with **no session cookie** and asserted
  to return a redirect to sign-in or `401`, with a body containing **no** journal field value.
  No separate Pathway or Service data domain exists in P0 and none is built (canon §1.2); the
  P0 obligation is that journal content is reachable only through an authenticated owner
  session, and the P1 seam note in `docs/gap-register.md` records that any future product
  crossing that boundary requires explicit, scoped, revocable authorization (canon O6).
- **RED (three):**
  1. `tests/integration/routes/unauthenticated-exposure.test.ts` — the unauthenticated sweep
     over every enumerated route, asserting redirect-or-401 **and** the absence of seeded
     journal field values in each body. Asserting the status alone is not accepted: a 200 page
     shell that lazily renders journal text, and a 401 body that helpfully echoes the record,
     both pass a status-only check.
  2. same file — the **positive control**: the same enumerated routes requested **with** a valid
     owner session return content, and the journal-bearing ones contain the seeded values. A
     sweep that passes because every route is broken, misrouted or renamed is the failure mode
     this control exists to catch.
  3. same file — the enumerator's own control: a planted route file under the app directory must
     appear in the enumerated set. A route the enumerator cannot see is a route the sweep never
     tests.
- **Verify:** `npm run test:int -- unauthenticated-exposure` → exit 0.

### Acceptance checkpoint — Slice 6

| # | Observable condition |
|---|---|
| 1 | Both the axe gate and the 320px detector **fail** on `/__a11y-canary` under `E2E_FAULTS=1`, and the canary route is absent otherwise |
| 2 | The focus assertion fails on a fixture with author focus styling removed |
| 3 | The import-boundary checker reports all five planted violations |
| 4 | The O2 probe printed two different uuids, or `cache()` was removed from the Route Handler session path; the session-resolution ADR records the observed output |
| 5 | The migration lint reports all three planted defects |
| 6 | Stored script markup renders as text in both journal fields and model output; the rendering-boundary checker reports all three planted violations; the CSP is present and not report-only |
| 7 | The tags reporter emits one tag per `it.each` case; an unexecuted requirement reads `NOT RUN` |
| 8 | `gates:selftest` fails a checker with the right exit code and the wrong per-requirement map |
| 9 | The post-test secret scan reports a credential planted in `reports/` |
| 10 | A cross-origin state-changing request is rejected and the same-origin control succeeds; the bypass checker reports both planted unguarded entry points |
| 11 | A full loop produces no log or telemetry record containing a journal field value, token or connection string, and the deliberately-logging fixture **is** reported by the same assertion |
| 12 | A seeded withdrawn source is reported by `npm run sources:check` with a non-zero exit, while an all-active tree exits 0; an archived `scenario_version` is refused for a new decision and still resolves from an existing trail |
| 13 | Every enumerated route returns redirect-or-401 with no journal field in the body when unauthenticated, returns content with a valid owner session, and the enumerator sees a planted route file (FR-19) |
| 14 | The full §11 pipeline exits 0 in order on a clean tree |
| 15 | Pass A and Pass B findings for this slice are recorded in `docs/reviews/slice-6.md` with `file:line`, severity, reproduction and fix; every critical or high finding is resolved and the affected gates rerun with before and after exit statuses |

**Complexity: XL** — fourteen gates, each needing its own demonstrated failure, the four canon
§12.1 controls, the FR-19 route sweep, the O2 experiment and the full-journey E2E.

---

## 9. P1 note

P1 work may enter **only** after every P0 gate in §11 has actually executed and §12 is fully
discharged, and with explicit scope approval (`MASTER_PROMPT.md` §10). Nothing below is planned
in this document beyond its seam.

| P1 item | PRD ref | Seam already in the P0 design |
|---|---|---|
| FR-06 curated case search/filter | §6.1 | `scenario` / `scenario_version` columns exist; the P0 history surface is a simple list |
| FR-13 reviewer sharing | §6.2 | DEFERRED with a recorded design: a `record_share` table (resource, grantee, scope, `expires_at`, `revoked_at`) with a policy unioning ownership and an unexpired unrevoked share. The MVP ships **no** global `role` column — a global role cannot express per-item scoped revocable sharing (canon O6) |
| FR-17 monthly review summary | §5.6, §6.3 | `audit_event` and the decision lineage make the counts recomputable from records |
| FR-18 local profile preferences | §6.3 | No profiling of voters or sensitive groups is permissible in any form |
| Extra cases (10–15) | §14.1 | The documented import pathway of task 2.5 |
| Crisis Room, Virtual Cabinet, Policy Lab, National Systems Atlas, Public Service Ledger, Strategic Pathway Studio, live news ingestion | §3.2 | Explicitly out of scope (canon §1.2); no speculative scaffolding is built |

---

## 10. Canon questions raised while planning

Raised here rather than resolved silently in the body, per the canon rule. Each needs a canon
amendment or a correction to this plan.

| # | Canon reference | Question |
|---|---|---|
| 1 | §4.8 rule 2 (ENUMERATION) | The rule offers two categories — "a version-controlled allowlist of global reference tables" or "RLS-enabled-and-forced". `app_user`, `user_session` and `auth_attempt` are neither: §4.6 relies on **grant-absence** and says `FORCE` would make user creation impossible. This plan implements the allowlist with an explicit second, grant-protected section that additionally asserts zero `statesman_app` privileges (task 1.4). The canon should name that category. |
| 2 | §6, privilege epoch vs. rehash-on-login | The epoch trigger has **no column list** and deletes the user's sessions on any `app_user` change other than `privilege_epoch`/`last_seen_at`. Rehash-on-login writes `password_hash` and `algo_ver` on that same request, so an unordered implementation logs the user out at the moment of a successful sign-in. This plan orders the rehash **before** `app.create_session` (task 1.14, RED test 5). The canon should state the ordering. |
| 3 | §8.1 sentinel seed vs. §4.3 `FORCE` | Sentinel rows are user-owned rows on `FORCE`d tables with a policy calling `app.require_user_id()`, which raises with no context. The canon does not say how the seed migration satisfies the policy. This plan sets `app.current_user_id` to the reserved uuid for the seed rather than bracketing `no force`/`force`, so the seed exercises the INSERT policy (task 1.9). |
| 4 | §6.1 `withMigrator(userId, …)` | §6.1 removes the identity parameter from `withUser` precisely because identity-as-argument type-checks when handed a victim's id, yet `withMigrator` keeps one — and §4.1 says the application connects **only** as `statesman_app`, while §8.3 routes test seeding through `withUser`. This plan treats `withMigrator` as reachable only from the migration runner and backfills, never from a request path, and task 6.3's AST check should probably enforce that. The canon should say what its `userId` is for. |

**Closed, no longer a question:** an earlier version of this plan recorded that canon §4.4
specified a `BEFORE UPDATE` trigger comparing `OLD.state → NEW.state`, which `NEW.<generated
column>` being NULL (E2) makes inert. Canon §4.4 as corrected specifies the design this plan
implements — one `IMMUTABLE` `app.derive_decision_state()` used by both the generated column and
the trigger, the trigger never reading `NEW.state`, and a meta-test over all 32 timestamp
combinations as the required control (V28, V29). E2 and E3 agree with V28 and V29. Task 3.2
carries it; there is nothing left to adjudicate.

---

## 11. Verification commands

The CI order of canon §8.7. **None of these has been run against this project** — there is no
project to run them against yet (E1).

| # | Command | Purpose | Blocking |
|---|---|---|---|
| 1 | `npm run typecheck` (`tsc --noEmit`, strict) | Type soundness | Blocking |
| 2 | `npm run lint` (`eslint`) | Lint, as **its own step** — `next build` may not be relied on to lint | Blocking |
| 3 | `npm run format:check` | Formatting | Blocking |
| 4 | `npm run ast:imports` | `pg` importable only in `src/server/db/**`; brand assertions banned (sees static, `require` and dynamic imports) | Blocking |
| 5 | `npm run secrets` (pre-test pass) | Secret scan before the test gates | Blocking |
| 6 | `npm run test:unit` | Unit suite | Blocking |
| 7 | `npm run db:bootstrap` | Cluster roles and revokes (first run / fresh cluster only) | Blocking |
| 8 | `npm run db:migrate` | Ordered `migrations/0*.sql` by lexical glob, posture check at end of run | Blocking |
| 9 | `npm run db:verify` | `app.verify_security_posture()` standalone (exit 1 on raise, E4) | Blocking |
| 10 | `npm run test:int` | Integration suite, **posture check as test #1** | Blocking |
| 11 | `npm run migration:lint` | Unmatched `no force`, lowercase SQLSTATE, view without `security_invoker` | Blocking |
| 12 | `npm run build` (`next build`) | Production build | Blocking |
| 13 | `npm run e2e` (Playwright + axe, chromium cached) | Browser journey, a11y and 320px gates | Blocking |
| 14 | `E2E_FAULTS=1 npm run e2e -- canary` | Positive controls: both gates must fail on `/__a11y-canary` | Blocking |
| 15 | `npm run coverage:check` | Vitest coverage with the **scoped** domain-service threshold below | Blocking |
| 16 | `npm run sources:check` | NFR-10: a withdrawn or unreachable source is reported (task 6.13) | Blocking |
| 17 | `npm run audit` | Dependency audit | Blocking on any `high` or `critical` advisory in production dependencies; the threshold is stated in `CLAUDE.md` and recorded in `docs/decisions.md` |
| 18 | `npm run secrets` (post-test pass) | Secret scan **after** the gates, covering generated artefacts | Blocking |
| 19 | `npm run gates:selftest` | Gate-checker self-test, deep-equal per-requirement objects | Blocking |
| 20 | `npm run trace:check` | Diff the deterministic committed traceability document | Blocking |
| 21 | `npm run probe:cache-identity` | O2 settlement probe | Non-blocking after the session-resolution ADR records the result; **blocking until it is recorded** |
| 22 | `npm run docs:check` | Documentation invariants (requirement ids, ADR references including `docs/adr/RESERVED.md`, review records, manual verification legs, registered paths, README command drift) | Non-blocking in CI; blocking for a release tag |

**NFR-07 is not in this list, and that is a decision, not an omission.** Core screen load ≤ 3s
is **DEFERRED** on the same honest basis as NFR-06: it is measurable only from pilot operation
on a representative connection, and no pre-release instrument for it exists in this plan. It is
recorded in `docs/decisions.md` and reads `DEFERRED` in the register. It may **not** read
`P0 / PLANNED` against an implementation path that no task creates (canon §12.2).

### 11.1 Coverage threshold — resolved

`MASTER_PROMPT.md` §9 asks for ">=85% meaningful coverage of domain services, 100% tested
critical invariants". Canon §8.7's "no global percentage target" does not discharge the first
half, because 85% scoped to domain services **is not** a global target. Both halves are
therefore configured, and the number is not left silent in either document:

- **Scoped threshold, enforced by `coverage:check`:** 85% statements and 85% branches over the
  domain-service directories — `src/server/decision/**`, `src/server/challenge/**`,
  `src/server/assessment/**`, `src/server/development/**`, `src/server/export/**`,
  `src/server/history/**`, `src/server/validation/**` — plus the security boundary
  `src/server/db/**` and `src/server/auth/**`. There is **no global percentage target**: a
  repository-wide number is met by testing whatever is cheapest, which is the behaviour canon
  §8.7 rejects.
- **100% of the canon §4.4 critical invariants**, asserted by tag through `trace:check`
  (task 6.7), not by line coverage. A line executed by a test with no assertion is covered and
  unverified; the invariant half of the gate is about assertions, so it is measured by tags.

Recorded in `docs/decisions.md` with this reasoning, per `MASTER_PROMPT.md` §0.2.

---

## 12. Go/no-go conditions

Every box is **unchecked**, because nothing has been implemented or executed. "Discharged by"
names the slice whose acceptance checkpoint closes the item; "Evidence" is empty by design and
must be filled with a command, its actual exit status and the artefact it produced — never with
a claim.

### 12.1 PRD §14.2 release conditions

| | Condition | Discharged by | Evidence |
|---|---|---|---|
| ☐ | **(a)** A pilot user can complete a full loop without assistance | Slice 6 task 6.9 | NOT RUN |
| ☐ | **(b)** Submitted decisions remain immutable and traceable | Slice 3 tasks 3.3, 3.4; Slice 5 task 5.5 | NOT RUN |
| ☐ | **(c)** All required citations and simulation labels are reliable | Slice 2 tasks 2.1–2.3; Slice 4 task 4.4 | NOT RUN |
| ☐ | **(d)** No critical authorization flaw or critical unsafe AI assertion remains open | Slice 1 tasks 1.4, 1.11; Slice 4 task 4.9; Slice 6 tasks 6.11, 6.12, 6.14 | NOT RUN |
| ☐ | **(e)** The user can recover from interrupted sessions | Slice 3 task 3.1; Slice 6 task 6.9 | NOT RUN |
| ☐ | **(f)** A reviewer can explain and reproduce the intended scoring logic | Slice 5 tasks 5.1–5.3; `docs/ai-evaluation.md` (task 4.9) | NOT RUN |

### 12.2 `MASTER_PROMPT.md` §12 definition of done

| | Condition | Discharged by | Evidence |
|---|---|---|---|
| ☐ | **1.** A fresh user can sign in and complete the full STATESMAN loop using actual persisted records | Slice 6 task 6.9 | NOT RUN |
| ☐ | **2.** Submitted snapshots stay immutable; all later changes are linked revisions | Slice 3 tasks 3.3, 3.4 | NOT RUN |
| ☐ | **3.** Cross-user reads/writes are denied in automated tests and checked at API/DB boundaries | Slice 1 task 1.11; Slice 4 task 4.9; Slice 6 tasks 6.11, 6.14 | NOT RUN |
| ☐ | **4.** Case/source/fiction boundaries and model-feedback labels display correctly; missing evidence produces abstention, not invented support | Slice 2 task 2.1; Slice 4 tasks 4.4, 4.8 | NOT RUN |
| ☐ | **5.** The user can resume drafts, survive model failures, view history, export records and initiate supported deletion | Slice 3 task 3.1; Slice 4 task 4.7; Slice 5 tasks 5.5–5.7 | NOT RUN |
| ☐ | **6.** Every P0 requirement has demonstrated passing acceptance evidence, or an explicit release block is declared | Slice 6 task 6.7 | NOT RUN |
| ☐ | **7.** Another reviewer has examined requirements and code; critical/high issues resolved and rerun | `MASTER_PROMPT.md` §11 Pass A and Pass B, as the **final row of each of the seven acceptance checkpoints**, recorded in `docs/reviews/slice-N.md` and gated by task 0.10 | NOT RUN — and not claimable by this session; no review has occurred |
| ☐ | **8.** The repository has a reliable README plus `.env.example`, migrations, CI, ADRs, AI-evaluation instructions and threat model | Slice 0 tasks 0.3–0.10; Slice 6 task 6.10 | NOT RUN |
| ☐ | **9.** No deployment to production or expenditure without explicit user authorization | Standing constraint; no deployment is planned in this document | Not applicable yet |

### 12.3 Declared open release items

These are **declared, not met**, and must appear in `docs/gap-register.md` at any release
decision:

| # | Item | Status |
|---|---|---|
| O1 | NFR-02 encryption at rest has no mechanism — Postgres has no TDE; FileVault locally, a managed or encrypted volume on any deploy | OPEN RELEASE ITEM |
| O2 | React `cache()` outside a render context in Route Handlers | OPEN until task 6.4 records the probe output in the session-resolution ADR |
| O3 | Node v25.5.0 is an odd-numbered line; declared `engines` accept it | NOTE — pin exact versions; verify async `cookies()` and `instrumentation.ts` against the installed release |
| O4 | Framework and library assertions | Each settled by command against installed tooling before use, never from memory; recorded in the ADR that cites it |
| O5 | Postgres is not brew-managed (V26) and needs `LC_ALL` (V27) | Documented in the runbook (task 6.10) |
| O6 | FR-13 reviewer sharing deferred; no global `role` column ships | DEFERRED with the `record_share` design recorded |
| §12.2 item 7 | Independent review | NOT DONE |
| NFR-06 | Pilot availability objective ≥99.5% monthly | **DEFERRED** — measurable only from pilot operation; no pre-release instrument exists. The PRD does not defer it, so the deferral is ours and is recorded in `docs/decisions.md` (canon §12.2) |
| NFR-07 | Core screen load ≤3s at a typical mobile connection | **DEFERRED** on the same basis, recorded in `docs/decisions.md`. No throttled performance budget spec is created by this plan, and NFR-07 appears in no §11 gate — see §11. It must not read `P0 / PLANNED` with an implementation path no task creates |
| Manual legs | FR-16 retention and backup disclosure; NFR-02 deployment encryption | Each reaches at most `NOT RUN` until its named evidence record exists and is referenced (task 0.10, canon §12.3). No sign-off name or date is invented |
