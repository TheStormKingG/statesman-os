# STATESMAN OS — Recorded Decisions

**Doc ID:** SOS-DECISIONS-001
**Date:** 2026-10-20
**Status:** Live register. **Nothing in this file is implemented or executed.**
**Derived from:** `docs/superpowers/specs/2026-10-20-statesman-os-p0-mvp-design.md`
(SOS-DESIGN-001, the canon) §12.2; `docs/MASTER_PROMPT.md` §0.2; `docs/PRD.md` (SOS-PRD-001 v1.0).

> `MASTER_PROMPT.md` §0.2 sets the precedence order — (1) law, platform security requirements and
> explicit user approvals; (2) the PRD's purpose, privacy and safety boundaries and P0 acceptance
> criteria; (3) the master prompt; (4) implementation preferences — and requires conflicts to be
> **recorded here instead of silently changing product intent**. This file is that record.
>
> The canon outranks this file. Where the two disagree, the canon wins and this file is the bug.
> ADR numbers are owned by `docs/adr/README.md`; the numbers cited below are the canon's own
> pointers, not allocations made here.
>
> No entry claims review, approval or sign-off by anyone, because none has occurred. No entry
> records a measurement, because nothing has been executed.

---

## 1. Departures from `MASTER_PROMPT.md` §4 defaults

The master prompt's §4 is explicitly conditional — "validate against the actual repo" — but a
default replaced in silence is indistinguishable from a default forgotten. Each replacement is
therefore named with the decision that carries it.

| # | Master prompt §4 default | What this build does instead | Carried by |
|---|---|---|---|
| D1 | "PostgreSQL with **Supabase Auth** and Row Level Security" | Own session-cookie authentication with a server-side session table. RLS is kept and strengthened: enabled **and forced** on every user-owned table, policies carrying tenancy only and omitting the `TO` clause | ADR-0002 (canon §6); canon §4.3, §6 |
| D2 | A managed Postgres (the Supabase default implied by D1) | **Local Homebrew PostgreSQL 17.11. No Docker, no Supabase.** One named port seam is preserved — `app.current_user_id()`, a thin non-raising alias standing in for `auth.uid()`, which no policy references | ADR-0001 (canon §2) |
| D3 | "Use only one persistence/access strategy; do not add an ORM without a concrete need" | **Followed, not departed from.** `pg` (node-postgres) with hand-written SQL migrations; no ORM. Recorded here because the constraint is load-bearing for every other decision in this file: the security model lives in SQL, so a second access path would be a second, unaudited security model | Canon §2 |

**What D1 costs, stated plainly.** Replacing a managed auth provider moves password hashing,
session lifetime, token storage, rate limiting and privilege invalidation into this codebase.
That is the reason canon §6 pins each of them rather than leaving them to judgement, and the
reason the deliberate cuts below are recorded as decisions rather than omissions:

- **No password pepper.** It would live in the same environment as `DATABASE_URL`, so it does
  not survive the compromise it exists for (canon §6).
- **No account lockout and no instance-wide circuit breaker.** On a single-user application a
  lockout is a one-line attacker trigger with a worse blast radius than the attack. Rate
  limiting is a per-identifier progressive delay; the aggregate threshold raises an alert, never
  a block (canon §6).

---

## 2. Requirements deferred against PRD intent

The PRD defers nothing in §11. These deferrals are therefore **ours**, and the PRD's text stands
unaltered above them.

### D4 — NFR-06 (availability objective ≥ 99.5% monthly) — DEFERRED

**Decision:** deferred for P0. The register reads `DEFERRED`; it does not read `PLANNED`.

**Why.** Monthly availability is measurable only from pilot operation over a month of real
uptime. No pre-release instrument can produce the figure, and no amount of local testing
approximates it. The alternatives were worse in both directions: marking it `P0 / PLANNED`
would promise a gate no command can run, and marking it met would be a fabricated metric.

**What would discharge it.** Pilot operation with an uptime record, which is an operational
input this plan does not have. Until then it is an open release item, not a satisfied
requirement.

### D5 — NFR-07 (core screen load ≤ 3s at a typical mobile connection) — DEFERRED

**Decision:** deferred for P0, on the same basis as D4. The register reads `DEFERRED`. NFR-07
appears in **no** gate in `docs/implementation-plan.md` §11, and it carries no implementation
path, because a path no task creates is a defect (canon §12).

**Why.** Canon §12.2 offers exactly two honest options: build a throttled-CPU/network Playwright
budget spec with its own positive control, or defer. Deferral is chosen because the PRD's
condition is "in pilot performance tests at a typical mobile connection" — a property of real
network conditions, not of a throttling profile chosen to make a number pass. A budget spec
against a self-selected throttle would measure the throttle. The forbidden third option is the
one being avoided: `P0 / PLANNED` with an implementation path nothing creates, which reads as
coverage and is not.

**What would discharge it.** A pilot performance measurement on a representative connection, or
a later decision to add the throttled budget spec — which would then need its own positive
control (a deliberately slow page the budget must **fail** on), since a budget gate that has
never failed has not been shown to work.

