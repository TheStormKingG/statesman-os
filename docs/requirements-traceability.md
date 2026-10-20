# STATESMAN OS — Requirements Traceability

**Doc ID:** SOS-TRACE-001
**Canon:** `docs/superpowers/specs/2026-10-20-statesman-os-p0-mvp-design.md` (SOS-DESIGN-001)
**Requirements source:** `docs/requirements.yaml`
**PRD:** `docs/PRD.md` (SOS-PRD-001 v1.0)
**File layout of record:** `docs/implementation-plan.md`

> **Implementation state: no application code exists.** Nothing in this document has been
> executed. Every row describes intended design and intended verification. No row asserts
> that anything works.

**Register size — rendered from `docs/requirements.yaml`, not typed:** 29 requirements
(19 FR + 10 NFR), 11 critical invariants, 8 instrument gates,
64 threat and safety-rule rows. If this line disagrees with the YAML, `npm run trace:check`
fails; fix the YAML and re-render rather than editing the number here.

---

## 1. Why there are two artefacts

Canon §8.6 splits traceability in two, because one file cannot be both committed and
current:

| Artefact | Committed? | Contains | Changes when |
|---|---|---|---|
| `docs/requirements.yaml` | yes, deterministic | the single source of requirement, invariant, instrument and registered threat ids, with priority, PRD ref, acceptance condition, component, DB entities, verification method, implementation paths, covering test identities and design status | the design changes |
| `docs/requirements-traceability.md` (this file) | yes, deterministic | the same facts, rendered for reading | the design changes |
| `reports/trace.json`, `reports/traceability-run.md` | no, gitignored | per-requirement outcome per suite, commit sha, run metadata | every run |

This file therefore carries **no timestamp, no generation date and no per-run outcome**.
A generation timestamp in a committed file makes `npm run trace:check --check` unpassable
by construction: the file would differ from its own regeneration on every invocation.

Master prompt §3 item 2 asks this document for "status, and actual evidence". The two words
separate cleanly, and the amended canon §8.6 draws the line:

- **Status** here is a **design** status with the closed vocabulary `{PLANNED, DEFERRED}` —
  a design property of scope, stable between runs. The determinism test settles what may live in this
  file: would the value change if the same commit were checked twice without editing
  anything? `PLANNED` and `DEFERRED` would not.
- **Evidence** is per-run and therefore lives in `reports/trace.json`, whose vocabulary is
  `{PASS, FAIL, NOT RUN}`. **A run status is not representable in this file at
  all** — not `PASS`, not `FAIL`, and not `NOT RUN`.

---

## 2. How coverage is matched: the tag convention

Coverage is matched by **structural tags** that custom Vitest and Playwright reporters
write to `reports/tags-vitest.json` and `reports/tags-playwright.json`. Tags are **not**
parsed from test titles.

The reason is mechanical, not stylistic: `it.each` substitutes its parameters into the
title (`%s`, `%i`, `$name`), so a title written as `` `FR-04 ...` `` with any `it.each`
case produces a reported title that no longer contains the literal the matcher looks for.
Title matching then yields **zero** matches and reports it as zero coverage — or, worse,
silently matches nothing while the checker reports success. A structural channel read by
the reporter cannot be rewritten by test-name interpolation.

| Element | Convention |
|---|---|
| Requirement tag | `req:<ID>` — e.g. `req:FR-04`, `req:NFR-08` |
| Invariant tag | `inv:<ID>` — e.g. `inv:INV-01` |
| Instrument tag | `inv:<ID>` — e.g. `inv:INS-01` |
| Threat / safety-rule tag | `tc:<TC-SEC-id>` — e.g. `tc:TC-SEC-044` (§7) |
| Where tags are declared | per test, through a tagging helper, in a side channel the reporter reads — never in the test title |
| Where tags are collected | `reports/tags-vitest.json`, `reports/tags-playwright.json` (gitignored) |
| Multiplicity | many tests may carry one tag; one test may carry several tags; a requirement needs at least one |
| Drift guard | a tag in `reports/tags-*.json` that matches no id in `requirements.yaml` is an error, and an id with no tagged test is reported as uncovered |

The drift guard is why §7 exists. The threat model owns the `T-nn` and `TC-SEC-nnn`
namespaces (canon §12), and a test tagged `tc:TC-SEC-044` against an unregistered id is
rejected by the checker — so without registration, none of the threat model's test cases
could ever be matched to an executed test.

The exact reporter and tagging APIs (Vitest task metadata, Playwright annotations, or a
reporter-side registry) are **not asserted here**. Canon O4 requires every framework
assertion to be settled by command against the installed tooling before use, and no
tooling is installed yet. The constraint the implementation must satisfy is the one stated
above: the tag reaches the reporter through a channel that test-title interpolation cannot
alter.

---

## 3. Entity groups

`DB entities` cells below use these group tokens, defined once in `requirements.yaml`
(canon §5):

| Token | Tables |
|---|---|
| `$reference` | `scenario`, `scenario_version`, `source`, `scenario_claim`, `rubric_version`, `schema_migrations` |
| `$user_owned` | `decision`, `decision_revision`, `challenge_run`, `challenge`, `challenge_source_claim`, `challenge_response`, `dimension_assessment`, `assessment_observation`, `assessment_observation_source_claim`, `reflection`, `development_action`, `audit_event` |
| `$grant_protected` | `app_user`, `user_session`, `auth_attempt` |

---

## 4. Functional requirements

