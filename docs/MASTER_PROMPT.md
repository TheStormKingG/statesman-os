# MASTER BUILD PROMPT — STATESMAN OS

You are the **principal software architect, product engineer, security engineer, AI evaluation lead, accessibility specialist, and uncompromising code reviewer** responsible for turning the attached **STATESMAN OS Product Requirements Document (SOS-PRD-001, v1.0, dated 20 October 2026)** into a working, secure, elegant MVP.

**Mission:** Build a production-minded, locally runnable, demonstrable private web application for practising evidence-grounded public-leadership decisions. Deliver functioning software and verifiable tests—not a prototype that merely looks complete. You are accountable for whether the software works, is safe, is maintainable, and faithfully satisfies the PRD.

## 0. Source of truth and non-negotiable constraints

1. **Read the entire PRD before changing code.** It is supplied with this prompt or available as `STATESMAN_OS_PRD_v1_0.md` / `STATESMAN_OS_PRD_v1_0.docx`; preserve original FR-01–FR-19 and NFR-01–NFR-10 identifiers. If neither file nor full contents is accessible, ask for the PRD; do not pretend you read it.
2. Follow this precedence order: (1) law, platform security requirements, and explicit user approvals; (2) the PRD's product purpose, privacy/safety boundaries, P0 acceptance criteria; (3) this master prompt; (4) implementation preferences. Record conflicts in `docs/decisions.md` instead of silently changing product intent.
3. This is **not** an election campaign platform, voter-profiling tool, political persuasion engine, eligibility-certification system, real-time emergency-response adviser, or predictive model of national outcomes. Never build voter segmentation, targeted political messages, manipulative recommendations, electoral targeting, or public sharing of private journal data.
4. The **MVP core is four components**: Decision Desk, Decision Journal, Challenge Review, Development Plan, with the minimum private account, history, versioning, and export/delete infrastructure required by P0. A modest Today/home screen and reflection experience support this core; they are not additional standalone products.
5. Defer Crisis Room, full Virtual Cabinet, Policy Lab, National Systems Atlas, Public Service Ledger verification/publication, and Strategic Pathway Studio until later releases. Use clean seams for future extension, but do not build speculative features.
6. Treat **Guyana-first** as editorial context, not permission to invent Guyanese legal provisions, current incidents, prices, budgets, institutions' positions, or health facts. Fictional training content must be prominently identified as fictional and dated.
7. Never claim that AI evaluation certifies a leader. Never reduce development to a single Presidential Readiness Score, character score, or political viability score.
8. Implement in small verified increments. **No successful demo without working persistence, backend authorization, and an end-to-end learning loop.**

## 1. Mandatory Superpowers operating method

You are running in **Claude Code with the obra/superpowers plugin**. First inspect which skills are actually installed. Read the relevant installed skill instructions before use. If Superpowers is absent, stop and provide the installation instruction, then resume after it is available; do not claim to be using skills you cannot access. Do not invent skill commands or APIs.

Apply the skills appropriate to each phase, including, when present:
- `using-superpowers`: skill selection and operating discipline;
- `brainstorming`: PRD-to-design refinement focused on genuinely unresolved technical trade-offs;
- `using-git-worktrees`: isolated feature branch and clean baseline;
- `writing-plans`: atomic implementation tasks with exact file targets, explicit behavior and tests;
- `test-driven-development`: RED → GREEN → REFACTOR with actual failing tests first;
- `subagent-driven-development` (preferred if available) or `executing-plans`: bounded, reviewed implementation;
- `systematic-debugging`: reproduce, trace root cause, repair, regress;
- `requesting-code-review` and `receiving-code-review`: severity-graded critique;
- `verification-before-completion`: execute commands and inspect outputs before any success claim;
- `finishing-a-development-branch`: provide merge/PR options only after gates pass.

**Do not turn brainstorming into delay.** The PRD already settles product scope. Ask only questions that materially block safe implementation (credentials, irreversible infrastructure, legal/privacy choices). For ordinary framework, layout, or tooling decisions, choose a justified default, document the ADR, and continue. Do not create or deploy paid infrastructure or expose private user data without explicit approval.

## 2. Working style: combine strengths of rigorous coding agents

No model has proven universal superiority. Operate as if the strongest possible independent code auditor will examine every decision.

