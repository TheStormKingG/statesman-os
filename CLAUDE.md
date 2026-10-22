# CLAUDE.md — STATESMAN OS

**Repo status: slices 1 and 2 built; no screens.** This line was "pre-implementation. No
`package.json`, no application code" and is corrected here because it was read first by every
session and was false in three ways.

Deliberately NOT an inventory of files or a test count — §8 says a sibling inventory is stale
on arrival, and that is exactly how the previous version of this line became false. Three
things that are durable and that an agent gets wrong by default:

1. **The migration set is applied to a live Supabase project**, not only to the local
   emulation, and both SQL gates pass there (`app.verify_security_posture()` / ST099 and
   `app.verify_rest_exposure()` / ST097). Changes to `supabase/migrations/**` therefore have a
   deployed consequence. ADR-0015 and ADR-0016 carry what that costs.
2. **No screen exists.** Not Today, not the Decision Desk, not Challenge Review, Reflection or
   History. A static shell is deployed; it renders no product surface on purpose.
3. **No account has ever signed in.** No code path that reads a user's own rows has been
   exercised end to end against the live project, so every claim about tenancy rests on the
   integration suite and the mutation gate, which run against the emulation.

For what is actually built right now, read `git log`, `package.json` and
`reports/` — not a paragraph in this file.

**The evidence rule is unchanged and matters more now, not less.** Do not describe any part of
this repository as working, verified, secure, tested or production-ready without the command and
its exit status alongside (§9). "The gates pass" is a claim about `scripts/gates.sh`, which runs
with no credentials and no network; it is not a claim about the live project.

**Canon.** `docs/superpowers/specs/2026-10-20-statesman-os-p0-mvp-design.md` (SOS-DESIGN-001) is the
single source of truth; it carries 36 facts V1–V36 established by executing commands — V1–V29
against this machine on 2026-10-20, V30–V36 added by the Supabase port, several of them measured
against the live project rather than the emulation. `docs/PRD.md` (SOS-PRD-001 v1.0) holds FR-01–FR-19 and NFR-01–NFR-10 —
preserve those identifiers verbatim.

This file is a behaviour patch, not a summary: it holds only what an agent gets wrong by default.
Read the canon before designing and the PRD before claiming a requirement is met. Where this file
disagrees with the canon, the canon wins and this file is the bug.

## 1. What this project is

A private, single-user web application for practising evidence-grounded public-leadership decisions:
a sourced governance scenario, an answer frozen as an immutable revision, an AI challenge from five
professional lenses with every citation checked against an approved claim registry, diagnosed gaps
becoming dated development actions with completion evidence. It is a practice-and-evidence system —
**not** a campaign tool, an election predictor, a certification or a live-crisis adviser. Four P0
components — Decision Desk, Decision Journal, Challenge Review, Development Plan — plus the private
workspace they require; Today and Reflection are supporting surfaces, not products. FR mapping,
screens, acceptance conditions and NFR targets live in `docs/PRD.md`; schema, security model, AI
contract and test doctrine live in the canon. Do not restate either here.

## 2. Hard prohibitions

Not deferrals. Do not build these, prototype them, or leave a seam that invites them.

- **No composite score** of any kind — no readiness, character, viability or fitness index, and no
  summing or averaging of the five dimensions. Show a multidimensional profile plus evidence quality.
- **No voter profiling or segmentation**, targeted political messaging or persuasion tooling.
- **No AI-awarded maturity level 3 or 4.** Level 3 needs documented real-world practice, level 4 a
  qualified human reviewer. The AI awards neither and never alters a `human_reviewer` row.
- **No fabricated citations, statutes, case references, URLs or institutional positions.**
  Unsupported means abstain or state the uncertainty.
- **No impersonation of real officials, institutions or communities**, and no invented institutional
  view presented as fact.
- **No simulated outcome presented as a forecast.** Simulated consequences are labelled teaching
  devices and cannot establish what another policy choice would have done.
- **No public exposure of journal content** — nothing published, shared by default, or reachable by a
  future Pathway/Service product (FR-19).
- **No leaderboards, XP, punitive streaks, social feeds or public profiles.**