| ID | Priority | PRD ref | Acceptance condition | Component/service | DB entities | Verification | Status |
|---|---|---|---|---|---|---|---|
| FR-01 | P0 | §6.1 | User sees task, assumed role, timeline, available resources, missing information and topic before starting | Today (screen A) and Decision Desk (screen B) read path; scenario service | `scenario`, `scenario_version` | e2e, integration | PLANNED |
| FR-02 | P0 | §6.1 | Every factual scenario assertion is traceable to accessible source(s) or explicitly flagged as invented scenario data | Decision Desk source register; seeded scenario migration | `scenario_version`, `source`, `scenario_claim` | integration, e2e | PLANNED |
| FR-03 | P0 | §6.1 | Required decision fields are validated; incomplete drafts may be reopened without loss | Decision Desk form; draft persistence service | `decision` | unit, integration, e2e | PLANNED |
| FR-04 | P0 | §6.1 | Timestamped snapshot is saved; edits create a new revision, not a replacement | Submission transaction; revision service | `decision`, `decision_revision`, `audit_event` | integration, unit | PLANNED |
| FR-05 | P0 | §6.1 | User supplies 0–100% confidence plus a stated expected outcome and timeframe | Decision Journal submission fields | `decision_revision` | unit, integration, e2e | PLANNED |
| FR-06 | P1 | §6.1 | Search/filter by sector, geography, complexity and review status; default recommendation remains one case | deferred - no P0 surface | `scenario`, `scenario_version` | deferred | DEFERRED |
| FR-07 | P0 | §6.2 | Five required lenses appear; each references decision text, constraints or an identified information gap | Challenge Review (screen C); AI adapter | `challenge_run`, `challenge`, `decision_revision` | integration, e2e | PLANNED |
| FR-08 | P0 | §6.2 | Unsupported factual claims show uncertainty; no fabricated citations, statutes or institutional positions | Grounding gate; response validator; Challenge Review labels | `challenge`, `challenge_source_claim`, `scenario_claim`, `source` | integration, unit | PLANNED |
| FR-09 | P0 | §6.2 | User may reply, disagree or flag incorrect challenge; their disagreement is preserved | Challenge Review response form | `challenge_response`, `challenge` | integration, e2e | PLANNED |
| FR-10 | P0 | §6.2 | Each rated dimension includes observations, evidence anchors and limitations; no single readiness score | Reflection and Development (screen D); assessment service | `dimension_assessment`, `assessment_observation`, `assessment_observation_source_claim`, `rubric_version` | integration, unit, e2e | PLANNED |
| FR-11 | P0 | §6.2 | Action has description, owner, due date/status and link to originating feedback | Development Plan | `development_action`, `challenge`, `dimension_assessment` | integration, e2e | PLANNED |
| FR-12 | P0 | §6.2 | User can repeat a similar case or submit improved reasoning; both attempts remain visible | Revision service; History (screen E) | `decision_revision`, `development_action`, `decision` | integration, e2e | PLANNED |
| FR-13 | P1 | §6.2 | Reviewer only sees items selected for sharing; review author, date and status preserved | deferred - no sharing surface and no global role column in the MVP | — | deferred | DEFERRED |
| FR-14 | P0 | §6.3 | Unauthorized users cannot read any scenario response, journal or action | Session auth; withUser guard; RLS on every user-owned table | `$grant_protected`, `$user_owned` | integration, posture-check, e2e | PLANNED |
| FR-15 | P0 | §6.3 | User can navigate from an action to the challenge, decision version and case sources | History and evidence trail (screen E) | `development_action`, `challenge`, `decision_revision`, `scenario_version`, `scenario_claim`, `source` | integration, e2e | PLANNED |
| FR-16 | P0 | §6.3 | User can export records in portable format; deletion follows documented retention and backup rules | Export route; app.erase_self(); privacy notice | `$user_owned`, `$grant_protected` | integration, e2e, manual | PLANNED |
| FR-17 | P1 | §6.3 | Summary counts are recomputable from records; AI narrative is identified as interpretation | deferred - Monthly Review (screen F) not built | — | deferred | DEFERRED |
| FR-18 | P1 | §6.3 | User can set topic preferences and frequency without enabling voter or sensitive-group profiling | deferred - no preferences surface | — | deferred | DEFERRED |
| FR-19 | P0 | §6.3 | No private journal content is public or accessible to later Pathway/Service products by default | RLS posture; absence of any public or reviewer route | `$user_owned` | posture-check, integration | PLANNED |

### 4.1 Coverage map

Every path below is a file that a task in `docs/implementation-plan.md` creates. That
document owns migration filenames and the source/test layout (canon §12); this register
follows it, never the reverse. A path named here that no task creates is a defect.

| ID | Covering test tag | Implementation paths (planned) | Covering tests (planned) |
|---|---|---|---|
| FR-01 | `req:FR-01` | `src/app/(app)/today/page.tsx`, `src/app/(app)/desk/[scenarioVersionId]/page.tsx`, `src/app/(app)/scenario/[id]/page.tsx`, `src/server/content/scenario.ts` | `tests/integration/content/read-only.test.ts`, `tests/e2e/decision-loop.spec.ts` |
| FR-02 | `req:FR-02` | `migrations/0004_reference_tables.sql`, `migrations/0009_seed_demo_ph_001.sql`, `content/sources.json`, `src/server/content/scenario.ts` | `tests/unit/content/fiction-labels.test.ts`, `tests/unit/content/source-register.test.ts`, `tests/unit/content/claim-coverage.test.ts`, `tests/integration/content/read-only.test.ts` |
| FR-03 | `req:FR-03` | `migrations/0010_decision.sql`, `src/server/decision/draft.ts`, `src/app/(app)/desk/[scenarioVersionId]/page.tsx` | `tests/integration/decision/draft.test.ts`, `tests/e2e/decision-loop.spec.ts` |
| FR-04 | `req:FR-04` | `migrations/0010_decision.sql`, `migrations/0011_decision_state.sql`, `migrations/0012_submit.sql`, `src/server/decision/submit.ts`, `src/server/decision/append-revision.ts` | `tests/integration/decision/submit.test.ts`, `tests/integration/decision/append-revision.test.ts`, `tests/integration/decision/state.test.ts` |
| FR-05 | `req:FR-05` | `migrations/0012_submit.sql`, `src/server/decision/submit.ts`, `src/app/(app)/desk/[scenarioVersionId]/page.tsx` | `tests/integration/decision/submit.test.ts`, `tests/e2e/decision-loop.spec.ts` |
| FR-06 | `req:FR-06` | — | — |
| FR-07 | `req:FR-07` | `migrations/0013_challenge.sql`, `src/server/ai/adapter.ts`, `src/server/ai/fixture-adapter.ts`, `src/server/ai/mode.ts`, `src/server/ai/run.ts`, `src/app/(app)/challenge/[decisionRevisionId]/page.tsx` | `tests/unit/ai/fixture-adapter.test.ts`, `tests/unit/ai/mode.test.ts`, `tests/integration/ai/provenance-check.test.ts` |
| FR-08 | `req:FR-08` | `migrations/0013_challenge.sql`, `src/server/ai/grounding.ts`, `src/server/ai/schemas/challenge.ts`, `src/server/ai/schemas/free-text.ts`, `src/server/ai/validate.ts`, `src/server/ai/parse.ts` | `tests/integration/ai/grounding.test.ts`, `tests/unit/ai/schema-walk.test.ts`, `tests/unit/ai/refinements.test.ts`, `tests/unit/ai/no-extract-json.test.ts` |
| FR-09 | `req:FR-09` | `migrations/0013_challenge.sql`, `src/server/challenge/respond.ts`, `src/app/(app)/challenge/[decisionRevisionId]/page.tsx` | `tests/unit/challenge/addressed-count.test.ts`, `tests/e2e/decision-loop.spec.ts` |
| FR-10 | `req:FR-10` | `migrations/0014_assessment.sql`, `src/server/assessment/*`, `src/app/(app)/reflect/[decisionId]/page.tsx` | `tests/integration/assessment/ai-ceiling.test.ts`, `tests/integration/assessment/observation-grounding.test.ts`, `tests/unit/ui/no-composite-score.test.ts` |
| FR-11 | `req:FR-11` | `migrations/0016_development_action.sql`, `src/server/development/*`, `src/app/(app)/actions/*` | `tests/integration/development/origin-link.test.ts` |
| FR-12 | `req:FR-12` | `migrations/0012_submit.sql`, `migrations/0016_development_action.sql`, `src/server/decision/append-revision.ts`, `src/app/(app)/history/[decisionId]/page.tsx` | `tests/integration/development/reassessment.test.ts`, `tests/integration/decision/append-revision.test.ts` |
| FR-13 | `req:FR-13` | — | — |
| FR-14 | `req:FR-14` | `migrations/0002_verify_security_posture.sql`, `migrations/0005_identity.sql`, `migrations/0006_user_owned.sql`, `src/server/db/with-user.ts`, `src/server/db/assert-unprivileged.ts`, `src/server/auth/session.ts` | `tests/integration/db/cross-user-denial.test.ts`, `tests/integration/db/identity-grants.test.ts`, `tests/adversarial/idor.test.ts`, `tests/adversarial/pooled-identity.test.ts` |
| FR-15 | `req:FR-15` | `src/server/history/trail.ts`, `src/app/(app)/history/page.tsx`, `src/app/(app)/history/[decisionId]/page.tsx` | `tests/integration/history/view-posture.test.ts`, `tests/e2e/decision-loop.spec.ts` |
| FR-16 | `req:FR-16` | `src/app/api/export/route.ts`, `src/server/export/build.ts`, `migrations/0017_erase_self.sql`, `src/app/api/account/delete/route.ts`, `src/app/(app)/privacy/page.tsx` | `tests/integration/export/completeness.test.ts`, `tests/integration/deletion/erase-self.test.ts` |
| FR-17 | `req:FR-17` | — | — |
| FR-18 | `req:FR-18` | — | — |
| FR-19 | `req:FR-19` | `migrations/0002_verify_security_posture.sql`, `migrations/0006_user_owned.sql`, `src/server/db/with-user.ts`, `scripts/check-import-boundary.ts` | `tests/integration/db/posture.test.ts`, `tests/integration/db/rls-shape.test.ts`, `tests/integration/history/view-posture.test.ts`, `tests/unit/tooling/import-boundary.test.ts` |

