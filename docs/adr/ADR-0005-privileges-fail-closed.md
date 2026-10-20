# ADR-0005: Privileges fail closed

**Status:** Accepted | **Date:** 2026-10-20

## Context

The pre-identity path (sign-up, sign-in, session resolution, self-erasure) cannot pass RLS, so it
runs through `SECURITY DEFINER` functions owned by `statesman_owner` (canon §4.6). That makes
function privileges a primary security boundary, and PostgreSQL's default is open: **a
`SECURITY DEFINER` function is created with `EXECUTE` granted to `PUBLIC`**
(`pg_proc.proacl IS NULL`) — V2.

This is not theoretical. During the design review **a working cross-user deletion exploit was
demonstrated as the unprivileged app role**, by calling a definer function that accepted a target
user id. The habitual mitigation does not help: `REVOKE … ON ALL TABLES` does not touch
`EXECUTE`.

**Not recorded here:** the argon2id password-hashing parameters live in **ADR-0002**. A reference
that sends a reader to ADR-0005 for them is stale — follow it to ADR-0002.

## Decision

Two rules, in opposite directions.

**Functions revoke by default, then grant one line at a time:**

```sql
revoke all on all functions in schema public, app from public;
alter default privileges in schema public, app revoke execute on functions from public;
-- then GRANT EXECUTE per function, explicitly, one line each.
```

The `ALTER DEFAULT PRIVILEGES` line is the mandatory half: without it, the next function added
ships executable by `PUBLIC`.

**The grant list is nine lines, one per definer function** (canon §4.6). It is written out here
so the privilege set is readable without resolving the canon, and so a miscount cannot silently
leave a function ungranted:

```sql
grant execute on function app.create_user(text, text, smallint)        to statesman_app;
grant execute on function app.find_credentials(text)                   to statesman_app;
grant execute on function app.create_session(uuid, bytea, timestamptz) to statesman_app;
grant execute on function app.resolve_session(bytea)                   to statesman_app;
grant execute on function app.revoke_session(bytea)                    to statesman_app;
grant execute on function app.touch_session(bytea)                     to statesman_app;
grant execute on function app.record_attempt(text, text)               to statesman_app;
grant execute on function app.erase_self()                             to statesman_app;
grant execute on function app.get_profile()                            to statesman_app;
```

The signatures are the canon's; the argument lists must be checked against the migration that
creates each function, because `GRANT EXECUTE` names a function by signature and a mismatched
one grants nothing while reporting nothing. `app.erase_self()` takes no parameters by design
(below).

**Tables have deliberately NO `ALTER DEFAULT PRIVILEGES … GRANT`.** Each migration grants per
table. A forgotten grant then yields an **invisible** table (fails closed), not an **exposed**
one (fails open).

Consistent with the same posture: `app.erase_self()` takes **no** parameters and derives identity
internally — the exploited shape was a definer function accepting a uuid. `app_user`,
`user_session` and `auth_attempt` receive no direct grants at all. `TEMPORARY` is revoked from
`PUBLIC` on the database (V22) and `TRUNCATE` from `statesman_app` on every immutable table
(V15).

## Alternatives considered

| Option | Why rejected |
|---|---|
| `REVOKE … ON ALL TABLES … FROM PUBLIC` as the mitigation | V2: it does not touch function `EXECUTE`. This is exactly the gap the demonstrated exploit went through. |
| `REVOKE` on existing functions without `ALTER DEFAULT PRIVILEGES` | Covers today's functions only; the next migration reopens the hole silently. |
| `ALTER DEFAULT PRIVILEGES … GRANT` on tables, for convenience | A new table becomes readable the moment it exists, before its policy is written — and V18 (an empty table returns 0 whether or not RLS is on) means no test notices. Fails open. |
| Definer functions that take a target user id | The reproduced exploit. Identity is derived inside the function. |
| One blanket `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO statesman_app` | Re-grants to every function including ones added later with a wider purpose; the per-function line is the control, not boilerplate. |
| Grant the auth tables to `statesman_app` and rely on RLS | Canon §4.6: grant-absence is strictly stronger than RLS, and it removes the `FORCE` + INSERT contradiction that would otherwise make user creation impossible. |

## Consequences

**Positive.** Every executable surface is enumerated in the migrations, one line per function, so
a reviewer can read the whole privilege set. Posture rule 4 turns the exploit class into a build
failure, and rule 1 catches the table side by requiring RLS plus `FORCE` plus a policy on every
table the app role can touch.

**Negative.** Verbosity, intentionally. Every new function and table needs an explicit grant line,
and a forgotten one produces a confusing-but-safe failure — an invisible table rather than an
error naming the missing grant. Test seeding therefore goes through `withUser` (canon §8.3) so a
missing INSERT policy or grant surfaces instead of being bypassed.

**What this now requires.** Bootstrap SQL carrying the revokes and `ALTER DEFAULT PRIVILEGES`
before any function is created; per-function grants for the nine definer functions in canon
§4.6, enumerated above; posture-check rules 1, 4 and 7; and a regression test reproducing the original exploit
shape that now fails to delete.

**Status:** PLANNED / NOT RUN. The exploit was demonstrated against a scratch cluster during
review; no mitigation code exists yet.

## Evidence

- **V2** — a `SECURITY DEFINER` function is created with `EXECUTE` granted to `PUBLIC` by default (`pg_proc.proacl IS NULL`); cross-user deletion was reproduced as the unprivileged app role; `REVOKE … ON ALL TABLES` does not touch `EXECUTE`. The driving fact.
- **V22** — the app role retains `PUBLIC`'s `TEMPORARY` privilege, and a temp table shadows an unqualified reference to a real table; hence `REVOKE TEMPORARY`, schema-qualify everything, pin `search_path`.
- **V15** — `TRUNCATE` bypasses row-level triggers; `REVOKE TRUNCATE` is part of the same posture.
- **V18** — an empty table returns 0 with or without RLS, so a fail-open table grant would not be caught by a row-count test.
- **V1** — a typo'd username connects successfully as whatever role it names, so privileges cannot be assumed from the connection string.
