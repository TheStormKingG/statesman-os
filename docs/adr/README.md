# Architecture Decision Records — STATESMAN OS

These records derive from the canon, `docs/superpowers/specs/2026-10-20-statesman-os-p0-mvp-design.md`
(SOS-DESIGN-001). Where an ADR disagrees with the canon, the canon wins and the ADR is a bug.

**Implementation has not started.** There is no application code, no migration, no test and no
CI pipeline in this repository. Every ADR below records intent and design rationale. Status
fields inside them read PROPOSED, PLANNED, NOT RUN or DEFERRED; none reads PASS.

The `V1`–`V29` citations are the canon's verified facts register (canon §3). Each row there was
established by executing a command against this machine on 2026-10-20. ADRs cite them rather
than re-deriving the behaviour.

`RESERVED.md` lists ADR numbers that other documents already cite but that are not yet written,
with one line each on what will fill them (canon §12).

## Index

| ADR | Title | Status | Summary |
|---|---|---|---|
| [0001](ADR-0001-local-postgresql-instead-of-supabase.md) | Local PostgreSQL instead of Supabase | Accepted | No container runtime on this machine, so the Supabase local stack is unavailable; use the running Homebrew PostgreSQL 17.11 cluster with `pg` and hand-written SQL, keeping the schema portable behind one auth shim. |
| [0002](ADR-0002-own-session-cookie-authentication.md) | Own session-cookie authentication | Accepted | Server-side session table storing only a SHA-256 token hash, argon2id passwords at pinned parameters (19456 KiB, 2 iterations, 1 lane, 16-byte salt, 32-byte output), conditional idle sliding, epoch-triggered session deletion; the pepper is cut because it would share `DATABASE_URL`'s blast radius. |
| [0003](ADR-0003-keep-force-rls-omit-to-clause.md) | Keep FORCE RLS, omit the TO clause | Accepted | The adjudicated disagreement: one reviewer recommended dropping `FORCE`, three keeping it; kept, because the dissent's cause was policy scoping (V9), with the V8 silent-backfill cost accepted and handled by bracketing plus a lint. |
| [0004](ADR-0004-rls-carries-tenancy-only.md) | RLS carries tenancy only | Accepted | A failing `USING` clause raises nothing (V7) and makes 404 indistinguishable from 409, so state transitions and immutability live in triggers, generated columns and absent grants instead. |
| [0005](ADR-0005-privileges-fail-closed.md) | Privileges fail closed | Accepted | Functions are revoked from `PUBLIC` with `ALTER DEFAULT PRIVILEGES` and granted one line at a time (V2, where a cross-user deletion exploit was demonstrated); tables deliberately have no default grant, so a forgotten grant hides a table rather than exposing it. |
| [0006](ADR-0006-withuser-takes-no-session-parameter.md) | `withUser` takes no session parameter | Accepted | Passing identity as an argument type-checks when handed a victim's id and makes RLS enforce the attacker's chosen identity; the guard resolves the session itself and returns a branded client, with `as` assertions banned by an AST check. |
| [0007](ADR-0007-explicit-ai-mode.md) | Explicit `STATESMAN_AI_MODE` | Accepted | Mode is a three-valued setting defaulting to `unavailable`, never inferred from a missing API key, with a database `CHECK` tying provenance to provider and an import-time throw in production. |
| [0008](ADR-0008-grounding-by-composite-foreign-key.md) | Grounding by composite foreign key | Accepted | `scenario_claim` is the grounding whitelist and citations reference it by composite FK, so a fabricated citation cannot be persisted rather than merely being checked for. |
| [0009](ADR-0009-no-gate-without-a-positive-control.md) | No gate without a positive control | Accepted | The review found 56 gates that would pass while exercising nothing (V18, V19); every denial assertion gains a positive control and every protected table a sentinel row. |
| [0010](ADR-0010-two-artefact-traceability.md) | Two-artefact traceability | Accepted | A deterministic committed traceability document carrying a design status (`PLANNED`/`DEFERRED`) but no run outcome, plus a volatile gitignored run report, because a committed generation timestamp makes `--check` unpassable and a committed PASS outlives its run. |
| [0011](ADR-0011-scope-discipline-cuts.md) | Scope discipline — what was cut | Accepted | Fifteen mechanisms removed, each because the PRD does not require it, the hazard was proven not to exist (V10), or the failure surface exceeded the coverage; plus the deferred and prohibited lists. |
| [0012](ADR-0012-session-resolution-in-route-handlers.md) | Session resolution in Route Handlers | **Proposed** | A stub, not a decision: React `cache()` outside a render context is settled by a `randomUUID()` probe across two concurrent requests before the Route Handler session path may rely on it (open item O2); until then the export route resolves per handler. |
| [0013](ADR-0013-transition-guard-derives-prospective-state.md) | The transition guard derives the prospective state | Accepted | `NEW.state` is NULL in `BEFORE UPDATE` on a generated column (V28), so the guard calls the same `IMMUTABLE` `app.derive_decision_state()` the column uses to obtain the prospective state (V29) and never reads `NEW.state`; the rejected alternative is the original design, which looks correct and is inert. |

## Conventions

- One decision per file, named `ADR-NNNN-<slug>.md`. Numbers are never reused.
- A decision is changed by a **new** ADR that supersedes the old one, not by editing it. Record
  the supersession in both files.
- Every ADR carries an **Evidence** section citing canon V-facts where they apply, and says so
  plainly where no V-fact bears on the decision.
- The argon2id parameters are recorded in **ADR-0002** (canon §6). ADR-0005 is the privilege
  decision and carries a one-line redirect, so a reader following an older pointer lands
  somewhere that sends them on.
- A reference to an ADR that does not yet exist must appear in `RESERVED.md` first. An
  unreserved forward reference is a `docs:check` failure, not a note for later.
- This index is the ADR number registry (canon §12). Every other document adopts its numbering;
  a document that names a different number for a decision recorded here is the document to
  change.