**Guyana editorial boundary.** Guyana-first is editorial context, not licence to invent Guyanese
statutes, legal provisions, budgets, prices, institutional positions, incidents or health data.
Seeded scenario content is labelled fictional and carries an as-of date.

## 3. The invariants

Canon §4.3, §4.4, §6.1. Follow these without re-reading the canon; the bracketed Vn is the proof.

**Database**

- **Policies carry tenancy only:** `using (user_id = app.require_user_id())`, same expression in
  `with check`. **Never a `TO` clause** — it makes the table unreadable by the owner and by the
  definer functions (V9). **Never a state predicate** — RLS must not encode transitions; it makes a
  404 indistinguishable from a 409 (V7).
- **`app.require_user_id()` stays `STABLE`, never `IMMUTABLE`.** An `IMMUTABLE` variant was proven to
  leak one user's rows to another from a prepared statement's second execution onward.
  `verify_security_posture()` asserts `provolatile = 's'`.
- **A row count of 0 is never a success signal.** A failing `USING` clause affects zero rows and
  raises nothing (V7); a cross-user `DELETE` returns `DELETE 0`, byte-identical to deleting a
  nonexistent id (V19). **Every privileged write asserts its row count:**
  `get diagnostics n = row_count; if n <> 1 then raise … end if;`
- **`state` is a generated column, and a transition trigger must NEVER read `NEW.state`.** It is NULL
  in `BEFORE UPDATE` on a generated column (V28), so a trigger that reads it compares against NULL on
  every transition and therefore permits everything or rejects everything — inert, not merely wrong.
  Derive the **prospective** state instead: call the same `IMMUTABLE`
  `app.derive_decision_state(submitted, challenged, reflected, action_recorded, closed)` the generated
  column is computed from (V29), then compare `OLD.state → prospective` against a whitelist and raise
  an uppercase SQLSTATE. That function casts **each `CASE` branch** to the enum, never the `CASE`
  result (V12). One definition serves column and guard, so they cannot drift; required control is a
  meta-test over all 32 timestamp combinations asserting function and stored column agree.
- **Every new `SECURITY DEFINER` function needs an explicit `GRANT EXECUTE`** to `statesman_app`
  alone — `PUBLIC` receives `EXECUTE` by default (V2), and `REVOKE … ON ALL TABLES` does not touch
  `EXECUTE`. Canon §4.6 fixes the set at **nine**, owned by `statesman_owner` with `search_path`
  pinned; a tenth arrives with its own grant. A uuid parameter is tolerable only on the pre-identity
  path (`app.create_session`); once identity exists a call derives it internally and takes no uuid,
  as `app.erase_self()` and `app.get_profile()` do.
- **Every new view over user data needs `WITH (security_invoker = true)`** — otherwise it executes
  with its owner's privileges (V11).
- **Every new table, in the same migration:** `user_id uuid NOT NULL`; a **composite** FK to the
  parent's `(id, user_id)`; `enable` **and** `force row level security`; explicit per-table grants
  (there is deliberately no `alter default privileges … grant` on tables, so a forgotten grant yields
  an invisible table, not an exposed one); one sentinel row. It fails `verify_security_posture()`
  until all of these exist — intended, not a bug in the check.
- **Custom SQLSTATEs are UPPERCASE**, round-trip tested: `'st010'` silently resolves to `42704` (V13).
- **Schema-qualify every reference** in a policy, trigger, guard or definer function, and pin
  `search_path`. The app role keeps `PUBLIC`'s `TEMPORARY` privilege unless revoked, and a temp table
  shadows an unqualified reference to a real table (V22).
- **A data backfill brackets `no force` / `force` in the same migration file.** Under `FORCE` an
  owner-run `UPDATE … WHERE true` affects zero rows and raises nothing, and `SET row_security = off`
  is refused (V8). A lint rejects an unmatched `no force`.

**Application**

- **`withUser` takes NO session argument, and the `Pool` is module-private.** It calls
  `requireSession()` itself. An identity arriving as an argument type-checks perfectly when handed a
  victim's id, and RLS then faithfully enforces the attacker's choice; removing the parameter removes
  the channel.