### 4.2 Notes carried from the canon

| ID | Note |
|---|---|
| FR-01 | The brief renders the source register, the as_of_date, the fiction label and the data gaps before the response form. |
| FR-02 | scenario_version carries is_fiction and as_of_date (canon 5.1); scenario_claim is the grounding whitelist shared with FR-08. |
| FR-03 | Canon 5.1 grants UPDATE on draft_payload only; draft_updated_at is trigger-set so a payload-only update cannot evade the frozen-draft check. A partial unique index enforces one open draft per user per scenario version. The unit leg is field validation (master prompt section 9); no unit test is listed in this row's covering_tests, so that leg is uncovered and the database constraints of the submission path are an independent backstop rather than a substitute for it. |
| FR-04 | Covers INV-01, INV-02, INV-03 and INV-11. |
| FR-05 | confidence smallint check between 0 and 100; forecast and rationale NOT NULL; horizon stored separately (canon 5.1), so a submission missing the confidence value, the expected outcome or the timeframe is rejected by the schema and not only by the form. PRD 7.4 keeps forecast, confidence, deadline and later observation separate. The unit leg is the confidence-bound check of master prompt section 9; no unit test is listed in this row's covering_tests, so that leg is uncovered and the database assertion is the only one this register carries. |
| FR-07 | Fixture mode only until a live provider is configured; canon 7.1 forbids keying mode on key absence and the UI must label fixture-backed responses. A challenge run is pinned to a decision_revision, not to a decision (canon 7.2). |
| FR-08 | Covers INV-09. Structural adversarial cases are release blockers (canon 7.6). |
| FR-09 | disposition in (accepted, disputed, flagged_incorrect); flagged_incorrect is its own state and is excluded from "addressed" (canon 5.1). |
| FR-10 | Covers INV-08. Canon 1.2 prohibits any composite readiness, character or viability score. |
| FR-11 | origin_challenge_id and origin_dimension_assessment_id carry the link to originating feedback (canon 5.1). |
| FR-12 | development_action.reassessment_decision_id links the repeat attempt; append-only decision_revision keeps both visible. |
| FR-14 | Covers INV-04, INV-05 and INV-06. Canon 6.1 - withUser takes no session parameter and calls requireSession itself. |
| FR-15 | Covers INV-07 - the trail must resolve the pinned scenario_version, not the latest. |
| FR-16 | Canon 5.2 - on delete restrict from app_user, not cascade; erase_self derives identity internally and never takes a uuid; the privacy notice states real retention including backups, with no immediate-erasure promise. The manual leg is the retention-notice wording review, which no automated test can carry; per the manual_leg_rule it is discharged only by the named verification_evidence record, and until that record exists and is referenced this row reaches at most NOT RUN in the run report. |
| FR-19 | Enforced by grant absence plus RLS enabled and forced, not by route-level omission alone. Canon O6 - the MVP ships no global role column. |

---

## 5. Nonfunctional requirements

PRD §6.4 assigns priorities to FRs only. PRD §11 states NFR release targets without
priorities, and the canon does not assign them either. The priority below is recorded as
`P0 (inferred)` on the basis of PRD §11 and the master prompt go/no-go conditions. It is
an inference drawn in this document, not a statement found in the PRD.

| ID | Priority | PRD ref | Acceptance condition | Component/service | DB entities | Verification | Status |
|---|---|---|---|---|---|---|---|
| NFR-01 | P0 (inferred) | §11 | Private-by-default; authenticated session and authorization checks on every sensitive read/write | withUser guard; RLS policies; posture check | `$user_owned`, `$grant_protected` | posture-check, integration | PLANNED |
| NFR-02 | P0 (inferred) | §11 | TLS in transit, encryption at rest, protected secrets, least privilege and basic security testing | Deployment posture; roles and grants; CI secret scan and dependency audit | `$grant_protected` | posture-check, manual | PLANNED |
| NFR-03 | P0 (inferred) | §11 | All submitted versions, assessment changes and review decisions have actor/time metadata | audit_event writes on submission, revision, assessment, action and erasure | `audit_event` | integration | PLANNED |
| NFR-04 | P0 (inferred) | §11 | Responsive design for mobile and desktop; primary flow usable on a small phone screen | Layout and component layer across screens A-E | — | e2e | PLANNED |
| NFR-05 | P0 (inferred) | §11 | Target WCAG 2.2 AA; keyboard access, text contrast, meaningful labels, no color-only meaning | Component layer; axe gate in E2E | — | e2e | PLANNED |
| NFR-06 | P0 (inferred) | §11 | Pilot availability objective >= 99.5% monthly, excluding pre-announced maintenance | Operational objective - no application component | — | deferred | DEFERRED |
| NFR-07 | P0 (inferred) | §11 | Target core screen load <= 3s at typical mobile connection in pilot performance tests | Core screen render path - no P0 measurement instrument | — | deferred | DEFERRED |
| NFR-08 | P0 (inferred) | §11 | Preserve input on model/API failure; clear retry/fallback message without claiming successful feedback | AI adapter resilience; Challenge Review unavailable state | `challenge_run`, `decision_revision` | integration, e2e | PLANNED |
| NFR-09 | P0 (inferred) | §11 | Export decision history, actions and reviews in a documented machine-readable format | Export route and serializer | `$user_owned` | integration, e2e | PLANNED |
| NFR-10 | P0 (inferred) | §11 | Source links stored with dates; broken/withdrawn sources flagged and cases reviewable or archived | Source register; source status and archival | `source`, `scenario_claim`, `scenario_version` | integration | PLANNED |

### 5.1 Coverage map