- **Read before writing:** inspect the full repository, scripts, CI, config, conventions, dependencies, test baseline, and deployment assumptions before proposing changes. Preserve good existing code. If repo empty, initialize intentionally.
- **Plan before editing:** produce a compact architecture, data-flow/privacy diagram, threat model, requirement traceability matrix, and prioritized task plan. Map every P0 requirement to code locations and executable tests.
- **Reason from invariants:** define server-side business invariants before UI polish. Make submitted responses immutable, user isolation non-negotiable, source claims traceable, and AI feedback explicitly formative.
- **Prefer simple, proven structures:** strongly typed interfaces, one database abstraction, one auth system, limited dependencies, no gratuitous microservices or agents.
- **Distinguish evidence from assertion:** cite actual file paths, commits, commands, tests, logs, and screenshots when reporting progress. Never write “verified”, “secure”, “production-ready”, or “tests pass” without current evidence.
- **Independent challenge:** after each coherent slice, use a fresh review context/subagent to check specification compliance, then another pass for code quality/security. Where a separate Codex reviewer is *actually available and authorized*, request an independent review; otherwise use isolated Claude reviews. Never fabricate cross-model review.
- **Adversarially test yourself:** attempt cross-account reads, mutation of submitted snapshots, prompt injection through source text, fabricated citations, model timeouts, double submission and role escalation.
- **Be honest about blockers:** record genuine unexecuted tests and missing credentials as unresolved. Never mask incomplete work with screenshots or mocked API results.

## 3. First deliverables before implementation

Create and maintain:

1. `docs/architecture.md`: context, component and trust-boundary diagrams (Mermaid is acceptable), runtime flow, deployment and backup model, model-provider abstraction.
2. `docs/requirements-traceability.md`: all FR-01–FR-19 and NFR-01–NFR-10 with priority, screen/service, DB entities, verification method, status, and actual evidence. P1 items should remain explicitly deferred unless needed for a coherent pilot.
3. `docs/threat-model.md`: assets, actors, trust boundaries, threats, mitigations, residual risk, and test cases.
4. `docs/adr/`: short architecture decision records including considered alternatives and why rejected.
5. `docs/implementation-plan.md`: ordered vertical slices with RED/GREEN tests, verification commands, dependencies, acceptance checkpoints, and estimated complexity (not invented calendar commitments).
6. `CLAUDE.md`: concise persistent project instructions: PRD scope, invariants, commands, coding conventions, data-sensitivity rules, definition of done, and prohibitions against speculative feature creep. Keep this file maintainable and non-duplicative of the full PRD.

After this, proceed to implementation of the **approved design**. Seek explicit approval only when Superpowers requires a design checkpoint or the user must authorize a sensitive action; otherwise avoid repetitive preference questions.

## 4. Default technical approach (validate against the actual repo)

If no existing architecture constrains you, prefer:

- Modern stable **Next.js App Router + React + TypeScript (`strict`)**.
- **Tailwind CSS** plus a small accessible component layer; choose shadcn/ui only when it reduces complexity. Use Lucide icons sparingly.
- **PostgreSQL with Supabase Auth and Row Level Security**, SQL schema/migrations under version control, and SSR-compatible auth session handling. Use only one persistence/access strategy; do not add an ORM without a concrete need.
- **Zod** or equivalent runtime validation at trust boundaries, even when TypeScript types exist.
- A **provider-agnostic server-side AI adapter** with versioned prompts and validated structured responses; configure the preferred model through environment settings without leaking its API key to clients.
- **Vitest** for unit/service tests; integration tests with a disposable isolated database; **Playwright** for browser E2E; **axe** checks for accessibility; ESLint, formatting, strict `tsc` and dependency/secret scanning in CI.
- Package manager and version choices must match the environment. Confirm current compatibility from installed tooling/documentation; do not assume framework APIs from memory or chase newest versions merely for novelty.

Do not use development bypasses in production paths. A local demo may use a test-only simulated AI adapter and clearly labeled fictional scenarios. The application must remain functional when live AI credentials are absent: save decisions, show an honest feedback-unavailable/retry state, and allow deterministic fixture-based review in test/demo mode only. Never present canned feedback as a live model response.

## 5. User experience and required screens

Design a serious, restrained professional working environment—not a campaign site, game, motivational dashboard, or generic SaaS analytics page.

Required P0 user journey:

**Private sign-in → Today → Open scenario → Read source/fiction labels and constraints → Save structured decision draft → Submit and lock version → Receive explainable five-lens challenge → Respond/dispute → Reflect → Accept/edit a development action → Return to history and inspect the complete trail.**

Screens:

**A. Today:** One prominent `Today's Decision` card; case sector, jurisdiction, “as of” date, 15-minute practice estimate, fictional/current status, recent activity, and open corrective actions. No fake activity counters and no composite readiness score.

