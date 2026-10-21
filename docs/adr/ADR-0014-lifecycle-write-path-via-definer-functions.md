# ADR-0014: Lifecycle transitions run through SECURITY DEFINER functions

**Status:** Accepted | **Date:** 2026-10-20

## Context

`statesman_app` holds `GRANT UPDATE (draft_payload)` on `decision` and nothing more, so it
cannot write `submitted_at`, `challenged_at`, `reflected_at`, `action_recorded_at` or
`closed_at`. Verified: a direct `update decision set submitted_at = now()` as the app role
raises `42501 permission denied`.

An earlier version of the canon specified that grant model but named no legal writer for
those columns, so the lifecycle had no implementable path at all. This ADR closes that gap.

A second finding reshaped the privilege half of this decision. The canon claimed
`ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` was "the structural
half" protecting functions added later. It is a **silent no-op** (V30): `REVOKE` only
deletes rows from `pg_default_acl` and never records a negative default, so the built-in
PUBLIC `EXECUTE` survives. `ALTER DEFAULT PRIVILEGES … GRANT` does apply, and the ACL it
materialises carries the PUBLIC grant with it, which makes the exposure look configured.

## Decision

Every milestone transition runs through a `SECURITY DEFINER` function owned by
`statesman_owner`, granted `EXECUTE` to `statesman_app` only:
`app.submit_decision`, `app.append_revision`, `app.stamp_milestone`. Draft saves stay a
direct `UPDATE` on the one granted column, keeping the hot path cheap.

Four properties, each verified by execution:

1. **Identity is derived, never a parameter.** `app.require_user_id()` inside the function.
   A function taking a user id is the cross-user exploit class of V2.
2. **The row lock is the arbitration.** `SELECT … FOR UPDATE` on the parent before any
   write, so concurrent submits serialise rather than race.
3. **Idempotency precedes the lock.** A replayed `idempotency_token` returns the existing
   revision with `replayed = true`. Verified: second call returned `rev=1 replayed=true`,
   revision count stayed 1.
4. **The row count is asserted.** `GET DIAGNOSTICS … ROW_COUNT`, raising `ST005` on
   anything but 1, because a failing policy affects zero rows and raises nothing (V7).

Because policies omit the `TO` clause and the identity GUC is transaction-local rather than
role-scoped, `app.require_user_id()` inside a definer function resolves to the *caller's*
identity even though the body executes as the owner. Verified: user B calling
`app.submit_decision` against user A's decision raised `ST010`.

For privileges: `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA … FROM PUBLIC` runs at the end
of **every** migration that creates a function, and `verify_security_posture()` rule 4 is
the **primary** control rather than a backstop.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Grant `UPDATE (submitted_at, …)` to the app role | The app could stamp a milestone without creating the revision, so submission would stop being atomic. It also puts the state machine's integrity in application code. |
| One definer function per milestone | Duplicates the row-count assertion five times, so five places can drop it. `app.stamp_milestone(id, milestone)` keeps the assertion in one place, with a whitelist on the milestone name. |
| Run transitions on the migrator connection | Puts an owner-equivalent credential in the application environment and destroys the privilege separation and FORCE-RLS story at once. |
| Rely on `ALTER DEFAULT PRIVILEGES` to protect future functions | Proven a no-op (V30). Believing it would have left every later function PUBLIC-executable while the migration read as hardened. |

## Consequences

**Positive.** Submission is atomic. The app role cannot forge a state. Identity cannot be
supplied. Replays are safe. One assertion site for row counts.

**Negative.** Every new transition needs a function, a grant and a posture-check run. A
definer function is a privilege boundary, so each one needs review. `app.stamp_milestone`
uses `format(%I)` on a whitelisted name, which is dynamic SQL and must stay whitelisted.

**What this now requires.** The posture check must run at the end of every migration run in
every environment, not only in test setup, because nothing else prevents the next function
from being PUBLIC-executable.

## Evidence

V2, V4, V7, V9, V30 in the canon's verified-facts register, all established by executing
commands against PostgreSQL 17.11 on this machine. The lifecycle suite in
`migrations/` was run end to end as `statesman_app` (non-owner, no BYPASSRLS, owns zero
tables): 16 assertions passing, including a cross-user denial paired with a positive
control proving the denial test can distinguish 0 from 1.