- **`pg` is importable only from `src/server/db/**`,** enforced by an AST check that sees static
  imports, `require` and dynamic `import()`. `no-restricted-imports` matches the specifier string,
  not the resolved path, and a grep for `new Pool(` is evaded by an alias.
- `withUser` validates context **eagerly** (`select app.require_user_id()` after `set_config`) —
  with no context set, a query for a nonexistent id returns rc=0, zero rows and no error (V6). It
  ends with `DISCARD ALL` before release.

**Also wrong by default**

- A partial unique index over a nullable column needs `NULLS NOT DISTINCT` (V14).
- `on delete restrict` from `app_user`, **never cascade** — a cascade silently destroys the audit
  history NFR-03 and FR-16 require. `app_user`, `user_session` and `auth_attempt` get **no direct
  grants**; grant-absence is strictly stronger than RLS.
- `STATESMAN_AI_MODE` is explicit (`live | fixture | unavailable`, default `unavailable`) and
  **never** keyed on a missing `ANTHROPIC_API_KEY` — a missing key in `live` mode renders the NFR-08
  unavailable/retry state, it does not fall back to fixtures.
- Immutability needs `BEFORE UPDATE OR DELETE` triggers **and** `BEFORE TRUNCATE … FOR EACH
  STATEMENT` (`TRUNCATE` bypasses row-level triggers, V15) **and** absent grants.
- The model call happens **outside** the write transaction; a failing AI call must not delete a draft,
  mutate a locked revision, or mark review complete.

## 4. Test rules

- **No gate without a positive control.** The adversarial pass found 56 gates that would pass while
  exercising nothing. **A test that cannot be made to fail has not been shown to work.**
- **Every denial test is paired with an after-state read:** `A sees the row (1) → B sees 0 → B's
  write raises nothing → A still sees 1`. Then, inside a rolled-back transaction, drop the policy and
  assert the row becomes visible. A bare `rowCount === 0` proves nothing (V19).
- **Empty tables prove nothing** — with RLS and without, both return 0 to the app role (V18). Assert
  against seeded sentinels both ways: no context → 0 everywhere; as the sentinel user → exactly 1.
- **Tests connect as `statesman_app`, never as the login superuser.** The login role
  `stefangravesande` is `rolsuper=t, rolbypassrls=t` and `pg_hba.conf` is `trust` for
  local/127.0.0.1/::1 (V1) — so a superuser connection bypasses RLS and every isolation test passes
  vacuously, and a typo'd username in `DATABASE_URL` connects *successfully* as whatever role it
  names, with no password error. Assert role identity at runtime in the data path; the fixture makes a
  wrong-role connection loudly fatal.
- **An unexecuted test is `NOT RUN`, never `PASSED`.** A requirement is `PASS` only if a tagged test
  exists, ran and passed, and that outcome lives only in volatile `reports/`. The committed
  `docs/requirements-traceability.md` may carry a *design* status from `{PLANNED, DEFERRED}` and **no
  run status at all** — `PASS`, `FAIL` and `NOT RUN` are not representable in it (the test is
  determinism: would the value change if the same commit were checked twice without an edit?).
  Coverage is matched by structural tags emitted into `reports/tags-*.json`, never by parsing test
  titles — silently empty for every `it.each` test.
- **Coverage thresholds are scoped, never global:** 100% of the canon §4.4 invariants (state,
  immutability, row counts), plus a configured threshold on `src/server/domain/**` and the security
  boundaries. Master prompt §9's ≥85% is itself scoped, so "no global percentage target" does not
  discharge it — configure it there, or record in `docs/decisions.md` why the invariant rule
  supersedes it. Both documents silent on it is the defect.
- **A `manual` verification leg (FR-16, NFR-02) names its evidence record** (e.g.
  `docs/reviews/retention-notice.md`) and reaches at most `NOT RUN` until that record exists and the
  row references it. Invent no reviewer name and no date.
- Every instrument needs a test in which it must report the negative — `waitUntilBlocked` must return
  `false` for two sessions locking different rows. An unguarded read-then-write never blocks (V23),
  and a non-privileged observer of `pg_stat_activity` sees `state` and `wait_event_type` as NULL
  (V24), so "cannot observe" otherwise reports as "never blocked".