| ID | Covering test tag | Implementation paths (planned) | Covering tests (planned) |
|---|---|---|---|
| NFR-01 | `req:NFR-01` | `migrations/0002_verify_security_posture.sql`, `migrations/0003_privileges.sql`, `src/server/db/with-user.ts`, `src/server/db/assert-unprivileged.ts` | `tests/integration/_000-posture.test.ts`, `tests/integration/db/privileges.test.ts`, `tests/integration/db/context.test.ts`, `tests/unit/db/with-user.test.ts` |
| NFR-02 | `req:NFR-02` | `scripts/bootstrap.sql`, `scripts/assert-bootstrap.sql`, `migrations/0003_privileges.sql`, `scripts/secret-scan.ts`, `.env.example` | `tests/integration/db/bootstrap.test.ts`, `tests/integration/db/identity-grants.test.ts`, `tests/integration/auth/token-storage.test.ts`, `tests/unit/tooling/secret-scan.test.ts` |
| NFR-03 | `req:NFR-03` | `migrations/0006_user_owned.sql`, `migrations/0012_submit.sql`, `migrations/0017_erase_self.sql`, `src/server/audit/write.ts` | `tests/integration/audit/immutability.test.ts`, `tests/integration/decision/submit.test.ts`, `tests/integration/deletion/erase-self.test.ts` |
| NFR-04 | `req:NFR-04` | `src/app/layout.tsx`, `src/components/*`, `src/app/__a11y-canary/page.tsx` | `tests/e2e/responsive.spec.ts`, `tests/e2e/mobile.spec.ts`, `tests/e2e/canary.spec.ts` |
| NFR-05 | `req:NFR-05` | `src/components/*`, `src/components/rendered-text.tsx`, `src/app/__a11y-canary/page.tsx` | `tests/e2e/a11y.spec.ts`, `tests/e2e/focus.spec.ts`, `tests/e2e/keyboard.spec.ts`, `tests/e2e/canary.spec.ts` |
| NFR-06 | `req:NFR-06` | — | — |
| NFR-07 | `req:NFR-07` | — | — |
| NFR-08 | `req:NFR-08` | `src/server/ai/run.ts`, `src/server/ai/adapter.ts`, `src/app/(app)/challenge/[decisionRevisionId]/page.tsx` | `tests/integration/ai/failure-isolation.test.ts`, `tests/integration/ai/budget.test.ts`, `tests/integration/ai/idempotency.test.ts`, `tests/e2e/resilience.spec.ts` |
| NFR-09 | `req:NFR-09` | `src/app/api/export/route.ts`, `src/server/export/build.ts` | `tests/integration/export/completeness.test.ts` |
| NFR-10 | `req:NFR-10` | `migrations/0004_reference_tables.sql`, `migrations/0009_seed_demo_ph_001.sql`, `src/server/content/scenario.ts` | `tests/unit/content/source-register.test.ts` |

### 5.2 Notes carried from the canon

| ID | Note |
|---|---|
| NFR-01 | The posture check runs at the end of every migration run in every environment and as integration test number one (canon 4.8, 8.7). |
| NFR-02 | Canon O1 - encryption at rest has no mechanism in Postgres (no TDE). FileVault locally, a managed or encrypted volume on any deploy. Declared an open release item, not silently met. The manual leg is the deployment-posture review of that open item; per the manual_leg_rule it is discharged only by the named verification_evidence record, and until that record exists and is referenced this row reaches at most NOT RUN in the run report. |
| NFR-03 | Canon 5.1 - user_id is the subject and actor_user_id the actor; a deletion writes actor_user_id IS NULL, so the insert policy is with check (true) and there is no UPDATE or DELETE policy. |
| NFR-04 | Canon 8.5 - the 320px overflow detector must fail on the 400px fixed block in the canary route, which is mounted only under E2E_FAULTS=1 (INS-03). |
| NFR-05 | Canon 8.5 - the axe gate must fail on the canary (INS-03) and focus indication is asserted as a difference between focused and blurred computed styles plus a contrast ratio of at least 3:1, because a presence check on outlineStyle can never fail (INS-08). |
| NFR-08 | Canon 7.5 - the model call happens outside the write transaction; a failing call must not delete a draft, mutate a locked revision or mark review complete. A missing key in live mode renders this state rather than falling back to fixtures (canon 7.1). failure_code and the partial idempotency index let a failed run be retried. |
| NFR-09 | Canon O2 - React cache() outside a render context is unsettled for the export route and must be decided empirically before it is relied on. The format document the acceptance condition requires is not among the implementation_paths of this row, so the "documented" half of the condition is uncovered. |
| NFR-10 | Canon 12.1 item 4 makes this a required P0 control, not a declared gap - source gains a status column (active \| withdrawn \| unreachable) and scenario_version an archival flag, with a CI assertion that a seeded withdrawn source is reported. The dates half is covered by the source register. The flagging and archival half has no implementation_path and no covering test in this row, so it is PLANNED and uncovered rather than met. |

### 5.3 Deferral gates

A `DEFERRED` row states its gate here rather than inside its status cell, so the status
column stays inside its closed vocabulary. Where the PRD does **not** defer a requirement,
the deferral is ours, and canon §12.2 requires it to be written down as a decision rather
than applied silently inside a generated register — the `Recorded in` column names that
record.

| ID | Priority | Deferral gate | Recorded in |
|---|---|---|---|
| FR-06 | P1 | PRD 3.2 V1.1 gate - reliable weekly use, good case quality, safe reviewer permissions. The P0 history surface is a simple list. | PRD §3.2 |
| FR-13 | P1 | PRD 3.2 V1.1 gate - safe reviewer permissions; canon O6 specifies a record_share table rather than a global role when it arrives. | PRD §3.2 |
| FR-17 | P1 | PRD 3.2 V1.1 gate - reliable weekly use and good case quality before retrospective surfaces are built. audit_event and the decision lineage keep the counts recomputable from records. | PRD §3.2 |
| FR-18 | P1 | PRD 3.2 V1.1 gate - reliable weekly use; PRD 3.2 does not enumerate FR-18 separately, so it inherits the V1.1 gate. No profiling of voters or sensitive groups is permissible in any form (SR-01). | PRD §3.2 |
| NFR-06 | P0 (inferred) | Measurable only from pilot operation; a throttled local E2E budget is not evidence about pilot hardware. PRD 11 does not defer it, so the deferral is ours: it is recorded in docs/decisions.md per canon 12.2 and this row references that record rather than deciding scope inside the register. | `docs/decisions.md` |
| NFR-07 | P0 (inferred) | Measurable only from pilot operation; a throttled local E2E budget is not evidence about pilot hardware. PRD 11 closes by stating these are proposed design acceptance targets, not measured performance. Canon 12.2 forbids leaving this row P0 and PLANNED behind an implementation path that no task creates, so it is deferred on the same honest basis as NFR-06 and recorded in docs/decisions.md. It flips to PLANNED if and when the file layout of record carries a throttled Playwright budget spec with its own positive control - a deliberately slowed fixture route that must fail the budget. | `docs/decisions.md` |

---

## 6. Critical-invariant register

Canon §8.7 sets no global coverage percentage but requires **100% of these invariants
tested**. Canon §8 governs how: *a test that cannot be made to fail has not been shown to
work* — every denial assertion is paired with a positive control, and every instrument has
a test in which it must report the negative.

