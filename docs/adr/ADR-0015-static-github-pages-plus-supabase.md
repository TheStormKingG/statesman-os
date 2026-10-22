# ADR-0015: Static export on GitHub Pages with Supabase as the backend

**Status:** Accepted, NOT YET IMPLEMENTED | **Date:** 2026-10-21

This ADR exists because `docs/supabase-target.md` was found to declare an architecture
that contradicts the canon the gates enforce. That was a real inconsistency: a document
asserting one architecture while `scripts/gates.sh` enforced another. This record
reconciles them by naming exactly which canon sections the change supersedes and what
replaces each one. Nothing in the tree has been ported yet.

## Context

Stefan asked for the application to be reachable at a URL rather than only on localhost,
specifically as a GitHub Page. GitHub Pages is static hosting: no Node runtime, no
database, no server-side secrets, no route handlers. The P0 design is server-dependent
throughout — ADR-0006's `withUser`, the three-role grant model of ADR-0005, and the
`require_user_id()`-scoped transaction context all live in a Node process.

Supabase resolves this, because it is designed for exactly the shape Pages can host: a
browser client holding a publishable anon key, with RLS doing the enforcing. It is not a
workaround; it is Supabase's intended architecture.

The project `onpkspfxfmjkqpomcsse` was created in the `Preqal` org, `us-east-1`, free
tier, at Stefan's explicit request, and its shape was verified by query before this ADR
was written. Findings are recorded in `docs/supabase-target.md`.

## Decision

Next.js **static export** deployed to **GitHub Pages**, talking to **Supabase** from the
browser. The port lands **before Slice 3**, because Slice 3 builds screens against
whichever identity model exists and would otherwise be built twice.

### What this supersedes, section by section

| Canon section | Superseded by |
|---|---|
| §2 stack: local Postgres via Homebrew, `pg` from Next.js server code | Supabase-hosted Postgres 17.11, reached by `@supabase/supabase-js` from the browser. Local Postgres remains the **development and test** target via the emulation below. |
| §4.1 three roles (`statesman_owner`, `statesman_app`, `statesman_migrator`) | Supabase's `anon`, `authenticated`, `service_role`, `postgres`. ADR-0005's grant model is rewritten, not ported. |
| §4.3 identity via transaction-local GUC set by `withUser` | `auth.uid()` reading the verified JWT. This is the seam §4.3 was built for, and it is the only part of the port the canon anticipated. |
| §4.6 the pre-identity path (`create_user`, `find_credentials`, `create_session`, …) | Supabase Auth. ADR-0002 (own session-cookie auth, argon2id, `user_session`, `auth_attempt`) is **retired**. |
| §6 authentication, §6.1 the `withUser` contract | Retired for the browser path. There is no server pool, so `assertUnprivilegedOnce()`, the eager identity probe and `DISCARD ALL` have nothing to act on. |
| §7 the AI adapter as server-side Node | A Supabase Edge Function (Deno) in Slice 4. The model key must never reach the browser, and this is the only remaining server-side execution context. |
| §8.3 test harness connecting as `statesman_app` | Connect as `authenticated` with a `request.jwt.claim.sub` set. See the trap below. |

### What survives unchanged

The schema; every RLS policy (with `app.current_user_id()` → `auth.uid()`); the
immutability triggers; the state machine including V28/V29/V31; the lifecycle
`SECURITY DEFINER` functions of ADR-0014; `verify_security_posture()` adapted to Supabase
roles; all of Slice 2's scenario content, source register and claim whitelist; the mutation
gate and its registry, re-pointed. Measured: the remote is **PostgreSQL 17.11, identical
to local**, so V12, V28 and V29 carry over without re-derivation, and **V2 and the V30 fix
both hold there** — a new function has PUBLIC `EXECUTE`, and an explicit `REVOKE` removes
it.

## Alternatives considered

| Option | Why rejected |
|---|---|
| GitHub Pages with a static export and no backend | Strips persistence entirely. FR-04 immutable records, FR-14 private workspace, FR-16 export and deletion all become impossible. It would be a brochure that looks like the product and stores nothing, and PRD §5 forbids sample content presented as personal history. |
| GitHub → Vercel + Supabase | Keeps the Next.js server, so more of the boundary survives and the AI call stays in Node. Rejected because Stefan asked specifically for a GitHub Page; worth revisiting if the loss of defence in depth below proves unacceptable. |
| Keep local Postgres, deploy at the end of P0 | Nothing already built would be retired, but there is no URL until P0 completes. Rejected: Stefan wants to reach it sooner. |
| Install Docker and run Supabase locally | Would give a faithful local stack. Docker is absent and this is a large install; the emulation below covers the schema and policy semantics at far lower cost. |

## Consequences

### The one that matters: RLS becomes the only wall

Three layers protect the journal today — the server boundary, the grant model, and RLS.
This removes the first two. The anon key is public by design and that is correct, but it
means the database is reachable from the internet with **nothing behind RLS**. A single
policy error is a full breach.

Two losses, both measured rather than assumed:

1. **Missing identity goes from loud to silent.** `app.require_user_id()` raises `28000`;
   `auth.uid()` returns NULL. Verified with a paired control on a Supabase-shaped target:
   as `authenticated` with no claim, 0 rows and no error; with user A's claim, 1 row; A
   reading B's row, 0; A inserting a row owned by B rejected with *new row violates
   row-level security policy*. So denial and forgery-prevention both hold — but a context
   failure no longer announces itself, and V6's fail-loud property cannot live in a policy
   predicate.
2. **No defence in depth.** Every guard in `src/server/db` leaves the request path.

**Therefore the posture check and the mutation gate stop being good practice and become
the only thing standing between a policy typo and the journal.** Both must be extended to
cover every Supabase policy, with a mutation per policy, before real decisions are
entered. This is now a release gate, not a quality measure.

### The trap this introduces

**Supabase's `postgres` role has `bypassrls = true`** (measured; `rolsuper` is false, so it
reads as restricted). It is the role the CLI and the dashboard SQL editor use by default.
Any test connecting as `postgres` passes while enforcing nothing — tenancy, cross-user
denial and forgery alike. This is V1/V4 in a new costume, and it voids an entire suite
silently. The harness guard that was proven fatal in Slice 1 must be rewritten to assert
`current_user = 'authenticated'`, `rolbypassrls = false`, zero owned relations in `public`,
and a present JWT claim — with its own mutation proving it bites.

### What we must now do

- Port the migrations, translating roles and the identity accessor.
- Rewrite the harness role guard and re-point all 19 mutations.
- Replace our auth with Supabase Auth, retiring ADR-0002.
- Build Slice 4's AI call as an Edge Function rather than a Node adapter.
- Develop and test against a **local emulation** (an `auth` schema with `uid()` reading
  `request.jwt.claim.sub`, plus `anon` and `authenticated` roles on local Postgres), proven
  to reproduce the policy semantics. `supabase start` needs Docker, which is absent. What
  the emulation cannot test, and what must therefore be declared unverified until it runs
  against the live project: Supabase Auth's real JWT issuance, Edge Functions, and
  PostgREST.
- Confirm whether the GitHub repo must be public. Pages on a private repo requires a paid
  plan, and the token's scopes do not expose the account plan. The code carries no secret,
  so public is harmless for it; the journal lives in Supabase, not the repo.

## Evidence

`docs/supabase-target.md`, every row of which was established by query against project
`onpkspfxfmjkqpomcsse` on 2026-10-21, not from documentation or memory.
