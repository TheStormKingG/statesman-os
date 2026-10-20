# ADR-0002: Own session-cookie authentication

**Status:** Accepted | **Date:** 2026-10-20

## Context

ADR-0001 removes Supabase Auth, so FR-14 and NFR-01 must be met by code in this repository. Two
constraints shape the design. Sign-up and sign-in happen **before** any user context exists, so
they cannot pass RLS; they run through `SECURITY DEFINER` functions owned by `statesman_owner`
(canon §4.6). And `pg_hba.conf` is `trust` locally (V1), so the session layer can borrow no
assurance from the database connection.

## Decision

Server-side sessions in a `user_session` table storing a **hash** of the token, never the token.
Canon §6 parameters, reproduced:

| Concern | Decision |
|---|---|
| Hashing | argon2id via `@node-rs/argon2`, with the cost parameters pinned in this ADR (below) and asserted by a unit test; `algo_ver` column allows rehash-on-login |
| Pepper | **Cut** (reasoning below) |
| Token | 32 bytes from `crypto.randomBytes`, base64url; only its SHA-256 hash is stored |
| Cookie | `HttpOnly`, `SameSite=Lax`, `Secure` in production, `Path=/`, explicit `Max-Age`; `__Host-` prefix in production only, because it requires `Secure`, which local http cannot satisfy |
| Timeouts | Absolute 30 days; idle 7 days, slid **conditionally** (`last_seen_at < now() - interval '15 minutes'`), fire-and-forget; `resolve_session` is a **pure read** |
| Sign-out | Revokes the session **row**, then clears the cookie with full matching attributes |
| Privilege epoch | `AFTER UPDATE` trigger with **no column list**, comparing `to_jsonb(NEW) - 'privilege_epoch' - 'last_seen_at'` against the same projection of OLD, which **deletes** the user's sessions; a `BEFORE UPDATE` guard raises on a decreasing epoch |
| Rate limiting | Per-identifier progressive delay, DB client **released before sleeping**; aggregate threshold raises an alert, never a block |
| Lockout | None |

**The pepper is cut as a decision, not an oversight.** It would live in the same environment as
`DATABASE_URL`, so it does not survive the compromise it exists for.

`resolve_session` must stay a pure read: otherwise Next.js prefetches renew the idle window with
no user activity, and the idle control is hollow while its test still passes. Sign-out is tested
by replaying the captured cookie — asserting the cookie is gone proves nothing about the server.
The epoch trigger carries no column list because a hardcoded allowlist was proven to miss a
newly added privilege column.

### argon2id parameters

Canon §6 records the argon2id parameters here, and these are the pinned values:

| Option | Value |
|---|---|
| Memory cost | **19456** KiB (19 MiB) |
| Time cost | **2** iterations |
| Parallelism | **1** lane |
| Salt | **16** bytes, from `crypto.randomBytes` |
| Output (hash length) | **32** bytes |

The rationale is the **RFC 9106 / OWASP low-memory baseline**, as canon §6 records it: a
published low-memory configuration for argon2id rather than a value tuned here. It suits this
deployment — the pilot runs on one laptop alongside the PostgreSQL cluster the whole design
depends on, and a memory cost large enough to evict the database buys less than it costs. The
precise citation (which RFC 9106 configuration, which OWASP revision) is to be quoted from those
documents when the hashing code lands, not restated from memory.

**These values are a decision, not a measurement.** No hash has been computed with them and no
timing has been taken on this or any machine. Two obligations follow from that, and neither is
discharged:

1. **Read the option names back from the installed release before use.** The option *names* and
   the library's own defaults must be obtained by command against the installed
   `@node-rs/argon2` package, never from memory (canon open item O4). If the installed release
   spells an option differently, the values in the table stand and the call site is corrected to
   express them — the parameters are not re-derived from whatever the library defaults to.
2. **Assert the call.** A unit test must assert that the hashing call passes exactly these five
   values, so changing any one of them later fails the build instead of silently weakening the
   hash.

`algo_ver` records which parameter set produced a stored hash, so raising these values later
rehashes on next successful sign-in rather than invalidating passwords.

## Alternatives considered

| Option | Why rejected |
|---|---|
| External auth provider (Supabase Auth, Auth0, Clerk) | ADR-0001 removes the local Supabase option; a hosted provider puts the pilot user's identity outside the private workspace and needs unauthorised credentials and network access. |
| JWT-only stateless sessions | Cannot revoke. Sign-out and the privilege-epoch control both work by destroying server-side state; a stateless token stays valid until expiry, so FR-14's denial guarantee degrades to a clock. |
| Pepper in an environment variable | Shares `DATABASE_URL`'s blast radius; adds a rotation obligation for no gain against the threat it names. |
| Account lockout, or an instance-wide circuit breaker | On a single-user application this is account lockout with a worse blast radius and a one-line attacker trigger. |
| Store the session token itself | A database read would then yield a usable credential. |
| Tune the cost parameters by measuring on this machine instead of taking the baseline | Not rejected — **not yet done.** No timing has been taken, so a tuned value would be invented. The baseline is the floor; a later measurement may raise these values and must never lower them below it, and raising them is already safe because `algo_ver` rehashes on next sign-in. |
| Take whatever `@node-rs/argon2` defaults to | The defaults are a property of the installed release and change between versions, so the hash strength would drift with a dependency bump and nothing would fail. The values are pinned here and asserted by test for that reason. |
| Slide the idle window on every resolve | Framework prefetches keep the session alive without the user, and the idle test still passes. |

## Consequences

**Positive.** Revocation is real and immediate. The pre-identity path needs no grants on
`app_user`, `user_session` or `auth_attempt` (canon §4.6) — grant-absence is strictly stronger
than RLS, and it removes the `FORCE` + INSERT contradiction that would otherwise make user
creation impossible.

**Negative.** Password hashing, session lifetime, rate limiting and cookie handling are now our
code to get right and to test. No lockout means credential-stuffing is slowed, not stopped.

**What this now requires.** The nine definer functions in canon §4.6, each with
`set search_path = pg_catalog, public` and an explicit per-function grant to `statesman_app` only
(ADR-0005); a read-back of the installed `@node-rs/argon2` option names (O4) and a unit test
asserting the hashing call uses exactly the five pinned values above; a cookie-replay sign-out
test and a prefetch test for the idle window; and a test that adding a privilege column still
invalidates sessions.

**Status:** PLANNED. Nothing in this ADR has been implemented or executed.

## Evidence

- **V1** — login role is `rolsuper=t, rolbypassrls=t` and local auth is `trust`; a typo'd username connects successfully with no password error, so the connection carries no identity assurance.
- **V2** — a `SECURITY DEFINER` function is created with `EXECUTE` granted to `PUBLIC` by default; the definer functions this ADR depends on are unsafe without ADR-0005.
- **V21** — `citext` is available but not installed and cannot be created in `public`; `app_user.email` is `text` with a `unique index on (lower(email))`.
- **V17** — `set_config(…, true)` inside a function carrying a `SET` clause persists after return; relevant to the erasure flag reached from this path.