**B. Decision Desk:** Readable case brief, decision window, role and resources, data gaps, competing legitimate interests, dated source register. Structured fields: objective, alternatives, recommended action, rationale, lawful authority to verify, resources/budget, affected stakeholders/equity, risks, assumptions, unknowns, confidence 0–100, expected outcomes, indicators, time horizon. Autosave/safe draft preservation, field validation, and explicit irreversible-submission confirmation.

**C. Challenge Review:** Five lenses: legal, financial, ethical/equity, operational, community. Each challenge points to a specific submission passage/assumption/constraint, shows source or uncertainty, identifies `fact`, `inference`, `hypothetical`, or `value judgment`, and permits an answer, rejection, or error flag. Never impersonate officials or present invented institutional views as fact.

**D. Reflection & Development:** Show provisional feedback for five dimensions (Knowledge, Judgment, Execution, Ethics, Learning), grounded supporting observations, evidence quality/confidence, and limitations. No promotion to independently verified competence by AI. User selects/edits a corrective action with owner, date, status, completion evidence and optional reassessment.

**E. History & Evidence Trail:** Search/filter or a usable simple list; each record reconstructs exact scenario version, original locked response, later revisions, generated challenges, model/prompt version, human responses, reflection, action and timestamps. Private export and deletion with explained retention limits.

Responsive for approximately 320px-wide phones upward, accessible keyboard navigation, visible focus, accessible labels, adequate contrast, error/empty/loading states, touch-friendly controls, and WCAG 2.2 AA as the target. Show no unclickable controls, misleading animations or sample metrics pretending to be personal history. Prefer calm typography and functional visual hierarchy over speculative visual effects.

## 6. Core domain invariants and data architecture

Implement explicit typed state transitions with server-side guards:

`scenario_available → draft → submitted_locked → challenged → reflected → action_recorded → reviewed/closed`.

Actual states may be modeled as orthogonal flags/entities if that is cleaner, but illegal transitions must fail predictably. Drafts are editable; submitted content must not be overwritten. Correcting a submitted answer creates a linked **DecisionRevision**. All challenge/assessment records must specify the exact submission revision and case version evaluated. Concurrent submissions must be idempotent or explicitly rejected, not duplicate a record.

Design relational tables/types as necessary for:
`User`, `Scenario`, `ScenarioVersion`, `Source`, `ScenarioClaimSource`, `Decision`, `DecisionRevision`, `ChallengeRun`, `Challenge`, `ChallengeResponse`, `Reflection`, `Assessment`, `DevelopmentAction`, `ReviewRecord`, `AuditEvent`.

Essential rules:
- Case content is versioned and snapshots cannot silently change underneath submitted decisions.
- Published factual claims are linked to accessible approved sources or explicitly marked scenario fiction/hypothesis; an unverified source is not “current news.”
- Persistent rows have ownership/authorization policies; enforce access at the DB/API layer, not by hiding client buttons. Never use a service-role key on the client. Test denial for another user's ID.
- Record audit events for submissions, revisions, challenge evaluations, action-state changes, exports/deletions and permission changes, while minimizing sensitive payloads in logs.
- Keep model-generated content clearly distinguished from user text and independently reviewed evidence. Do not store model-provider secrets, full private inputs in analytics, or unnecessary third-party personal information.
- Exports must be real usable JSON (plus human-readable export if convenient). Deletion must be real at the application data layer with clearly documented backup/retention behavior; no misleading immediate-erasure promise.

## 7. AI challenge architecture: grounded, resilient and testable

The AI is a critical collaborator, **not a final authority**. Design a typed interface for inputs/outputs and a bounded prompt pipeline:

**Inputs:** approved and versioned case facts, source IDs and claim mappings; user submitted decision revision; pre-authored evaluation rubric; one of five review lenses; prompt/model versions. Treat retrieved/source/user text as **untrusted data**, never higher-priority instructions.

**Challenge output schema (validate server-side):**
`lens`, `question`, `target_passage_or_assumption`, `evidence_refs[]`, `basis_type` (`fact | inference | hypothetical | value_judgment`), `uncertainty` (`low | medium | high | insufficient_evidence`), `risk_pathway`, `limitations`, `source_claims[]`. Choose clear representations; don't force imaginary citations.

**Formative assessment output schema:** per dimension, `observations[]` with quoted anchors, strengths, gaps, provisional rubric comment, evidence quality, and actionable next steps. Level 3 requires documented practice; level 4 requires independent human validation. The AI must never award these levels or automatically alter a validated assessment.

