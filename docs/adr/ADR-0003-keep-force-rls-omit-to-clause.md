# ADR-0003: Keep FORCE ROW LEVEL SECURITY, and omit the TO clause from every policy

**Status:** Accepted | **Date:** 2026-10-20

## Context

This is the one adjudicated disagreement in the design review (canon §10). Reviewers split on
`FORCE ROW LEVEL SECURITY`: **one recommended dropping it, three recommended keeping it.** Both
positions were grounded in executed facts, not preference.

**The dissenting position.** `FORCE` imposes a real operational tax. Under it an owner-run
`UPDATE … WHERE true` affects zero rows and raises nothing, and `SET row_security = off` is
refused (V8), so data backfills silently do nothing. With policies scoped `TO statesman_app`,
tables become unreadable and unwritable by the owner outright (V9), and a non-superuser owner's
`pg_dump` fails (V10). A control whose maintenance failure mode is *silence* is a liability.

**The majority position.** `ENABLE` alone is not a boundary. Table **ownership** bypasses RLS
under `ENABLE`, independently of `rolsuper` and `rolbypassrls` (V4), so one ownership mistake
removes tenancy for an entire table — and because an empty table with RLS and one without it both
return 0 to the app role (V18), no row-count assertion notices. `FORCE` is also what stops a
`SECURITY DEFINER` function owned by `statesman_owner` from reading across users.

## Decision

**Keep `FORCE`, on every user-owned table, and omit the `TO` clause from every policy.**

The dissent's cause was diagnosed and it was not `FORCE`: it was scoping policies
`TO statesman_app` (V9). With the `TO` clause omitted, one policy serves both the app role and
the definer functions, and the owner-unreadable problem disappears — the dissent's strongest
observation is addressed at its actual cause rather than by removing the control.

The residual cost is **accepted and handled, not argued away**: every data migration brackets
`alter table … no force` / `… force` in the same file (V8), a migration lint rejects an unmatched
`no force`, and dumps are taken as the bootstrap superuser (V10).

## Alternatives considered

| Option | Why rejected |
|---|---|
| Drop `FORCE`, keep `ENABLE` (the dissenting recommendation) | V4: ownership then bypasses RLS regardless of role attributes, and V18 means no existing assertion would detect it. The dissent's cause was V9, which the `TO`-clause rule fixes without giving this up. |
| Keep `FORCE`, scope policies `TO statesman_app` | V9: this is the configuration that produced the dissent — tables become unreadable and unwritable by the owner, breaking the definer functions. |
| Keep `FORCE`, disable row security for backfills | V8: `SET row_security = off` is refused. |
| Grant `BYPASSRLS` to a maintenance role | V3: a role with `rolbypassrls=false` that is a **member** of a BYPASSRLS role passes an attribute check while `SET ROLE` to it succeeds — the escape hatch would be invisible to the attribute test meant to police it. |
| Backup round-trip row-count verification to catch silent empty dumps | V10: `pg_dump` as non-superuser owner under `FORCE` fails with rc=1, so the hazard does not exist. Cut (ADR-0011). |

## Consequences

**Positive.** Tenancy survives an ownership mistake. One policy per table serves both the app
role and the definer path. The posture check asserts the invariant directly: rule 1 requires
`relrowsecurity` **and** `relforcerowsecurity` plus at least one policy on every table the app
role can touch, and rule 2 makes a new table fail by default.

**Negative, accepted.** Owner-run backfills are silent no-ops unless bracketed (V8), so every
data migration is longer and carries a lint obligation, and the backup procedure is not runnable
as the owner role.

**What this now requires.** A migration lint rejecting an unmatched `no force`; posture-check
rules 1 and 2 implemented column-name independently; the backup runbook written against the
bootstrap superuser; and a test that a table shipped without `FORCE` fails the build.

**Status:** PLANNED / NOT RUN. The posture check and the lint do not exist yet.

## Evidence

- **V4** — ownership bypasses RLS under `ENABLE`, independently of `rolsuper`/`rolbypassrls`.
- **V9** — `FORCE` plus policies scoped `TO statesman_app` makes tables unreadable/unwritable by the owner. This is the decisive fact: it identifies the dissent's real cause.
- **V8** — `FORCE` makes an owner-run `UPDATE … WHERE true` affect zero rows and raise nothing; `SET row_security = off` is refused. The accepted residual cost.
- **V10** — `pg_dump` as non-superuser owner under `FORCE` fails rc=1; no silently-empty-backup hazard.
- **V3** — membership reachability defeats an `rolbypassrls` attribute check.
- **V18** — "0 rows" cannot prove RLS works, which is why losing `FORCE` would be undetectable.
