# ADR-0016 — Expose schema `app` to PostgREST, and assert the surface it opens

* **Status:** Accepted, implemented (`supabase/migrations/20261022160000_expose_app_schema_to_postgrest.sql`)
* **Date:** 2026-10-22
* **Supersedes:** nothing. **Amends:** ADR-0014 (the lifecycle write path), ADR-0015 §"what the port supersedes".
* **Requirements touched:** FR-04, FR-05, FR-12 (reachability of the write path); NFR-01, NFR-02.

## Context

ADR-0014 put the lifecycle write path behind three `SECURITY DEFINER` functions in schema
`app` — `submit_decision`, `append_revision`, `stamp_milestone`. Under the pre-port
architecture that was a server-side concern: a Node process connected as `statesman_app`
and `app` was a schema the application role could reach but not inspect.

ADR-0015 removed the server. The browser now speaks to PostgREST directly with the
publishable anon key, and PostgREST serves only the schemas the project lists as exposed.
`src/lib/supabase/client.ts` noted this and marked it **UNVERIFIED**, because the work that
wrote it was forbidden from contacting the project.

It was never configured. Measured against `onpkspfxfmjkqpomcsse` with the anon key:

```
POST /rest/v1/rpc/stamp_milestone   Content-Profile: app
  HTTP 406  {"code":"PGRST106","message":"Invalid schema: app",
             "hint":"Only the following schemas are exposed: public, graphql_public"}
```

