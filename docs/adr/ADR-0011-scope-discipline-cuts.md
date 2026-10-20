# ADR-0011: Scope discipline — what was cut as over-engineering

**Status:** Accepted | **Date:** 2026-10-20

## Context

The design review removed fifteen mechanisms an earlier draft carried. They are recorded here as
one decision because they share one rule, and because a cut that is not written down returns as a
well-intentioned addition later. `MASTER_PROMPT.md` §0.8 and §10 require small verified increments
and forbid speculative features; §11 forbids silently reducing scope.

## Decision

Each item below was removed because **(a)** the PRD does not require it, **(b)** the hazard it
guarded was proven not to exist, or **(c)** it added a failure surface larger than the one it
covered.

| Cut | Reason | Note |
|---|---|---|
| `app_editor` role | (a) | Scenario content is seeded from a migration; the editor is a PRD §2.2 secondary user for a later release. |
| Scenario authoring and publish tables | (a) | Not required for P0; seed from a migration instead (and ADR-0008 needs `scenario_claim` populated before any challenge, which a seed satisfies). |
| Nightly reconciliation cron | (c) | CI assertions instead, plus the posture check at the end of **every** migration run in every environment. |
| Password pepper | (c) | Would live in the same environment as `DATABASE_URL`, so it does not survive the compromise it exists for (ADR-0002). |
| Instance-wide circuit breaker | (c) | On a single-user application it is account lockout with a worse blast radius and a one-line attacker trigger; the aggregate threshold alerts instead (ADR-0002). |
| Global `role` column | (a) | FR-13 is deferred, and a global role cannot express per-item scoped revocable sharing anyway (open item O6). |
| `extractJson` free-text JSON recovery | (c) | It turns malformed model output into something that parses. One repair attempt through the operator channel, then `{code:'schema_invalid'}`; a unit test asserts no substring/regex recovery exists in the adapter. |
| Stryker mutation testing | (a) | The control pairing in ADR-0009 already forces every gate to demonstrate a failure, which is the property mutation testing would estimate. |
| Cryptographic report-integrity chain | (c) | Clean-tree and `headSha` enforced only on a release tag. |
| Backup round-trip row-count verification | **(b)** | V10: `pg_dump` as non-superuser owner under `FORCE` fails with rc=1, so the "silently empty backup" hazard does not exist. |
| Fabrication-ratio second threshold | (c) | Duplicate gate over the citation whitelist, which already rejects relationally (ADR-0008). |
| `withUser`'s unused `readOnly` option | (c) | A dead parameter on the single most security-sensitive function. |
| Dead `UUID_RE` guard | (c) | Validation is Zod at the trust boundary; a second unreached check invites divergence. |
| Superuser test connection | (c) | A superuser connection in the harness can bypass exactly what the harness exists to prove (V1, V4). Tests connect as `statesman_app`. |
| Three-column rejection table | (a) | Not required by the PRD. |

**Deferred, not cut** (canon §1.2, gated per PRD §3.2): FR-06 case search, FR-13 reviewer
sharing, FR-17 monthly review, FR-18 profile preferences, Crisis Room, Virtual Cabinet, Policy
Lab, National Systems Atlas, Public Service Ledger, Strategic Pathway Studio, live news ingestion.

**Prohibited, not deferred** (canon §1.2): any composite readiness/character/viability score;
voter profiling or segmentation; targeted political messaging; AI-awarded maturity level 3 or 4;
fabricated citations, statutes or institutional positions; impersonation of real officials;
simulated outcomes presented as forecasts; public exposure of journal content; leaderboards, XP,
punitive streaks, social feeds. These are not scope decisions and are not revisitable here.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Keep each mechanism "just in case" | Every one is code that must be correct, tested and maintained. The 56 vacuous gates of ADR-0009 show what untested defensive machinery actually delivers. |
| Cut silently and omit the list | `MASTER_PROMPT.md` §11 forbids silently reducing scope; an unrecorded cut returns as a plausible suggestion in a later session. |
| Keep the backup verification anyway, as cheap insurance | V10 shows the failure it detects cannot occur, so it would be a gate that can never fail — prohibited by ADR-0009. |
| Defer the prohibited items rather than prohibiting them | They are PRD and canon boundaries, not sequencing choices; "deferred" would imply a later release could add them. |

## Consequences

**Positive.** The P0 surface stays the four components plus the private-workspace minimum. Fewer
instruments to validate, and every remaining gate has a reason recorded next to it.

**Negative.** Some real-but-unmeasured risks are now carried openly rather than mitigated: no
nightly reconciliation, no mutation testing, no report-integrity chain outside release tags. If
one of those hazards materialises, the record will show it was accepted deliberately.

**What this now requires.** Re-adding any item above needs a new ADR superseding this one, with
the reason the original rationale no longer holds. The unit test asserting no JSON recovery exists
in the adapter belongs to this decision, not to ADR-0007. Open item O6 records the shape FR-13
must take when it arrives: a `record_share` table (resource, grantee, scope, `expires_at`,
`revoked_at`) with a policy unioning ownership and an unexpired unrevoked share.

**Status:** these are design decisions; no code exists to reflect them yet.

## Evidence

- **V10** — the only cut justified by a proven-absent hazard: `pg_dump` as non-superuser owner under `FORCE` fails rc=1.
- **V1, V4** — why a superuser test connection would defeat the harness.
- Canon §11 (the cut list and the general rule), §1.2 (deferred and prohibited), §7.2 (`extractJson` deleted, with the no-recovery unit test), open item O6.
- PRD §3.1 MVP rule and §14.3 out-of-scope launch requests; `MASTER_PROMPT.md` §0.4, §0.5, §10, §11.
