# ADR-0008: Grounding enforced relationally by composite foreign key

**Status:** Accepted | **Date:** 2026-10-20

## Context

FR-08 requires that no fabricated citations, statutes or institutional positions appear, and the
canon lists fabricated citations among the **prohibited** outcomes, not the merely undesirable
ones (canon §1.2). A model returns `evidence_refs[]` and `source_claims[]`; something must decide
whether each one is real.

An application check can do that — and it holds only as long as every write path remembers to
call it. A new route, a repair retry, a seed script or a background job that writes a challenge
without the check persists a fabricated citation, which is then shown to the user as grounded
evidence inside the record FR-15 promises is traceable. The failure is silent and permanent.

## Decision

Grounding is a relational constraint.

`scenario_claim`, keyed `primary key (scenario_version_id, claim_id)` with a foreign key to
`source`, **is the grounding whitelist**. Citation rows reference the whitelist by composite
foreign key — `(scenario_version_id, source_id, claim_id)` — **and** the owning challenge's
`(id, user_id)` pair, in the same composite-ownership style used for every child table (canon
§4.5). **A fabricated citation cannot be persisted**: there is no row for it to point at, so the
insert fails rather than succeeding quietly.

The same chain exists for assessments, through `assessment_observation_source_claim`. Without it
the grounding gate would cover challenges only and the assessment path would have none.

Two supporting rules:

- Every `evidence_ref` and `source_claim` is also checked server-side against `scenario_claim`
  for the **pinned** `scenario_version_id` before the write, so an unknown id is rejected with a
  usable error rather than a constraint violation.
- A challenge whose citations do not all resolve is **dropped individually**, and the drop is
  recorded with a `failure_code` — so a partially fabricated five-lens run yields its valid
  challenges plus an auditable record of what was discarded.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Application-level validation only | Holds only while every write path remembers it. One new or forgotten path persists a fabricated citation permanently, and nothing downstream can tell it from a real one. |
| Prompt instructions to cite only approved ids | Canon §7.4: no reliance on instructing the model. Scenario text, source excerpts and journal text are untrusted and can carry competing instructions. |
| Single-column FK to `source(id)` | Permits a genuine source attached to the wrong scenario version — a citation that resolves but does not support the facts the decision was made against, which is the FR-02 provenance failure in a subtler form. The composite key pins version, source and claim together. |
| Store citations as free text or JSON alongside the challenge | Nothing constrains it at all; `scenario_claim` stops being a whitelist and becomes documentation. |
| Reject an entire run when one citation fails to resolve | Discards the other four lenses' usable work and hides the signal. Per-challenge drop with a `failure_code` preserves both the output and the evidence of the drop. |
| Ground assessments by application check while challenges use the FK | Canon §7.3 item 3: the assessment path then has no grounding gate, and the two paths drift. |

## Consequences

**Positive.** The prohibition is structural: the strongest available statement about fabricated
citations — that one cannot exist in the database — holds without depending on any code path
being correct. FR-02 and FR-15 traceability follow from the same keys.

**Negative.** `scenario_claim` must be seeded by migration before any challenge can be stored,
which it is, since ADR-0011 cut the authoring tables in favour of migration-seeded content.
Citation rows must be written in the same transaction as their challenge. And a legitimate claim
missing from the whitelist is indistinguishable, at the constraint, from a fabricated one — which
is why the eager server-side check exists, to give that case a clear error.

**What this now requires.** The composite keys on `challenge_source_claim` and
`assessment_observation_source_claim`; the pre-write resolution check against the pinned version;
drop accounting with `failure_code`; and an adversarial test submitting a fabricated claim id that
asserts both the drop and the recorded code (canon §7.6 makes unapproved source id a release
blocker).

**Status:** PLANNED / NOT RUN.

## Evidence

- Canon §5.1 — `scenario_claim` is the grounding whitelist, `primary key (scenario_version_id, claim_id)`, FK to `source`.
- Canon §7.3 — relational grounding by composite FK, the assessment chain, and per-challenge drops with `failure_code`.
- Canon §4.5 — the composite-ownership pattern (`unique (id, user_id)` plus composite FK) this reuses.
- **V7, V19** — the general reason a check whose only failure signal is an affected-row count cannot be trusted; the constraint raises instead of returning nothing.
- No V-fact covers the citation chain directly. This decision rests on canon §5.1 and §7.3 and on FR-02/FR-08, not on a measured platform behaviour.
