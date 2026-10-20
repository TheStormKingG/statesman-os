# ADR-0007: Explicit `STATESMAN_AI_MODE` instead of inferring fixture mode

**Status:** Accepted | **Date:** 2026-10-20

## Context

The application must work without live AI credentials. `MASTER_PROMPT.md` §4 states it precisely:

> "The application must remain functional when live AI credentials are absent: save decisions,
> show an honest feedback-unavailable/retry state, and allow deterministic fixture-based review
> in test/demo mode only. Never present canned feedback as a live model response."

The habitual implementation keys the fixture adapter on the absence of `ANTHROPIC_API_KEY`. That
reads as a safe default and is the opposite: a key that is missing, misspelled, rotated or unset
in a deployment environment then selects fixtures **in production**, and the product serves
pre-written challenges as model output — the one thing the line above forbids, with nothing
anywhere reporting an error.

## Decision

Mode is an explicit three-valued setting with a safe default:

```ts
STATESMAN_AI_MODE: 'live' | 'fixture' | 'unavailable'   // default 'unavailable'
```

Never keyed on the absence of `ANTHROPIC_API_KEY`. The fixture adapter module **throws on
import** when `NODE_ENV === 'production'`. A missing key in `live` mode renders the NFR-08
unavailable/retry state — it does not silently fall back.

Provenance is derived from the provider by **one** mapping function and tied by a database
constraint, so a fixture-backed row cannot be recorded as live:

```sql
alter table public.challenge_run add constraint provenance_matches_provider
  check ((provider = 'fixture') = (provenance = 'fixture'));
```

The UI labels every fixture-backed response as such, alongside the FR-08 and PRD §9.3
"AI-generated formative analysis" labelling.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Fixture mode when `ANTHROPIC_API_KEY` is absent | Ships canned feedback as the production default on a missing or rotated key, violating the `MASTER_PROMPT.md` §4 line and the FR-08 / PRD §9.3 labelling duties with no error raised anywhere. |
| Hard failure when the key is absent, no fixture path | Loses the deterministic fixture adapter that `MASTER_PROMPT.md` §7.6 and canon §8 require for tests and the local demo. |
| A single boolean (`useFixtures`) | Cannot distinguish "configured live but currently unavailable" from "deliberately offline". NFR-08's honest retry state needs the third value. |
| `NODE_ENV` alone as the switch | Conflates build target with provider availability; a production build must still be able to show the unavailable state, and a development build must be able to run live. |
| Label provenance in application code only | One forgotten write path persists a fixture row that reads as live for the rest of its life. The `CHECK` makes that row unrepresentable. |
| Allow the fixture adapter to load in production, gated at call time | A runtime gate can be bypassed by a new call site; the import-time throw cannot. |

## Consequences

**Positive.** A fresh checkout with no configuration shows the honest unavailable state rather
than a demo that looks like working AI. Fixture provenance becomes a database invariant rather
than a convention, so the distinction the PRD cares about — live model versus canned content — is
auditable after the fact.

**Negative.** Deployment and local setup must set the variable explicitly, so `.env.example` and
the README carry an extra required line, and a forgotten variable produces a product that refuses
to generate challenges. That is the intended failure direction.

**What this now requires.** The three-valued schema parsed and validated at startup; the
import-time throw plus a test asserting it throws under `NODE_ENV=production`; the single
provider-to-provenance mapping with the `CHECK` as its backstop; UI labelling on every
fixture-backed challenge and assessment; and the NFR-08 unavailable/retry state wired to a missing
key in `live` mode.

**Status:** PLANNED / NOT RUN. No adapter, fixture set or environment schema exists yet.

## Evidence

- Canon §7.1 (mode is explicit; fixture module throws on import in production; no implicit trigger) and canon §5.1 (`provenance_matches_provider`).
- `MASTER_PROMPT.md` §4, quoted above — the line permitting fixtures in test/demo mode only.
- PRD **NFR-08** (preserve input on model/API failure; clear retry/fallback without claiming successful feedback), **FR-08** (flag uncertainty, no invented authority), PRD §9.3 (all AI feedback labelled AI-generated formative analysis).
- No V-fact in canon §3 bears on this decision; it rests on the master prompt line and the database `CHECK`, not on a measured platform behaviour.