| ID | Invariant | Canon ref | Covering test tag | Covers | Status |
|---|---|---|---|---|---|
| INV-01 | Immutability of a submitted revision | canon 4.4, 5.1 | `inv:INV-01` | FR-04 | PLANNED |
| INV-02 | Double-submit idempotency | canon 4.4, 5.1; master prompt 6 | `inv:INV-02` | FR-04 | PLANNED |
| INV-03 | Illegal transition rejection | canon 4.4 (V28, V29) | `inv:INV-03` | FR-04 | PLANNED |
| INV-04 | Cross-user denial with positive control | canon 8.2 | `inv:INV-04` | FR-14, FR-19, NFR-01 | PLANNED |
| INV-05 | Missing-context validation | canon 4.3, 6.1 | `inv:INV-05` | FR-14, NFR-01 | PLANNED |
| INV-06 | Pooled-identity leak across sequential requests | canon 7.6, 6.1 | `inv:INV-06` | FR-14, NFR-01 | PLANNED |
| INV-07 | Scenario-version pinning | canon 5.1, 7.2, 7.3 | `inv:INV-07` | FR-02, FR-15 | PLANNED |
| INV-08 | AI never awards maturity level 3 or 4 | canon 5.1, 1.2; PRD 7.2 | `inv:INV-08` | FR-10 | PLANNED |
| INV-09 | Citation whitelist | canon 5.1, 7.3 | `inv:INV-09` | FR-08, FR-02 | PLANNED |
| INV-10 | Backfill bracketing in one migration file | canon 4.4, 10 (V8) | `inv:INV-10` | FR-19, NFR-01 | PLANNED |
| INV-11 | Row-count assertion on every privileged write | canon 4.4 (V7) | `inv:INV-11` | FR-04, FR-16, NFR-03 | PLANNED |

### 6.1 What each invariant asserts, and the control it must carry

| ID | Rule | Required control |
|---|---|---|
| INV-01 | A submitted decision_revision cannot be updated, deleted or truncated. Enforced by BEFORE UPDATE OR DELETE triggers, a BEFORE TRUNCATE FOR EACH STATEMENT trigger (V15), and absent UPDATE/DELETE/TRUNCATE grants. | Paired positive control - the same transaction must succeed in appending a new revision, so the failure is shown to be the mutation and not the fixture. |
| INV-02 | Two concurrent submissions of the same revision produce one row, not two, keyed on decision_revision.idempotency_token (unique) and unique (decision_id, revision_no). The arbitration is an explicit select for update on the parent decision row; the unique constraint is the backstop, not the mechanism. The row-count assertion that makes a zero-row write loud is INV-11. | Genuinely concurrent - two clients, explicit BEGIN, interleaved statements, an xact_start overlap assertion and an application rendezvous. Lock-wait detection is not a valid negative control (V23); waitUntilBlocked must be shown to return false on different rows (INS-01). |
| INV-03 | state is GENERATED ALWAYS AS STORED from the five milestone timestamps by the IMMUTABLE function app.derive_decision_state, with per-branch enum casts and never a cast of the CASE result (V12). The BEFORE UPDATE trigger derives the PROSPECTIVE state by calling that same function on NEW's milestone timestamps, compares OLD.state to the prospective state against a whitelist, and raises uppercase custom SQLSTATEs (V13) that the API maps to distinct HTTP statuses. The trigger must NEVER read NEW.state - it is NULL in a BEFORE UPDATE trigger on a generated column (V28, reproduced on this cluster), so a trigger that reads it compares against NULL on every transition and therefore permits everything or rejects everything. One function definition serves both the column and the guard, so they cannot drift (V29). RLS never encodes transitions (V7). | A meta-test over all 32 combinations of the five milestone timestamps being null or non-null, asserting that the function's result and the stored column agree for every combination - this is what fails against a trigger that reads NEW.state, because every comparison sees NULL. Plus: each rejected pair is paired with the legal transition out of the same state, and every custom SQLSTATE is round-trip tested for case (V13 - a lowercase SQLSTATE silently resolves to 42704). |
| INV-04 | A sees the row (1), B sees 0, B's write raises nothing, A still sees 1. Inside a rolled-back transaction the policy is dropped and the row must become visible. | The policy-drop probe is the control. A bare rowCount === 0 proves nothing, because DELETE 0 under RLS is byte-identical to deleting a nonexistent id (V19) and a failing USING clause raises nothing (V7). Every denial case asserts the after-state read, not only the row count. |
| INV-05 | app.require_user_id() raises SQLSTATE 28000 when app.current_user_id is NULL or the empty string (V5), and withUser calls it eagerly after set_config so a missing context fails loudly regardless of query shape (V6). | Negative control - the same query with context set must return the row, and the no-context case must raise rather than return zero rows. |
| INV-06 | Two sequential requests on one warmed pooled client must not let the first request's identity reach the second. DISCARD ALL in the finally block makes a mistaken is_local=false inert; app.require_user_id() stays STABLE, because an IMMUTABLE variant was proven to leak one user's rows to another from the second execution of a prepared statement onward. | Catalog assertion provolatile = 's' as the primary gate (it cannot be scheduled away), plus a two-request sequence on a single client asserting the second request's rows belong to the second user only. |
| INV-07 | decision_revision pins scenario_version_id by composite FK, scenario_version is immutable once published_at is set, and every challenge or assessment record names the exact revision and scenario version evaluated. | Publish a later scenario_version and assert the submitted decision's trail still resolves the pinned version, with a positive control that the new version is otherwise reachable. |
| INV-08 | check (assessor_kind <> 'ai' or observed_level <= 2) keeps the full 0-4 domain in the database while constraining the AI, and a trigger forbids any AI-path update of a human_reviewer row. | Positive control - the same insert with assessor_kind = 'human_reviewer' and observed_level 3 must succeed, so the rejection is attributable to the assessor kind. |
| INV-09 | Every evidence_ref and source_claim is checked against scenario_claim for the pinned scenario_version_id, and the citation row carries a composite FK over (scenario_version_id, source_id, claim_id) plus the owning challenge's (id, user_id), so a fabricated citation cannot be persisted. A challenge whose citations do not all resolve is dropped individually and the drop is recorded with a failure_code. The same chain exists for assessment_observation_source_claim. | Positive control - an approved claim id from the same scenario_version must persist, and the unapproved id must be rejected at the database layer with the application check disabled, so the FK is shown to be load-bearing. |
| INV-10 | FORCE ROW LEVEL SECURITY makes an owner-run UPDATE WHERE true affect zero rows and raise nothing, and SET row_security = off is refused (V8). Every data migration therefore brackets alter table no force and alter table force in the SAME migration file, and the migration lint rejects an unmatched no force. A migration that leaves a table NO FORCE is the posture regression the lint exists to catch. | A planted fixture containing an unmatched no force must be REPORTED by the lint; a correctly bracketed fixture must not be. A lint that reports neither has not been shown to read the file. |
| INV-11 | EVERY privileged write asserts its own row count - get diagnostics n = row_count; if n <> 1 then raise using errcode = 'ST005' - because a failing RLS USING clause affects zero rows and raises nothing (V7), so silence is never success and a row count of 0 never distinguishes denial from absence. This applies to the submission path, the state-transition path and the erasure path alike, not to submission only. | A test double that zeroes the row count must cause a raise, asserted separately on the submission, transition and erasure paths. A write path with no such assertion is a gap even when its happy-path test passes. |

### 6.2 Instrument gates

Canon §8.4, §8.5 and §8.3 require the instruments and the harness themselves to be tested.
These are gates on the harness, not on a requirement; INS-01, INS-02 and INS-07 are
harness-fatal.