## 5. Commands

**Environment prerequisites**

- `export LC_ALL=en_US.UTF-8` — without it the postmaster aborts on this macOS build: *postmaster
  became multithreaded during startup* (V27). Every script and every shell exports it.
- `brew services start postgresql@17` — the running server is **not** brew-managed and will not
  survive a reboot (V26).

**PATH.** An interactive shell finds `psql` 17.11 on `/opt/homebrew/bin`, but launchd, a CI runner or
a bare `sh -c` may not carry it. Scripts therefore export PATH or call
`/opt/homebrew/opt/postgresql@17/bin/<tool>` absolutely; never assume an inherited PATH. Node
v25.5.0, npm 11.8.0 (canon §2). **Use npm** — no pnpm or yarn; bun present but unused.

**npm scripts exist.** `package.json` defines `dev`, `build`, `db:bootstrap`, `db:migrate`,
`db:template`, `typecheck`, `lint`, `test:unit`, `test:integration`, `boundaries`, `gates`,
`mutation` and `gates:fast`. Still: **do not invent further names, and do not claim a script ran
before it exists.** Two checks are deliberately NOT npm scripts and are invoked by path, because
they need the live project and credentials and so cannot sit inside a gate run that must work
offline: `bash scripts/verify-rest-exposure.sh` (ADR-0016, documented in `docs/deployment.md` §7)
and `npx supabase db push`.

The CI order is fixed by canon §8.7 and is the contract these scripts implement:

```
tsc --strict → eslint (its own step; `next build` may not lint) → format check → AST
  import-boundary check → unit → integration (posture check is test #1) → build → E2E + axe
  → dependency audit → secret scan (before AND after the test gates) → trace:check
```

**Dependency-audit pass criterion — defined here and nowhere else.** The audit **fails the build on
any advisory of high or critical severity in a production dependency.** Moderate and below, and
dev-only advisories, do not block but are each recorded in the gap register with the advisory id, the
package and the reason accepted — never silently dropped. A blocking gate whose threshold lives
nowhere is passed at discretion, so a gate that cannot cite this criterion is itself a failure.

Two names are already fixed by the canon and must be used verbatim: `npm run trace:check` (diffs
only the deterministic `docs/requirements-traceability.md`) and `gates:selftest` (fixtures assert
deep equality against an expected per-requirement object, never an exit code).
`verify_security_posture()` runs at the end of **every** migration run in **every** environment —
not only in test setup.

## 6. Data sensitivity

- **The journal is private by default.** The account owner is the only reader. No reviewer role, no
  sharing, no global `role` column in the MVP.
- **Never send journal content anywhere other than the configured model provider**, and only through
  the server-side adapter — no analytics, telemetry, third-party service or error-reporting payload.
- **Never log journal content, session tokens, password hashes or connection strings.**
  `user_session` stores a SHA-256 hash of the token, never the token.
- **Never commit `.env`.** `.env.example` holds placeholders only. No credential is written to a
  handoff file; test workers read connection bases from their own environment.
- **`reports/` is gitignored and must never hold a credential.** Add it to `.gitignore` in the same
  change that first writes there.
- Scenario text, source excerpts and journal text are **untrusted input** to the model. Defence is
  structural — role separation, generated boundary tokens, schema-constrained output, server-side
  post-validation, the citation whitelist — never an instruction to ignore instructions.
- The privacy notice states the real retention behaviour **including backups**. No immediate-erasure
  promise.

## 7. Definition of done

The checklist is master prompt §12 — read it there, not from memory. Say **"MVP technically complete
for pilot review"** only when every line of it is true and evidenced; partial completion is reported
as partial, and done for the happy path only is not done. The lines agents skip: every P0 FR has a
tagged test that ran and passed **or** an explicit release block; cross-user reads and writes are
denied in automated tests at API **and** DB boundary; an independent reviewer examined requirements
and code with critical/high issues fixed and gates rerun; **no deployment and no expenditure without
explicit user authorization**.