### D6 — FR-16 and NFR-02 manual verification legs

**Decision:** both keep a `manual` verification leg. Each names an evidence record — the
retention and backup disclosure for FR-16, the deployment-encryption record for NFR-02 — and
each requirement reaches **at most `NOT RUN`** in the volatile report until that record exists
and is referenced from its traceability row (canon §12.3).

**Why.** Whether a privacy notice states the real retention behaviour is a reading, not an
assertion. The failure mode this guards against is a manual leg that silently counts as
discharged because nothing can contradict it. No sign-off name and no date is to be invented in
either record.

**NFR-02 additionally carries open item O1:** encryption at rest has no mechanism — Postgres has
no TDE. FileVault locally, a managed or encrypted volume on any deploy. Declared an open release
item, not silently met (canon §9).

---

## 3. Thresholds that are passed at discretion unless written down

### D7 — Coverage threshold: scoped, not global

`MASTER_PROMPT.md` §9 asks for ">=85% meaningful coverage of domain services, 100% tested
critical invariants". Canon §8.7 says coverage thresholds apply to domain services and security
boundaries with no global percentage target. These are **not** in conflict, and the apparent
conflict is why the number went missing: 85% scoped to domain services is not a global target,
so "no global target" does not discharge it (canon §12.2).

**Decision — both halves configured:**

1. **85% statements and 85% branches, scoped** to the domain-service directories
   (`src/server/decision/**`, `src/server/challenge/**`, `src/server/assessment/**`,
   `src/server/development/**`, `src/server/export/**`, `src/server/history/**`,
   `src/server/validation/**`) plus the security boundaries (`src/server/db/**`,
   `src/server/auth/**`), enforced by the `coverage:check` gate.
2. **100% of the canon §4.4 critical invariants**, asserted by structural tag through
   `trace:check`, not by line coverage.

**Why both, and why not one number.** A repository-wide percentage is met by testing whatever is
cheapest to test, which is the behaviour canon §8.7 rejects. And line coverage cannot stand in
for the invariant half: a line executed by a test that asserts nothing is covered and unverified.
The invariant requirement is about assertions, so it is measured by tags on tests that assert.

Neither `docs/implementation-plan.md` nor `CLAUDE.md` may be silent on this number.

### D8 — Dependency audit threshold

**Decision:** `npm run audit` **blocks** on any `high` or `critical` advisory in production
dependencies. `moderate` and `low` advisories are recorded in the gap register and do not block.
The threshold is stated in `CLAUDE.md` and in the gate table of `docs/implementation-plan.md`
§11 — not only in the script's flags, where a later edit would change the gate without changing
any document.

**Why it is recorded at all.** A blocking gate whose threshold is defined nowhere is passed at
discretion: whoever runs it decides what counts, and the decision is invisible afterwards
(canon §12.2). Development-only advisories are excluded deliberately, because a dev-dependency
advisory that cannot reach a production path otherwise trains the team to wave the gate through.

---

## 4. Decisions carried elsewhere, indexed here

These are not departures; they are decisions whose reasoning lives in the canon and would
otherwise be re-derived from memory.

| # | Decision | Where it is carried |
|---|---|---|
| D9 | Keep `FORCE ROW LEVEL SECURITY`; the reviewer dissent's cause was scoping policies `TO statesman_app`, not `FORCE` itself | ADR-0003 (canon §10) |
| D10 | argon2id parameters pinned to `memoryCost = 19456` KiB, `timeCost = 2`, `parallelism = 1`, 16-byte salt, 32-byte output — a decision, not a measurement, with the option names read back from the installed release and a unit test asserting the call uses exactly these values | ADR-0002 (canon §6) |
| D11 | AI mode is an explicit `STATESMAN_AI_MODE` of `live \| fixture \| unavailable`, defaulting to `unavailable`, and **never** keyed on the absence of `ANTHROPIC_API_KEY` | Canon §7.1 |
| D12 | The full 0–4 assessment domain stays in the database while the **AI** is constrained to ≤ 2 by check constraint. The AI is constrained, not the product | Canon §5.1; `PRD.md` §1.4 principle 7 |
| D13 | FR-13 reviewer sharing is deferred, and the MVP ships **no** global `role` column. A global role cannot express per-item scoped revocable sharing; the recorded design is a `record_share` table | Canon §9 (O6) |
| D14 | No composite readiness, character or viability score exists anywhere in schema, API response or UI — prohibited, not merely deferred | Canon §1.2; `PRD.md` §1.4 principle 7 |

---

## 5. How to add an entry

An entry belongs here when a choice departs from PRD intent or from a `MASTER_PROMPT.md`
default, or when a gate's threshold would otherwise exist only inside a script. Each entry
states the decision, what it costs, and what would discharge or reverse it. An entry that
records only the decision is half an entry: the cost is the part a later reader cannot
reconstruct.

Nothing here records an outcome. Status vocabulary is **PLANNED**, **DEFERRED**, **NOT RUN** and
**OPEN RELEASE ITEM**. There is no `PASS` in this document.