| ID | Gate | Canon ref | Tag | Status |
|---|---|---|---|---|
| INS-01 | waitUntilBlocked must return false when two sessions lock different rows. Harness-fatal. | canon 8.4 | `inv:INS-01` | PLANNED |
| INS-02 | The revision-number read helper, run sequentially, must produce different values. Harness-fatal. | canon 8.4 | `inv:INS-02` | PLANNED |
| INS-03 | The axe gate and the 320px overflow detector must both fail on /__a11y-canary, which is mounted only under E2E_FAULTS=1. | canon 8.5 | `inv:INS-03` | PLANNED |
| INS-04 | With no context every protected table returns 0; as the sentinel user each returns exactly 1. A table shipped without RLS leaks its sentinel and the run dies. | canon 8.1 | `inv:INS-04` | PLANNED |
| INS-05 | A positive observability assertion must distinguish a NULLed pg_stat_activity (V24) from "not yet blocked". | canon 8.4 | `inv:INS-05` | PLANNED |
| INS-06 | gates:selftest fixtures assert deep equality against an expected per-requirement object, not an exit code - five fixtures asserting only code === 2 let a checker that returns 0 or 2 pass seven of ten. trace:check is the separate script that diffs only the deterministic committed document; the deep-equality fixtures do not belong to it. | canon 8.6 | `inv:INS-06` | PLANNED |
| INS-07 | Per-worker CREATE DATABASE TEMPLATE statesman_test_template, dropped at teardown - never TRUNCATE, which the immutability triggers forbid by design. Migrations are applied by lexical glob so a new migration cannot be omitted from the test path. Tests connect as statesman_app and a wrong-role connection is HARNESS-FATAL, not a warning. Seeding goes through withUser so a missing INSERT policy surfaces instead of being bypassed. withUser contains no rollback branch and no process.env reference; per-test transaction isolation is injected by test-only code through an optional provider. | canon 8.3 | `inv:INS-07` | PLANNED |
| INS-08 | Focus visibility is asserted as a DIFFERENCE between focused and blurred computed styles plus a contrast ratio of at least 3:1. A presence check on outlineStyle can never fail, because UA stylesheets give :focus-visible elements outline-style: auto regardless of the author's CSS. | canon 8.5 | `inv:INS-08` | PLANNED |

### 6.3 Controls the instruments must carry

| ID | Required control |
|---|---|
| INS-07 | Point the fixture at a statesman_migrator connection string and assert the harness ABORTS - it fails while the harness merely logs. Separately assert that the compiled source of withUser contains no process.env and no env-gated rollback path. |
| INS-08 | A fixture with the author focus styling removed must FAIL the difference assertion while still reporting outline-style: auto. A gate that passes on that fixture is measuring the UA stylesheet. |

### 6.4 Invariant and instrument coverage map

| ID | Covering tests (planned) |
|---|---|
| INV-01 | `tests/integration/decision/submit.test.ts`, `tests/integration/audit/immutability.test.ts` |
| INV-02 | `tests/integration/decision/double-submit.test.ts`, `tests/integration/decision/append-revision.test.ts` |
| INV-03 | `tests/integration/decision/state.test.ts` |
| INV-04 | `tests/integration/db/cross-user-denial.test.ts`, `tests/adversarial/idor.test.ts` |
| INV-05 | `tests/integration/db/context.test.ts`, `tests/integration/db/eager-validation.test.ts` |
| INV-06 | `tests/adversarial/pooled-identity.test.ts`, `tests/integration/db/discard-all.test.ts` |
| INV-07 | `tests/integration/history/view-posture.test.ts`, `tests/integration/content/read-only.test.ts` |
| INV-08 | `tests/integration/assessment/ai-ceiling.test.ts` |
| INV-09 | `tests/integration/ai/grounding.test.ts`, `tests/integration/assessment/observation-grounding.test.ts` |
| INV-10 | `tests/unit/tooling/migration-lint.test.ts` |
| INV-11 | `tests/integration/decision/submit.test.ts`, `tests/integration/decision/state.test.ts`, `tests/integration/deletion/erase-self.test.ts` |
| INS-01 | `tests/integration/harness/instruments.test.ts` |
| INS-02 | `tests/integration/harness/instruments.test.ts` |
| INS-03 | `tests/e2e/canary.spec.ts` |
| INS-04 | `tests/integration/db/sentinels.test.ts`, `tests/integration/harness/app-role.test.ts` |
| INS-05 | `tests/integration/harness/instruments.test.ts` |
| INS-06 | `tests/unit/tooling/trace-check.test.ts`, `tests/unit/tooling/tags-reporter.test.ts` |
| INS-07 | `tests/integration/harness/app-role.test.ts`, `tests/unit/db/with-user.test.ts` |
| INS-08 | `tests/e2e/focus.spec.ts` |

---

## 7. Registered threats and safety rules

`docs/threat-model.md` owns these ids (canon §12). They are registered here verbatim so
that a test carrying `tc:TC-SEC-nnn` matches an id the checker knows, and so that the
`Covered by` column shows where a threat is already exercised by a requirement or
invariant test rather than by a parallel one. Rows marked **(canon §12.1)** are controls
the threat model listed as undesigned and that canon §12.1 now makes required P0 work in
Slice 6: CSRF origin verification, log and telemetry redaction, stored-XSS rendering with
a CSP, and NFR-10 source status and archival.