With the control that distinguishes *which* fault this is — the same call with no
`Content-Profile` returned a different code, `PGRST202` ("Searched for the function
`public.stamp_milestone` … no matches were found in the schema cache").

So the entire lifecycle write path was unreachable from the browser. The only legal writer
of `submitted_at` (canon §4.6b) could not be called at all, and every submit in the product
would have failed at its first request. **Nothing in the repository could see this**: the
integration suite connects to PostgreSQL directly and never crosses PostgREST, so 121 tests
and a green mutation gate coexisted with a dead write path.

## Decision

Expose schema `app` to PostgREST **from a migration**, and add a second gate,
`app.verify_rest_exposure()` (SQLSTATE `ST097`), asserting the four properties that make
the exposure safe.

The exposure is set as in-database PostgREST configuration:

```sql
alter role authenticator set pgrst.db_schemas = 'public, graphql_public, app';
notify pgrst, 'reload config';
notify pgrst, 'reload schema';
```

Both NOTIFYs are required. Measured: `reload config` alone re-read the schema list but left
the cache without `app`'s contents, so every call answered `PGRST202` — indistinguishable
from "the function does not exist".

## Alternatives considered

### (a) Move the three entry points into `public`, which is already exposed — rejected

`public` is the conventional home for Supabase RPCs, so this was the obvious candidate. Two
things ruled it out, both measured rather than assumed:

1. **It fights the project's own mandated habit.** `20261021140100` and `20261021140500`
   both end with `revoke execute on all functions in schema public from public, anon,
   authenticated, service_role`, and that line is repeated in *every* migration by the
   V2/V30 rule. "No function in `public` is callable by any client role" is a deliberate
   invariant, not an accident. Entry points there would have their grants stripped by the
   next migration anyone wrote — a grant destroyed by our own convention, with no diff to
   show it.
2. **It fights a platform default as well.** `pg_default_acl` on the live project grants
   `EXECUTE` on every new function in `public` to `anon`, `authenticated` **and**
   `service_role` (`public|f|… anon=X authenticated=X service_role=X`). Schema `app` has no
   `pg_default_acl` entry of any kind, so nothing in it is auto-granted to anyone. Putting
   privileged functions in the schema with the permissive default, and relying on a revoke
   repeated by hand, is the weaker of the two arrangements.

### (b) Thin `SECURITY INVOKER` wrappers in `public` delegating to `app` — rejected

Same revoke problem as (a), and it buys no privilege boundary: the caller needs `EXECUTE`
on the inner definer function regardless, so the wrapper is a hop with a cost and no
guarantee.

### (c) Set "Exposed schemas" in the dashboard — rejected

This is the documented route and it works. It is also unversioned state: no migration
contains it, the local emulation does not reproduce it, no test can assert it, and a project
rebuilt from this repository comes up with the write path dead and every gate green. The
project's standing rule is that a control nothing can observe has already failed; a
configuration nothing can observe is the same defect one layer down.

## Why exposing a schema is safe here — measured, not argued

Exposing a schema serves its **relations** as REST collections and its **functions** as RPC
endpoints. On the live project at the time of writing:

| property | measured |
|---|---|
| relations (table/view/matview/foreign) in `app` | **0** |
| functions in `app` executable by `anon` | **0** |
| functions in `app` executable by `service_role` | **0** |
| functions in `app` executable by `authenticated` | **6** |
| `has_schema_privilege('anon','app','USAGE')` | **false** |
| `has_schema_privilege('service_role','app','USAGE')` | **false** |
| `has_schema_privilege('authenticated','app','USAGE')` | **true** |

And the refusal was observed end to end rather than inferred. After the schema-cache reload,
the anonymous request stopped returning PostgREST's `PGRST202` and started returning
PostgreSQL's:

```
HTTP 401  {"code":"42501","message":"permission denied for schema app"}
```

The function is in the cache, PostgREST attempted the call, and the database refused it **at
the schema boundary** — before any policy, before any function body. That is grant-absence,
which canon §5.2 calls strictly stronger than RLS. `service_role` received the same `42501`
at HTTP 403.

**The six, not three.** `authenticated` could already execute six functions in `app`: the
three entry points plus `current_user_id()`, `require_user_id()` and
`derive_decision_state(...)`, granted explicitly by `20261021140100` lines 147-149. Those
three are deliberate and disclose nothing — two return the caller's own identity, the third
is `IMMUTABLE` and reads no table, and its rules are in this public repository already. But
the number was *discovered by querying the live catalogue*, not stated anywhere, which is
why rule E3 now pins it.

## The four rules (`ST097`)

| rule | asserts | why it is not redundant |
|---|---|---|
| **E1** | `authenticator`'s `pgrst.db_schemas` names `app` | the defect that shipped |
| **E2** | `anon` and `service_role` hold no `USAGE` on `app` | this is *why* exposure is safe; one grant would move the refusal from "cannot enter" to "whatever each function checks" |
| **E3 / E3b** | the set of `app` functions executable by a client role equals `public.posture_rest_allow`, **in both directions** | a granted-but-unregistered function is an unreviewed public endpoint; a registered-but-ungranted one means the application's own grant was lost |
| **E4** | no relation in `app` is client-reachable | `app.verify_security_posture()` rule 1 scans `public` **only**, so a table added to `app` would be served over HTTP with no rule requiring RLS on it |

E4 is the hole the exposure itself opened, and it is the reason this ADR exists rather than
a one-line config note.

Every rule has a control in `tests/integration/rest-exposure.test.ts` that violates it
deliberately and asserts **its own** message fragment plus the absence of every other rule's
— the attribution discipline of ADR-0009. Mutations M24–M28 prove each rule can be killed;
M28 is the one that makes the code look *better*, replacing the membership scan with a
single `LIKE` that accepts `application` and `app_private` as matches for `app`.

## Consequences

### Accepted cost 1 — rule E1 is record-keeping, and says so

E1 reads `rolconfig`. That proves the *intended* value is recorded. It does **not** prove
PostgREST honours it: if the platform's own configuration later took precedence, rolconfig
would still name `app` and E1 would still pass while the API answered 406. No statement
executed inside PostgreSQL can close that gap.

It is handed to an instrument that can see it: `scripts/verify-rest-exposure.sh` issues the
real request and grades it as one of three states (`42501` healthy, `PGRST106` exposure
gone, `PGRST202` cache stale), and it **refuses to report at all** unless its positive
control — asking for a schema that does not exist — still produces `PGRST106`. A probe that
can no longer detect the failure it was built for otherwise reports success.

That script needs the live project and the anon key, so it is deliberately **not** part of
`npm run gates`, which must pass with no credentials and no network.

### Accepted cost 3 — the authenticated round trip is NOT YET PROVEN

`42501` proves schema `app` is served and that an anonymous caller is refused. It does
**not** prove a signed-in user can execute the lifecycle RPCs. Those are two claims, and
only the first was provable when this ADR was written: no account exists on the project, and
creating one — or setting a password — is the owner's action.

The catalogue says the chain is intact: `authenticated` holds `USAGE` on `app` and `EXECUTE`
on all three entry points. **A privilege reading is not a round trip**, and this project's
standing rule is that the two are not interchangeable, so the claim is carried as unproven
rather than inferred.

`scripts/verify-rest-exposure.sh` has a second leg that closes it in one command once an
account exists (`STATESMAN_PROBE_EMAIL` / `STATESMAN_PROBE_PASSWORD`). It calls
`app.stamp_milestone` on an all-zeros decision id, which matches no row, writes nothing, and
must return **ST005** — our own SQLSTATE, raised from inside the body after
`app.require_user_id()` resolved an identity and the UPDATE ran. Neither PostgREST, nor a
permission failure, nor a stale cache can produce ST005. Its control is a second call with
an invalid milestone, which must return **ST012** from the argument check *before* the
UPDATE: two different in-body errors from two different inputs is what separates "the body
ran" from "something returned an error I recognised". Without credentials the leg prints
**NOT RUN** and is never counted as a pass.

### Accepted cost 2 — one statement is not exercised locally

`pgrst.db_schemas` is a custom GUC placeholder, and PostgreSQL 17 restricts
`ALTER ROLE … SET` on a placeholder to a superuser. The live `postgres` is **not** a
superuser (`rolsuper=f`, measured) and the statement succeeds there anyway: it holds
`supabase_privileged_role` and `authenticator` preloads `supautils`. The emulated `postgres`
has neither, and the statement fails with `permission denied to set parameter`.

`scripts/emulate-supabase.sh` therefore sets the value itself as the cluster superuser,
standing in for a platform privilege exactly as `20261022150000` stands in for the platform
BYPASSRLS roles. **The cost, stated plainly: a local run cannot prove that one ALTER ROLE
statement works.** It is verified against the live project by execution and by the HTTP
probe. Everything around it — parsing the list, deciding membership, appending without
overwriting, and E1's own verdict — lives in `app.pgrst_schema_exposed()` and
`app.pgrst_schema_list_with()`, which are pure, callable and covered locally with positive
controls. The uncovered surface is one statement, and it is named here.

The rejected alternative was granting the local `postgres` `SUPERUSER` so the migration ran
unmodified. That is the V1/V34 mistake — a privileged role under test making every isolation
check pass vacuously — and this project has already made it twice.

### Corrected along the way

The emulation granted `postgres` three of the four client roles and granted them **without**
`ADMIN OPTION`. Measured on the live project, `pg_auth_members` shows `postgres` holding
`anon`, `authenticated`, `authenticator` **and** `service_role`, every one with
`admin_option = t`. The gap was not cosmetic: it made this migration fail locally with
`permission denied to alter role` while succeeding on the project, which reads as a fault in
the migration when the fault was in the emulation. Corrected to the measured shape.

### Not changed

`app.verify_security_posture()` is untouched. The new rules are a separate function with a
separate SQLSTATE because the remediation differs — `ST097` means the REST surface is wrong
(a setting or a grant), `ST099` means the schema is wrong (SQL) — and because adding them to
a 280-line function would have meant reproducing all twelve of its rules in the new
migration, producing a diff in which everything changed.

`migrate.sh` calls both gates, unconditionally and with separate exit statuses, so a REST
fault cannot hide behind a schema fault.
