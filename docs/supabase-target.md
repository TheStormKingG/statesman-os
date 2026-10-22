# Supabase deployment target — verified shape

> **This document records a VERIFIED TARGET, not the architecture the tree currently
> implements.** The canon (`docs/superpowers/specs/2026-10-20-statesman-os-p0-mvp-design.md`)
> and the gates in `scripts/gates.sh` still enforce the local-Postgres, server-side
> `withUser` architecture, and they are correct to: nothing has been ported yet.
> The change itself, and exactly which canon sections it supersedes, is recorded in
> [ADR-0015](adr/ADR-0015-static-github-pages-plus-supabase.md). Read that first.
> An audit flagged this file for declaring an architecture that contradicted the canon;
> that was accurate, and the ADR is the reconciliation.

**Date:** 2026-10-21
**Project ref:** `onpkspfxfmjkqpomcsse` · org `Preqal` · region `us-east-1` · status ACTIVE_HEALTHY
**Status:** target verified by query. No migration has been applied to it yet.

Architecture decided with Stefan on 2026-10-21: **Next.js static export on GitHub Pages,
talking to Supabase from the browser with the publishable anon key, RLS enforcing.** The
port lands BEFORE Slice 3, because Slice 3 builds screens against whichever identity model
exists and would otherwise be built twice.

Every row below was established by running a query against the live project, not from
documentation or memory.

---

## 1. The target

| Fact | Value | Why it matters |
|---|---|---|
| Server | PostgreSQL **17.11** | **Identical to local.** V12 (generated-column enum casts), V28 (`NEW.<col>` NULL in BEFORE UPDATE on a generated column) and V29 (IMMUTABLE user function in a generated column) all carry over without re-derivation. |
| `auth.uid()` | exists, `provolatile = 's'` (STABLE) | Matches the volatility our own shim requires. The IMMUTABLE-shim cross-user leak does not apply. |
| Roles present | `anon`, `authenticated`, `authenticator`, `postgres`, `service_role`, `supabase_admin` | The three-role model of ADR-0005 is replaced by these. |
| `postgres` role | `super=false` but **`bypassrls=true`**, `createrole=true`, `createdb=true` | See §2. This is the single most dangerous fact here. |
| `public` schema owner | `pg_database_owner` | Not `postgres` directly, so ownership-based posture rules need rewriting rather than porting. |
| Schemas | `auth`, `extensions`, `graphql`, `public`, `realtime`, `storage` | `app` is ours to create. |

## 2. The trap: `postgres` has BYPASSRLS

**Any query run as `postgres` ignores every RLS policy, even under FORCE.**

This is V1/V4 in a new costume. Locally the hazard was the macOS login superuser; here it
is the role the CLI and every dashboard SQL editor session uses by default. A tenancy test
that connects as `postgres` passes while enforcing nothing, and so does a cross-user
denial test, and so does a forgery test.

**Rule: integration tests connect as `authenticated` with a JWT claim set, never as
`postgres`.** The existing harness guard (`assertTestConnectionIdentity`, proven fatal in
Slice 1) must be rewritten to assert the Supabase equivalent: `current_user =
'authenticated'`, `rolbypassrls = false`, owns zero relations in `public`, and a
`request.jwt.claim.sub` present. Pointing it at `postgres` must abort the run, and that
needs its own mutation proving it bites.


## 2b. The default-privilege hazard, now CONFIRMED on the live project

`docs/supabase-port-notes.md` flagged this as the one thing to verify before the first
push, because the earlier survey of this project never read `pg_default_acl`. It has now
been read, and the hazard is real.

`pg_default_acl` carries 24 rows. For tables in `public`, both `postgres` and
`supabase_admin` grant `arwdDxtm` to **`anon`** — insert, select, update, delete, truncate,
references, trigger and maintain. Measured decisively, in a rolled-back transaction on the
live project:

```
anon   SELECT=true INSERT=true UPDATE=true DELETE=true
relacl {postgres=arwdDxtm/postgres, anon=arwdDxtm/postgres,
        authenticated=arwdDxtm/postgres, service_role=arwdDxtm/postgres}
```

**This inverts the fail-closed property the canon claims at §4.2.** On local Postgres we
deliberately omit `ALTER DEFAULT PRIVILEGES … GRANT` on tables, so a forgotten grant yields
an *invisible* table — the safe direction. On Supabase the platform pre-grants everything to
the anonymous role, so a forgotten `REVOKE`, or a table shipped without RLS enabled, yields
a table that an unauthenticated caller on the internet can read and write.

Two consequences, both already in force:

1. Posture rule 1 (anything `authenticated` or `anon` can reach must be RLS-enabled AND
   forced AND carry a policy) and rule 4 extended to `anon` are **the only barrier** between
   a newly added table and the public. They are not belt-and-braces here.
2. The local emulation reproduces the permissive defaults on purpose. An emulation that is
   safer than its target never exercises the REVOKEs, so the first time they would matter is
   production. Recorded as V36.