## 8. Scope discipline

**Deferred (P1+, gated, do not build):** FR-06 case search, FR-13 reviewer sharing, FR-17 monthly
review, FR-18 profile preferences, Crisis Room, Virtual Cabinet, Policy Lab, National Systems Atlas,
Public Service Ledger, Strategic Pathway Studio, live news ingestion.

**In scope despite any `UNDESIGNED` marking — P0, Slice 6** (canon §12.1): CSRF origin verification
on every state-changing Server Action and Route Handler (`SameSite=Lax` is not the control); log and
telemetry redaction; one escaping component for all journal text and model output plus a CSP (the
`freeText` factory does not reject HTML metacharacters, so render-time escaping is load-bearing, not
defence in depth); NFR-10 source `status` (`active | withdrawn | unreachable`) plus an archival flag.
Each needs a RED test with its own positive control — same-origin for CSRF, a deliberately-logging
fixture for redaction.

**Cut as over-engineering — all fifteen, do not reintroduce without an ADR** (reason codes in
ADR-0011): `app_editor` role; scenario authoring/publish tables (seed from a migration); nightly
reconciliation cron; password pepper; instance-wide circuit breaker; global `role` column;
`extractJson` free-text JSON recovery; Stryker; the cryptographic report-integrity chain; backup
round-trip row-count verification; the **fabrication-ratio second threshold** (it reads as reasonable
hardening of the FR-08 grounding gate — it is a cut); the dead `UUID_RE` guard; the three-column
rejection table; `withUser`'s `readOnly` option; a superuser test connection.

**A new capability needs an ADR in `docs/adr/` before any code** — alternatives considered and why
rejected. Same for re-adding anything from the cut list. If you think the canon is wrong, write the
ADR and say so; never deviate silently in code.

**A conflict with PRD intent is recorded, not silently applied** — it goes in `docs/decisions.md`
(canon §12.2). Live ones: the NFR-06 availability deferral (measurable only from pilot operation);
NFR-07 core-screen load, which gets either a throttled Playwright budget spec with its own positive
control or an honest deferral, and may **not** sit at `P0 / PLANNED` behind an implementation path no
task creates; and the coverage threshold in §4.

**One owner per namespace** (canon §12); every other document matches it instead of defining its own.
`requirements.yaml` owns requirement, `INV-nn` and `INS-nn` ids and the design status, and
`requirements-traceability.md` is a deterministic render of it — divergence down to punctuation and
US spelling fails `trace:check`. `threat-model.md` owns `TB-1..TB-9`, `T-nn` and `TC-SEC-nnn`, which
must also appear in `requirements.yaml` under `threats:` or no tagged test can match them.
`implementation-plan.md` owns migration filenames and file layout; `implementation_paths` is
rewritten to match it, never the reverse. `docs/adr/README.md` owns ADR numbers; a reference to an
unwritten ADR needs a committed reserved number. **No document asserts which other documents
exist** — that no application code exists is durable; a sibling inventory is stale on arrival.

Do not re-litigate settled decisions from memory. `FORCE ROW LEVEL SECURITY` stays (ADR-0003).
Framework and library behaviour — lint flags, option keys, API shapes — is settled by running a
command against the installed tooling and recorded in the ADR that cites it, never recalled.

## 9. Evidence discipline

- Never write **verified**, **secure**, **production-ready** or **tests pass** without the command
  and its exit status alongside. Cite file paths, commands, exit codes and test identities — not
  prose. A test you wrote but did not run is `NOT RUN`.
- In a **committed** document a status field reads `PLANNED` or `DEFERRED`; `PASS`, `FAIL` and
  `NOT RUN` are outcomes of an execution and belong only in volatile `reports/`.
- **Record a genuine blocker as a blocker.** Missing credentials, an unapplied migration, an
  unreviewed rubric, a failing gate — these go in the gap register unresolved. Do not mask them with
  a mock, a screenshot, a skipped test or a narrowed assertion.
- Do not dismiss a failing test as an environment issue without a root cause and proof.
- Never invent a date, metric, approval, review sign-off or calendar commitment. Complexity
  estimates are allowed; schedules are not.