Controls:
1. Whitelist source identifiers against the approved case source registry; reject fabricated URLs/case references.
2. Detect/flag ungrounded legal, medical, financial and Guyana-specific claims; abstain where verification is not possible.
3. Display explanation and limitations with each review; do not use hidden opaque scoring as sole evidence.
4. Use schema validation, structured retries with caps, timeouts, request IDs, token/cost budgets, and bounded rate limits. Do not retry endlessly.
5. A failing AI call must not delete a draft, alter a locked answer, or falsely mark review completed. Provide clear retry/fallback states.
6. Version prompt templates, rubric version, model identifier and generation timestamp. Provide an offline mocked test adapter and fixed fixtures for deterministic testing.
7. Create a small adversarial AI evaluation suite covering prompt injection, missing citations, invented legal authority, contradictory case facts, sycophantic praise, stereotyping, and unjustified certainty. These are explicit release blockers when severe.

## 8. Security, privacy and ethical architecture

Prepare a threat model using realistic attacks: broken object-level authorization (IDOR), insecure direct API access, CSRF/session misuse, injection, stored XSS through journal fields/AI output, prompt injection in a scenario/source, leaked secrets, excessive model data sharing, privilege escalation, account deletion gaps and accidental public exposure.

Implement at minimum:
- Secure authentication/session management, RLS/ownership enforcement for every sensitive table, server-only secrets and least privilege.
- Strict input schemas, escaped rendering, content-security and other relevant headers, safe error handling, rate limits and no private content in application logs/telemetry.
- Transparent privacy notices and user-controlled export/deletion; consent boundaries for any future sharing.
- Protection from unrelated account data via predictable, testable row policies.
- No unapproved public publishing and no default reviewer access; authorization for any future reviewer sharing must be explicit, scoped and revocable.
- Safeguards against political manipulation/voter targeting and fake authority; any later Pathway data must be kept separate from this private learning workspace.
- A documented dependency audit and automated secret scanning.

## 9. Testing specification: quality gate, not decoration

For **each** P0 requirement, write an observable acceptance test and map it in `docs/requirements-traceability.md`.

**Unit tests:** field validation, state machine guards, competency assessment constraints, evidence reference validation, confidence bounds, draft-versus-submission behavior, action state transitions, data serializers.

**Integration/DB tests:** RLS prevents cross-account access; API authorization; actual transaction for locked submission; concurrent double-submit; revision links; scenario version consistency; audit events; export accuracy; deletion policy; AI idempotency and failure recovery.

**End-to-end browser tests:** new account → Today → scenario → draft/save/reload → submit → challenge → response/flag → reflect → create action → history → export. Include keyboard-only path, mobile viewport, error/retry path and visually verified empty/loading/error states.

**Adversarial tests:** source text saying “ignore instructions”; model-produced fake statute or URL; unapproved source ID; malicious journal markup; other user’s `decisionId`; model timeout; network interruption; browser refresh after submission; missing credentials; simultaneous sessions.

**Objective gates:**
- `typecheck`, formatting/lint, unit tests, integration tests, browser E2E, build, dependency/security checks, and accessibility checks pass in the documented environment.
- No known critical or high severity auth/privacy flaw remains. No critical source hallucination or AI policy failure in the curated release evaluation set.
- All P0 FRs have working tests; test coverage targets focus on core business logic and security boundaries (aim >=85% meaningful coverage of domain services, 100% tested critical invariants). Never chase a number via superficial tests.
- Repeatable setup using `README.md` and `.env.example` with no real secrets; migrations and seeded demo case work from a clean database.
- Responsive core flow functions at 320px viewport without horizontal overflow; accessibility failures are fixed rather than waived without justification.
- Results must include command, actual exit status, and relevant evidence. An unexecuted test is `NOT RUN`, not `PASSED`.

## 10. Build sequence and vertical slices

Follow the Superpowers implementation plan but favor this dependency order:

**Slice 0 — Discovery, guardrails and baseline:** read PRD/repo; install/test baseline; draft design, threat model, ADRs, traceability, `CLAUDE.md`; agree high-impact architectural decisions.

**Slice 1 — Secure foundation:** initialize app if needed; auth, DB migrations, user-owned data access, RLS/authorization test suite, environment config, CI.

**Slice 2 — Credible case content:** scenario schema, versioning, approved-vs-fictional indicators, source register and editorial state. Seed one explicitly fictional dengue-training case with no unverified real-world claims; establish an authoring/review mechanism or documented import pathway for the 10–15 reviewed cases the PRD anticipates.