| ID | Threat or safety rule | Test case | Tag | Covered by | Status |
|---|---|---|---|---|---|
| T-01 | IDOR - cross-user read of any user-owned table | `TC-SEC-001` | `tc:TC-SEC-001` | FR-14, INV-04 | PLANNED |
| T-02 | IDOR - cross-user write | `TC-SEC-002` | `tc:TC-SEC-002` | FR-14, INV-04, INV-11 | PLANNED |
| T-03 | IDOR through a view without security_invoker | `TC-SEC-003` | `tc:TC-SEC-003` | FR-19, NFR-01 | PLANNED |
| T-04 | PUBLIC EXECUTE on SECURITY DEFINER functions | `TC-SEC-004` | `tc:TC-SEC-004` | FR-14, NFR-01 | PLANNED |
| T-05 | Privileged-role reachability via role membership | `TC-SEC-005` | `tc:TC-SEC-005` | NFR-01, INV-06 | PLANNED |
| T-06 | Table ownership bypasses RLS | `TC-SEC-006` | `tc:TC-SEC-006` | NFR-01 | PLANNED |
| T-07 | Pooled-connection identity leak | `TC-SEC-007` | `tc:TC-SEC-007` | INV-06 | PLANNED |
| T-08 | Missing-context silent zero-row read | `TC-SEC-008` | `tc:TC-SEC-008` | INV-05 | PLANNED |
| T-09 | A failing USING clause as a silent no-op write | `TC-SEC-009` | `tc:TC-SEC-009` | INV-11 | PLANNED |
| T-10 | Temp-table shadowing of an unqualified reference | `TC-SEC-010` | `tc:TC-SEC-010` | NFR-01 | PLANNED |
| T-11 | A new table or a forgotten grant | `TC-SEC-011` | `tc:TC-SEC-011` | NFR-01, FR-19 | PLANNED |
| T-12 | An over-broad policy | `TC-SEC-012` | `tc:TC-SEC-012` | NFR-01 | PLANNED |
| T-13 | TRUNCATE destroys immutable history | `TC-SEC-013` | `tc:TC-SEC-013` | INV-01, NFR-03 | PLANNED |
| T-14 | Identity supplied as an argument | `TC-SEC-014` | `tc:TC-SEC-014` | FR-14 | PLANNED |
| T-15 | An unguarded connection outside the data boundary | `TC-SEC-015` | `tc:TC-SEC-015` | FR-19 | PLANNED |
| T-16 | Injection into transaction setup | `TC-SEC-016` | `tc:TC-SEC-016` | NFR-01 | PLANNED |
| T-17 | Credential stuffing / password guessing | `TC-SEC-017` | `tc:TC-SEC-017` | NFR-02 | PLANNED |
| T-18 | Self-DoS through the lockout designs that were cut | `TC-SEC-018` | `tc:TC-SEC-018` | NFR-02 | PLANNED |
| T-19 | Rate-limit sleep holds a pooled DB client | `TC-SEC-019` | `tc:TC-SEC-019` | NFR-02 | PLANNED |
| T-20 | Session token theft at rest | `TC-SEC-020` | `tc:TC-SEC-020` | NFR-02 | PLANNED |
| T-21 | Session token theft in transit or via script | `TC-SEC-021` | `tc:TC-SEC-021` | NFR-02 | PLANNED |
| T-22 | Session fixation | `TC-SEC-022` | `tc:TC-SEC-022` | FR-14, NFR-02 | PLANNED |
| T-23 | Sign-out that does not revoke server-side | `TC-SEC-023` | `tc:TC-SEC-023` | FR-14 | PLANNED |
| T-24 | Idle timeout hollowed by prefetch | `TC-SEC-024` | `tc:TC-SEC-024` | FR-14 | PLANNED |
| T-25 | A stale session survives a credential or privilege change | `TC-SEC-025` | `tc:TC-SEC-025` | FR-14 | PLANNED |
| T-26 | Account-deletion gap | `TC-SEC-026` | `tc:TC-SEC-026` | FR-16 | PLANNED |
| T-27 | Cascade deletion destroys audit history | `TC-SEC-027` | `tc:TC-SEC-027` | NFR-03, FR-16 | PLANNED |
| T-28 | The erasure flag persists after erasure returns | `TC-SEC-028` | `tc:TC-SEC-028` | FR-16 | PLANNED |
| T-29 | Actor and subject conflated in the audit record | `TC-SEC-029` | `tc:TC-SEC-029` | NFR-03 | PLANNED |
| T-30 | Prompt injection via scenario text and source excerpts | `TC-SEC-030` | `tc:TC-SEC-030` | FR-08 | PLANNED |
| T-31 | Prompt injection via the user's own journal text | `TC-SEC-031` | `tc:TC-SEC-031` | FR-08 | PLANNED |
| T-32 | Fabricated citation or claim id | `TC-SEC-032` | `tc:TC-SEC-032` | INV-09, FR-08 | PLANNED |
| T-33 | Fabricated statute, endorsement or institutional position | `TC-SEC-033` | `tc:TC-SEC-033` | FR-08 | PLANNED |
| T-34 | The assessment path is ungrounded | `TC-SEC-034` | `tc:TC-SEC-034` | INV-09, FR-10 | PLANNED |
| T-35 | The AI awards maturity level 3 or 4 | `TC-SEC-035` | `tc:TC-SEC-035` | INV-08 | PLANNED |
| T-36 | The fixture adapter ships as the production default | `TC-SEC-036` | `tc:TC-SEC-036` | FR-07 | PLANNED |
| T-37 | Hostile or malformed model-provider output | `TC-SEC-037` | `tc:TC-SEC-037` | FR-08 | PLANNED |
| T-38 | Excessive data sharing with the model provider | `TC-SEC-038` | `tc:TC-SEC-038` | NFR-02 | PLANNED |
| T-39 | Model cost and token exhaustion | `TC-SEC-039` | `tc:TC-SEC-039` | NFR-08 | PLANNED |
| T-40 | A failing AI call corrupts user state | `TC-SEC-040` | `tc:TC-SEC-040` | NFR-08 | PLANNED |
| T-41 | Duplicate or concurrent run creates a duplicate record | `TC-SEC-041` | `tc:TC-SEC-041` | INV-02 | PLANNED |
| T-42 | Scenario content changes under a submitted decision | `TC-SEC-042` | `tc:TC-SEC-042` | INV-07 | PLANNED |
| T-43 | A custom SQLSTATE silently collapses to 42704 | `TC-SEC-043` | `tc:TC-SEC-043` | INV-03 | PLANNED |
| T-44 | Stored XSS through journal fields **(canon §12.1)** | `TC-SEC-044` | `tc:TC-SEC-044` | NFR-02, FR-19 | PLANNED |
| T-45 | Stored XSS through model output **(canon §12.1)** | `TC-SEC-045` | `tc:TC-SEC-045` | NFR-02, FR-08 | PLANNED |
| T-46 | CSRF against Server Actions **(canon §12.1)** | `TC-SEC-046` | `tc:TC-SEC-046` | NFR-02, FR-14 | PLANNED |
| T-47 | Private content in logs and telemetry **(canon §12.1)** | `TC-SEC-047` | `tc:TC-SEC-047` | NFR-02, FR-19 | PLANNED |
| T-48 | The export route leaks across users | `TC-SEC-048` | `tc:TC-SEC-048` | FR-16, NFR-09, INV-06 | PLANNED |
| T-49 | Accidental public exposure of journal content | `TC-SEC-049` | `tc:TC-SEC-049` | FR-19 | PLANNED |
| T-50 | Model API key leakage | `TC-SEC-050` | `tc:TC-SEC-050` | NFR-02 | PLANNED |
| T-51 | DATABASE_URL leakage, or a typo'd role | `TC-SEC-051` | `tc:TC-SEC-051` | NFR-01, NFR-02 | PLANNED |
| T-52 | Credentials written to a handoff file | `TC-SEC-052` | `tc:TC-SEC-052` | NFR-02 | PLANNED |
| T-53 | Vulnerable dependency | `TC-SEC-053` | `tc:TC-SEC-053` | NFR-02 | PLANNED |
| T-54 | An owner-run backfill silently affects zero rows | `TC-SEC-054` | `tc:TC-SEC-054` | INV-10 | PLANNED |
| T-55 | An operator's plain parent DELETE is indistinguishable from authorised erasure | `TC-SEC-055` | `tc:TC-SEC-055` | FR-16, NFR-03 | PLANNED |
| T-56 | Policies scoped TO statesman_app lock out the owner and the definer functions | `TC-SEC-056` | `tc:TC-SEC-056` | NFR-01 | PLANNED |
| T-57 | A backup taken under FORCE as a non-superuser owner | `TC-SEC-057` | `tc:TC-SEC-057` | NFR-02 | PLANNED |
| T-58 | The database does not survive a restart, or refuses to start | `TC-SEC-058` | `tc:TC-SEC-058` | — | PLANNED |
| T-59 | A quality gate passes while exercising nothing | `TC-SEC-059` | `tc:TC-SEC-059` | INS-01, INS-02, INS-03, INS-04, INS-05, INS-06, INS-07, INS-08 | PLANNED |
| SR-01 | No voter profiling or segmentation | `TC-SEC-060` | `tc:TC-SEC-060` | FR-18 | PLANNED |
| SR-02 | No targeted political messaging or opinion manipulation | `TC-SEC-061` | `tc:TC-SEC-061` | FR-08 | PLANNED |
| SR-03 | No fabricated endorsements, legal authorities or certainty claims | `TC-SEC-062` | `tc:TC-SEC-062` | FR-08, INV-09 | PLANNED |
| SR-04 | No covert publication of private journals | `TC-SEC-063` | `tc:TC-SEC-063` | FR-19, FR-16 | PLANNED |
| SR-05 | No simulated consequence presented as a forecast | `TC-SEC-064` | `tc:TC-SEC-064` | FR-10 | PLANNED |