## 3. What carries over, and what is retired

Verified on the remote inside a rolled-back transaction: `CREATE TABLE`, `ENABLE` and
`FORCE ROW LEVEL SECURITY`, `CREATE POLICY` referencing `auth.uid()`, `CREATE SCHEMA`,
`CREATE FUNCTION`, and `GRANT … TO authenticated` all succeed as `postgres`. So the schema
half of the port is mechanical.

**V2 and V30 both hold on Supabase**, measured: a newly created function reports
`has_function_privilege('public', …, 'execute') = true`, and an explicit
`REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA … FROM PUBLIC` flips it to `false`. So the
PUBLIC-EXECUTE hazard and its only working fix are unchanged, and posture rule 4 stays the
primary control.

| Survives | Retired or rewritten |
|---|---|
| The schema: tables, composite FKs, constraints | ADR-0002 own session auth, argon2id, `user_session`, `auth_attempt` → Supabase Auth |
| RLS policies, with `app.current_user_id()` → `auth.uid()` (the seam canon §4.3 built for exactly this) | ADR-0005 three-role grant model → `anon` / `authenticated` / `service_role` |
| Immutability triggers: append-only, frozen draft, no-truncate | ADR-0006 `withUser`, the eager identity probe, `DISCARD ALL` — there is no server pool in a browser client |
| The state machine: `derive_decision_state`, the transition guard, V31 ordering | `assertUnprivilegedOnce()` — nothing to assert client-side |
| Lifecycle `SECURITY DEFINER` functions (ADR-0014) | The 75 integration tests' role assertions → Supabase roles |
| `verify_security_posture()`, adapted to Supabase roles and ownership | The Node AI adapter → a Supabase Edge Function (Deno) in Slice 4 |
| The scenario content, source register and claim whitelist (Slice 2) | — |
| The mutation gate and its 15 mutations, re-pointed | — |

## 4. The security consequence, stated plainly

**RLS becomes the only wall.**

Today three layers stand between a mistake and the journal: the server boundary
(`withUser`, the eager probe, `DISCARD ALL`), the grant model (grant-protected identity
tables), and RLS. Static export plus a browser client removes the first two. The anon key
is public by design — that is Supabase working as intended, and RLS is what protects the
data — but it means the database is reachable from the internet and a single policy error
is a full breach with nothing behind it.

Two concrete losses, both measured rather than assumed:

1. **Missing identity goes from loud to silent.** Our `app.require_user_id()` raises
   `28000`. Supabase's `auth.uid()` returns **NULL**, confirmed by query. The policy still
   denies correctly — verified with a positive control: as `authenticated` with no claim, 0
   rows; with user A's claim, 1 row; A reading B's row, 0; A inserting a row owned by B
   rejected with *new row violates row-level security policy*. So it is safe, but a context
   failure no longer announces itself, and the eager-probe property of V6 cannot be kept in
   the policy predicate.
2. **No defence in depth.** Every guard that lived in `src/server/db` is gone from the
   request path.

Therefore the posture check and the mutation gate stop being good practice and become the
only thing standing between a policy typo and the journal. Both must be extended to cover
the Supabase policies, with a mutation per policy, **before real decisions are entered.**

## 5. Credentials

`.env.supabase.local`, mode 600, gitignored via `.env*.local`, plus an explicit
`.gitignore` entry. `supabase/.temp/` is gitignored too: it holds the pooler URL.

- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — **public by design.** It ships in the static bundle and
  will be readable in the published GitHub Page. That is correct and expected.
- `SUPABASE_SERVICE_ROLE_KEY` — **bypasses RLS entirely.** Never in the repo, never in the
  bundle, never in CI logs. Local admin and migration use only.
- `SUPABASE_DB_PASSWORD` — generated in-session, 40 characters from a URI-safe alphabet,
  recorded only in that file. Not supplied by Stefan and not printed in conversation. If it
  is lost, reset it in the dashboard rather than guessing.

## 6. Open, and needed before deploy

- **GitHub Pages on a private repo requires a paid plan.** The token's scopes do not expose
  the account plan, so this is unconfirmed. On the free tier the repo must be public —
  harmless for the code, since no secret lives in it, but it is Stefan's call. The journal
  itself lives in Supabase, not the repo.
- No GitHub remote exists yet. `gh` is authenticated as `TheStormKingG` with `repo` and
  `workflow` scopes, so the repo and the Pages Actions workflow can both be created here.
- No local Supabase stack: `supabase start` needs Docker, which is absent. The port is
  therefore developed against a **local emulation** — an `auth` schema with a `uid()`
  reading `request.jwt.claim.sub`, plus `anon` and `authenticated` roles on local Postgres —
  which was proven to reproduce the policy semantics faithfully. What the emulation
  cannot test: Supabase Auth's real JWT issuance, Edge Functions, and the PostgREST layer.
  Those need the live project and must be declared as such rather than assumed.