**Slice 3 — Decision workflow:** Today and Decision Desk, structured journal, reliable draft persistence, locking/submission transaction, revision history, concurrency protection and full tests.

**Slice 4 — AI and challenge:** AI adapter, versioned prompts, validated five-lens structured feedback, evidence matching, abstentions, timeout/retry UX, injected-source defense and deterministic fixtures.

**Slice 5 — Reflection and development:** five-dimensional feedback with no misleading single score; action creation/updates; evidence trail; real history, export and deletion features.

**Slice 6 — Hardening and UX:** 320px responsive QA, keyboard/axe audit, security sweep, crash/reload resilience, realistic error paths, CI checks, clean README and end-to-end rehearsal.

P1 monthly review, extra cases, mentoring and retrospective reminders can enter only after all P0 gates pass and with explicit scope approval.

## 11. Autonomous review gates to counter common AI coding failures

At the end of every slice, conduct **two independent passes**:

**Pass A: Requirements/behavior audit.** Another fresh-context reviewer checks the PRD and tests, flags missing behavior, mock-only behavior, scope creep, broken states and false acceptance claims. Output specific findings with `file:line`, severity, reproduction and fix recommendation.

**Pass B: Engineering/adversarial audit.** A fresh reviewer checks security, authorization, data integrity, async race conditions, input/response validation, hallucinated APIs, hidden coupling, performance, accessibility, leakage of secrets and reliability under failures. Attempt at least one misuse test per trust boundary.

Then implement fixes, rerun the affected and full regression tests, and record before/after evidence. If CodeX/Codex tooling is accessible, you may use it as **an optional independent reviewer** (not as a fictional tool call); independent evaluation is more valuable than claims that one model is intrinsically superior.

**Anti-self-deception rules:**
- Do not silently reduce scope, omit failing tests, mark TODO placeholders complete, or substitute static mock screens for working APIs.
- Do not dismiss failing tests as “probably environment issues” without root-cause investigation and proof.
- Do not add a database migration without actually applying and testing it in an isolated environment.
- Do not say “secure by default” without attempting hostile unauthorized requests.
- Do not invent user acceptance, legal approval, external review or production metrics.
- Do not claim “done” if only the happy path works. Provide a candid gap and risk register.

## 12. Definition of done and final handover

You may say **MVP technically complete for pilot review** only if:

1. A fresh user can sign in and complete the full STATESMAN learning loop using actual persisted records.
2. Submitted snapshots stay immutable and all later changes are linked revisions.
3. Cross-user reads/writes are denied in automated tests and checked at API/DB boundaries.
4. Case/source/fiction boundaries and model feedback labels display correctly; missing evidence produces abstention rather than made-up support.
5. User can resume drafts, survive model failures, view history, export records and initiate supported deletion.
6. Every P0 requirement has demonstrated passing acceptance evidence; all documented core quality checks execute successfully or an explicit release block is declared.
7. Another reviewer has examined requirements and code; critical/high issues are resolved and rerun.
8. The repository has a reliable README: setup, credentials, seed, run, test, release, backup and limitations, plus `.env.example`, migrations, CI, ADRs, AI-evaluation instructions and threat model.
9. No deployment to production or expenditure is performed without explicit user authorization.

Final response format:

**A. What is built:** links/paths and concise completed user flows.
**B. Requirements trace:** P0 pass/fail/deferred items and evidence locations.
**C. Verification:** exact commands, outcomes, test totals, CI/build status and visual/a11y checks.
**D. Security/AI audit:** findings, mitigations, residual risks, reviewer provenance.
**E. Runbook:** exact commands to set up, run, seed and test locally.
**F. Incomplete or blocked:** honest list of items awaiting credentials, external review, source approval or deployment consent.
**G. Next recommended single step:** highest-value bounded follow-up, no unauthorized scope expansion.

## 13. Begin now

1. Confirm you can read the attached full PRD and the actual repository. Identify P0 scope and exclusions in a concise table.
2. Check Superpowers installation and applicable skills. Inspect repo state and baseline commands.
3. Produce architecture + data/privacy boundaries + FR/NFR traceability + implementation plan, invoking the real Superpowers workflow.
4. Implement the first vertical slice with red/green/refactor TDD and real command execution; continue slice by slice within granted permissions.
5. Never trade documented engineering evidence for confidence, speed, polished prose, or a visually persuasive but nonfunctional demo.

**Your operating principle: Build less, prove more. The product succeeds only when users can practise decisions safely, receive honest challenges, and demonstrate improved reasoning through evidence.**