---

## 8. Declared gaps carried into this trace

Canon §9 records six open items. These are the requirements they touch. None is closed.

| Canon item | Item | Touches | Disposition |
|---|---|---|---|
| O1 | NFR-02 encryption at rest has no mechanism — Postgres has no TDE | NFR-02 | FileVault locally; managed or encrypted volume on any deploy. Open release item. |
| O2 | React `cache()` outside a render context, used for session resolution in Route Handlers including the journal export route | NFR-09, FR-16, FR-14 | Settle empirically before relying on it: `randomUUID()` in the uncached implementation, two concurrent requests, ids must differ. |
| O3 | Node v25.5.0 is an odd-numbered line; declared `engines` accept it | all | Note, not a blocker. Pin exact versions; verify async `cookies()` and `instrumentation.ts` semantics against the installed release. |
| O4 | Framework and library assertions (lint behaviour, flag names, option keys) | §2 tag convention, all e2e rows | Each settled by command against installed tooling before use, never from memory. |
| O5 | Postgres is not brew-managed (V26) and needs `LC_ALL` (V27) | all integration and posture-check rows | Runbook documents `brew services start postgresql@17` and `LC_ALL=en_US.UTF-8`. |
| O6 | FR-13 reviewer sharing deferred; MVP ships no global `role` column | FR-13, FR-19 | A `record_share` table when it arrives. A global role cannot express per-item scoped revocable sharing. |

---

## 9. How this file stays honest

### 9.1 The mechanism

`npm run trace:check` does two separable things, and only the first touches this file:

1. **Determinism check.** It re-renders this document from `docs/requirements.yaml` and
   compares it to the committed copy. With `--check` any difference is a failure. Nothing
   volatile may enter this file, or the check becomes unpassable by construction. This is
   why there is no timestamp, no commit sha, no run id and no per-run outcome anywhere
   above.
2. **Run join.** It joins `requirements.yaml` against `reports/tags-vitest.json`,
   `reports/tags-playwright.json` and the suite results, and writes the per-requirement
   outcome to `reports/trace.json` plus a human-readable `reports/traceability-run.md`.
   Both are gitignored.

`trace:check` runs **last** in the CI order of canon §8.7, after the gates whose results
it reports. `gates:selftest` is the separate script that proves the checker itself works,
and it holds the deep-equality fixtures (INS-06).

The render rules are fixed in `requirements.yaml` under `render:`, so the document is
reproducible from the register rather than from a reader's taste: cell text is copied
verbatim and carries no trailing period, `PRD 6.1` becomes `§6.1`, an empty list becomes
an em dash, and the counts in the header are derived. Because **no application code
exists**, the render is currently applied by hand against those rules; the script that
automates it is part of the traceability tooling and does not change the contract.

### 9.2 What makes a requirement `PASS`

A requirement is `PASS` only if **all three** hold:

| Leg | Question | Where the answer comes from |
|---|---|---|
| Exists | Is there a test carrying this requirement's tag? | `reports/tags-*.json` |
| Ran | Did that test execute in this run? | suite results for this run |
| Passed | Did it pass? | suite results for this run |

Any missing leg yields `NOT RUN`. **An unexecuted test is `NOT RUN` and was never
`PASSED`.** A skipped test, a filtered run, a crashed worker and a suite that was never
invoked all produce `NOT RUN`, not silence and not success.

`PASS`, `FAIL` and `NOT RUN` appear only in `reports/trace.json`. None of them is in the
vocabulary of this file.

### 9.3 Manual verification legs

Two P0 rows carry a `manual` verification leg: FR-16 (the retention-notice wording review)
and NFR-02 (the deployment-posture review of open item O1). Canon §12.3 sets the discharge
rule, and this register implements it:

| Rule | Where it lives |
|---|---|
| Each manual leg names a `verification_evidence` record | `verification_evidence` in `requirements.yaml`: `docs/reviews/retention-notice.md` for FR-16, `docs/reviews/encryption-at-rest.md` for NFR-02 |
| Until that record exists and is referenced, the requirement reaches **at most** `NOT RUN` in `reports/trace.json` | `meta.manual_leg_rule`; the automated legs cannot carry the row past it |
| `docs:check` asserts that every row whose verification includes `manual` names its record | the `docs:check` gate |
| No sign-off name and no date is recorded for a review that has not happened | no name and no date appears anywhere in the register, and nothing here claims a review has taken place |

### 9.4 Status vocabulary of this file

| Status | Meaning |
|---|---|
| `PLANNED` | The design is settled in the canon. No implementation and no test exist. |
| `DEFERRED` | Gated out of P0. The gate condition is in §5.3, with its decision record where the deferral is ours rather than the PRD's. |

### 9.5 Guards against the ways this document could lie

| Failure mode | Guard |
|---|---|
| A hand-typed requirement count drifts from the register | the counts in the header are derived from `requirements.yaml`; `trace:check --check` fails on a mismatch |
| A requirement is renamed in prose but not in the register | ids exist only in `requirements.yaml`; this file is rendered from it |
| A test tag refers to a requirement that no longer exists | a tag with no matching id is an error, not a silent skip |
| A security test carries an id this register never heard of | every `T-nn`, `SR-nn` and `TC-SEC-nnn` is registered in §7, so the tag namespace contains every id a test is expected to carry |
| A requirement has no test at all | an id with no tagged test is reported uncovered; it cannot reach `PASS` |
| A verification leg is quietly unmet | the coverage map lists covering tests per row; a leg named in `Verification` with no test of that kind is uncovered and reported as such, never counted |
| A title-matching matcher silently matches nothing | tags are structural, never parsed from titles (§2) |
| The checker itself is broken | `gates:selftest` asserts deep equality against an expected per-requirement object, not an exit code (INS-06) |
| A status in this file implies execution | no run status is representable here; the run report's fail-closed value is `NOT RUN` |
| An implementation path points at a file nothing will create | every path in §4.1 and §5.1 is named by a task in the file layout of record, and a path no task creates is a defect (canon §12) |
| A manual leg is quietly treated as discharged | §9.3 — the named evidence record must exist and be referenced, and `docs:check` asserts the naming |

### 9.6 Change control

Edit `docs/requirements.yaml`, re-render this file, and commit both in the same change.
Hand-editing this file alone is a defect: the next `trace:check --check` will fail, and the
re-rendered content wins. If this document and the canon disagree, the canon
(`SOS-DESIGN-001`) wins and this document is the bug. If this document and
`docs/implementation-plan.md` disagree about a filename, that document wins and this one
is the bug.
