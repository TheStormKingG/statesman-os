# Supabase port notes — the migration set and the local emulation

**Date:** 2026-10-21
**Scope:** ONE Supabase-shaped migration set (`supabase/migrations/`) plus a local
emulation (`scripts/emulate-supabase.sh`) so it is testable without Docker.
**Status:** built and verified BY EXECUTION against the local emulation only.
**Nothing in this work touched project `onpkspfxfmjkqpomcsse`.** No `supabase db push`, no
CLI call, no query. Read [ADR-0015](adr/ADR-0015-static-github-pages-plus-supabase.md)
first, then [supabase-target.md](supabase-target.md).

Every claim below is marked **MEASURED** (executed on the local emulation in this session),
**CARRIED** (a canon V-fact that transfers because the server is identical), or
**UNVERIFIED** (true of the live project only if the assumption stated holds — it was not
and could not be tested here).

---

## 1. The design decision you asked to be stated: what replaces `app_user`

**`public.profile`, one row per `auth.users` row, with the primary key column named
`user_id` and a real foreign key `references auth.users (id) on delete restrict`.**

`user_session` and `auth_attempt` are **dropped**, not ported. ADR-0015 retires ADR-0002,
and GoTrue owns sessions, refresh tokens and sign-in rate limiting. A second session table
would be a second source of truth for whether a session is live, and the one we controlled
would be the one not consulted at sign-in. `auth_attempt` existed to rate-limit sign-in
failures that now never reach this database — a table written only after a *successful*
authentication cannot count the failures it was built for. `password_hash`, `algo_ver`,
`privilege_epoch` and `email` all go with them: credentials must not exist here at all, and
`privilege_epoch` was a number we incremented that nothing would check any more, which is
worse than no mechanism because it reads as one.

Three things about the choice are worth defending:

**The PK column is `user_id`, not `id`.** Same value either way, so this looks like a
naming preference. It is not. Posture rules 9 (SENTINELS) and 10 (NOT NULL) locate the
owner column *by name*, and canon §4.8 says in as many words that `app_user` "whose column
is `id`" was the table an `attname='user_id'` selector was proven to miss. `app_user` was
therefore waived out of rule 9 and carried as "grant-protected" instead — which was true,
because it had no grants to `statesman_app` and was reachable only through definer
functions. **That escape is gone**: `profile` *is* reachable by `authenticated`, because
a signed-in user edits their own display name directly and there is no server left to proxy
it. A table protected by a policy needs a sentinel or its denial test is a read of an empty
table (V18). Naming the column `user_id` makes both rules apply with no exemption and no
special case.

**The foreign key is real, and it points at `auth.users(id)`** — the identity Supabase
actually issues. `profile` is the single row-level anchor into the `auth` schema;
`decision` and `decision_revision` reference `profile(user_id)`, which keeps the rest of
the FK graph inside `public`, the half of the database this repository owns. The chain is
`decision → profile → auth.users`.

**`ON DELETE RESTRICT`, not CASCADE, and it has a visible cost:** deleting a user from the
Supabase dashboard will FAIL while that user has a profile. That is canon §5.2, which
forbids a cascade from the identity table because it "silently destroys the audit history
NFR-03 and FR-16 require". Erasure is a product feature with a deliberate path, not a side
effect of clicking delete in someone else's console. Restrict at every link.

---

## 2. The set

Nine files, CLI-timestamped, lexically ordered. `scripts/migrate.sh` runs the emulation
bootstrap, then the glob, then the posture check.

| File | From | What changed |
|---|---|---|
| `20261021140000_harden_public_schema.sql` | `0000` (database half only) | Roles are the platform's and are **not** created. Removes Supabase's permissive default privileges, `revoke create on schema public`, `revoke temporary on database` via `current_database()`. |
| `20261021140100_app_schema_and_state.sql` | `0001` | `app.current_user_id()` → `auth.uid()`. `app.require_user_id()` kept as the raising accessor, now wrapping `auth.uid()`, used **only** by the lifecycle functions. Enum, `derive_decision_state`, `forbid_mutation` unchanged. |
| `20261021140200_profile.sql` | `0002` | See §1. Three tables → one. |
| `20261021140300_decision.sql` | `0003` | Policies call `auth.uid()`. FK retargeted to `profile(user_id)`. Generated column, V28/V29/V31 guard, V15/V32 triggers, composite FK all unchanged. |
| `20261021140400_lifecycle_functions.sql` | `0004` | **One code change** — see finding P1. |
| `20261021140500_verify_security_posture.sql` | `0005` | Rewritten. See §4. |
| `20261021140600_sentinels.sql` | `0006` | `app_user` → `profile`, plus an `auth.users` row, plus a paired control run as `authenticated`. |
| `20261021140700_scenario_content.sql` | `0008` | Policies → `auth.uid() is not null`. CTRL-3/CTRL-4 **rewritten**, not translated. Five rule-9b registrations added. |
| `20261021140800_seed_demo_ph_001.sql` | `0009` | Content untouched. SEED-CTRL-A/B rewritten. |

There is no `0007` in the original set and none here.

**One set, not two.** Local Postgres is bent to match Supabase, never the reverse. Two
divergent sets would drift and the drift would be invisible until deploy.

### The pre-port set is DELETED — where the "From" column points

**`migrations/0000..0009` no longer exists in the tree.** It was removed on 2026-10-22,
because for a day the two sets coexisted, which is precisely the divergence this section
claims to prevent. The "From" column above, and every `-- Ported from migrations/000N…`
comment inside `supabase/migrations/*.sql`, therefore names a file that is only in git
history. It is recoverable and nothing was lost:

```
git show b3a5f59:migrations/0005_verify_security_posture.sql     # or any of the nine
git log --oneline -- migrations/                                  # b3a5f59 is the last commit that touched it
```

All nine files were committed and clean at the moment of deletion (`git status` reported
nine plain deletions and no staged or unstaged modification), so git history is a complete
copy rather than an approximate one. Read "migrations/0008" anywhere in this repository as
"the pre-port `migrations/0008`, in git history at b3a5f59".

`scripts/db-bootstrap.sh` went with it. It applied `migrations/0000_bootstrap_roles.sql`,
which created the three `statesman_*` roles; those roles do not exist on either target now,
so the script is a **loud refusal**: it prints what replaced it and exits **2**. Not
deleted, because `npm run db:bootstrap` is still in `package.json` and in three places in
`docs/implementation-plan.md`, and not rewritten as a wrapper around
`emulate-supabase.sh` either, because the emulation is already step 1 of `migrate.sh` and a
second door into it invites someone to bootstrap a database and then wonder why it has no
schema. A retired step that exits 0 is a step that looks done.

---

## 3. The emulation

`scripts/emulate-supabase.sh <database>`, idempotent, run first by `migrate.sh`.

**Reproduced, including the hazards:**

- Roles `anon`, `authenticated`, `service_role`, `authenticator`, `postgres` with
  Supabase's attributes — `postgres` NOSUPERUSER **but BYPASSRLS**, `service_role` NOLOGIN
  **BYPASSRLS**, `authenticator` NOINHERIT holding the other three.
- `auth.uid()` returning **NULL** when no claim is set, coalescing the flattened
  `request.jwt.claim.sub` GUC with the `sub` member of the JSON `request.jwt.claims` GUC,
  which is Supabase's published definition. STABLE, not IMMUTABLE.
- Ownership: database owned by `postgres`, schema `public` by `pg_database_owner`, the
  `auth` schema **not** ours.
- Supabase's stock permissive default privileges in `public` (finding P4).
- A minimal `auth.users` with the four columns our set touches, plus
  `auth.emulate_signup()` for fixtures.
- `auth.is_emulation()`, the marker that keeps rule 11's local concession local.

**NOT reproduced. Anything depending on these is UNVERIFIED:**
GoTrue itself (real sign-up, JWT issuance and verification, email confirmation, the rest of
`auth.users`' columns, every other `auth` table); PostgREST (the HTTP layer, its role
switching, its schema cache, its error shapes); Edge Functions, Realtime, Storage, the
pooler; `supabase_admin` / `supabase_auth_admin` / `supabase_storage_admin`; and the
cluster superuser, which exists here (`rolsuper`, `rolbypassrls`, `trust` auth — V1) and on
no Supabase project.

The emulation **asserts its own central property in SQL that raises**: `auth.uid()` must be
NULL without a claim and must resolve both GUC forms. If someone "improves" the shim to
fail loudly like the retired `app.require_user_id()`, the bootstrap aborts rather than
letting every downstream denial test start measuring the emulation.

---

## 4. The posture check

### Changed

| Rule | Was | Now |
|---|---|---|
| 1 REACHABILITY | `statesman_app` | **1a** `authenticated`; **1b (new clause)** `anon` must hold **nothing at all** on any public table |
| 3 OWNERSHIP | not owned by `statesman_app` | not owned by any role a browser can become (`anon`, `authenticated`, `service_role`) — `public` is `pg_database_owner`'s and our relations are `postgres`'s, so the old rule could not be ported literally |
| 4 NO PUBLIC EXEC | PUBLIC | PUBLIC **and `anon`** (the default ACL grants it directly, and revoking from PUBLIC does not touch a direct grant) |
| 6 VOLATILITY | `app.require_user_id()` | plus `app.current_user_id()` **and `auth.uid()`** |
| 7 NO TRUNCATE | one hardcoded table | every table carrying a BEFORE TRUNCATE trigger, so 0008's five are covered automatically |
| 8 POLICY SHAPE | mentions `require_user_id` | mentions **`auth.uid()`** — which also catches an incompletely ported policy still scoped by a GUC nothing sets |
| 9 SENTINELS | skipped exempt tables | **split 9a/9b; nothing escapes** — see below |

### Added

- **Rule 11 BYPASSRLS.** No role that *is* or *can become* BYPASSRLS may exist outside
  `public.posture_bypassrls_allow`. Membership is tested with
  `pg_has_role(…, 'MEMBER')`, not `'USAGE'`, because V3 measured a role with
  `rolbypassrls = false` that was a MEMBER of a BYPASSRLS role passing an attribute check
  while `SET ROLE` to it succeeded. The rule is deliberately *not* "which tables can it
  reach": a bypassrls role reaches everything by definition, so a table-level test would
  report the symptom and miss the cause.
- **Rule 12 BROAD GRANTS.** The same for `pg_read_all_data` / `pg_write_all_data`
  membership. They do not carry BYPASSRLS, so rule 11 misses them and RLS does still
  apply — but they confer access to everything that exists *and everything added later*,
  which defeats the per-table reasoning rules 1 and 2 are built on. V34 recorded each
  slipping through an attribute-only predicate separately.

### Rule 9, and the gap the port closed

The old rule 9 skipped any table in `posture_exempt_table`, and `0008` used that to waive
its five reference tables because their sentinels are keyed by `id`, not `user_id`. The
sentinels were seeded and the comment argued at length that the evidence requirement was
met — **but nothing checked them.** Five protected tables carried an unenforced sentinel:
true the day it was written, with nothing to notice when it stopped being true.

Rule 9 is now two rules:

- **9a** — protected table with a `user_id` column: exactly one row owned by the reserved
  sentinel uuid. Unchanged.
- **9b** — protected table *without* one: it **must** be registered in
  `public.posture_sentinel_row (table_name, id_column, sentinel_id, reason)`, and that row
  is counted. Unregistered is a failure, not a skip. Both identifiers are checked against
  `pg_attribute` and interpolated with `format('%I')`; the value is a bind parameter
  compared as text, so no free-form SQL is stored or executed.

`posture_exempt_table` now waives **rule 2 alone**. It shrank from four rows plus five to
three: the three registries themselves.

### Why rule 9 stopped being thorough and became indispensable

`app.require_user_id()` raised `28000`; `auth.uid()` returns NULL. A read with no claim now
returns zero rows and raises nothing. V7 already said a row count of 0 is never a success
signal and V18 said an empty table with RLS and an empty table with no RLS both return 0.
Together: **on an empty protected table, a correct policy, a broken policy and no policy at
all are three names for the same observation.** A seeded sentinel is the only thing that
turns a zero back into evidence.

### The allowlist, printed on every build

`db-template.sh` prints `posture_bypassrls_allow` in full. Seeded rows: `postgres`,
`service_role`, `supabase_admin`, `authenticator` — each with a reason. The local cluster
superuser is admitted **only when `auth.is_emulation()` exists**, which is true on no
Supabase project. "Ignore superusers" was not an option: that is precisely the V1/V34
mistake in which a privilege predicate reading role attributes passed a privileged role.

---

## 5. Findings

### P1 — `postgres` is BYPASSRLS, so a SECURITY DEFINER function no longer gets RLS for free. **MEASURED, both directions.**

This is the port's single most dangerous fact reaching into application code rather than
into a test harness, and it is the same shape: the enforcement disappears while everything
still returns successfully.

Canon §4.6b states, and verified at the time, that `app.require_user_id()` inside a definer
function still resolves to the *caller*, so "a definer function is scoped to the caller's
own rows **by the same policy** that scopes the app role". The first half still holds —
`auth.uid()` reads a request-scoped GUC, not the session role. **The second half does
not.** These functions were owned by `statesman_owner`, which was `rolbypassrls = false`
(V34) and so was still subject to its own tables under FORCE (V8/V9); the policy ran inside
the body. On Supabase they are owned by `postgres`, which is BYPASSRLS. **RLS is skipped
entirely inside these bodies.**

Most statements were already explicitly scoped (`and d.user_id = me`). **One was not:** the
idempotency lookup in both `submit_decision` and `append_revision` read
`where dr.idempotency_token = p_token` with no owner predicate, because the policy supplied
one. Under a bypassrls definer it matches **any** user's row, so user B replaying user A's
idempotency token receives A's `revision_id` and `revision_no` with `replayed = true` — a
cross-tenant identifier leak out of a code path whose whole purpose is to look like it did
nothing. It raises no error and affects no rows, so V7 covers it and nothing else would.

Fixed by adding `and dr.user_id = me` to both. `dr_token_uq` is UNIQUE table-wide, so this
cannot change a legitimate replay by the token's own owner.

Measured, as a paired control:
- `B2` B replaying A's token → **`ST011`**, no row returned. (fixed code)
- `B3` the same probe against a mutant with the predicate removed → **B received A's
  `revision_id` with `replayed = true`**. The leak is real and the predicate is what
  prevents it.

### P2 — `auth.uid()` returns NULL where `app.require_user_id()` raised `28000`. **MEASURED.**

Consequences acted on rather than noted:

- **Policies call `auth.uid()` directly**, never a raising wrapper. A policy predicate that
  raised would give the local target a failure mode the live one does not have, and every
  local denial test would then be measuring the wrapper.
- **`app.require_user_id()` survives** and is still raising, but its only callers are the
  lifecycle definer functions. A function body is not a policy predicate, so V6's
  fail-loud property is kept in the one place the port still permits it: a lifecycle call
  with no identity raises `28000` rather than reporting `ST010` "not a submittable draft",
  which is the difference between a diagnosable bug and a misleading one.
- **Three controls were rewritten rather than substituted**, because a comment that still
  promised the `28000` would be a false claim about a security control: `0008`'s
  CTRL-3/CTRL-4, `0009`'s SEED-CTRL-A/B, and the sentinel migration's own paired control.
  All three now measure **row counts as `authenticated`** and assert explicitly that the
  claimless read **raises nothing** — because an error there would mean something is
  reproducing the retired semantics.
- Several comments arguing *from* the `28000` were inverted, not deleted. `0008`'s declared
  residual on post-publication edits to `source`/`scenario_claim` is the clearest: the
  original objection to closing it was that the guard's parent lookup would raise `28000`
  in its only caller. Post-port that guard would read the parent, find nothing, conclude
  "not published", and **permit the edit silently**. The objection got *worse*.

### P3 — a blanket `revoke execute on all functions in schema app … from authenticated` silently strips earlier migrations' grants. **MEASURED.**

Widening the end-of-migration REVOKE from `public` (as `0001` had it) to
`public, anon, authenticated, service_role` looked like it was covering the default ACL. It
also meant that `20261021140300`'s REVOKE removed the `app.derive_decision_state` grant
made in `20261021140100`, because `ALL FUNCTIONS` means every function that exists by then.
The first `insert into public.decision` as `authenticated` failed with **"permission denied
for function derive_decision_state"** — a generated column evaluates its expression as the
*inserting* role — and the failure surfaced three migrations away from its cause.

Resolution, now stated in the file: schema `app` is revoked from `public, anon` **only**.
Schema `public` names all four, which is safe *only* because this project creates no
functions in `public` at all; if that changes, that list has the same hazard.

### P4 — Supabase's stock default privileges grant `anon` ALL on new tables in `public`. **CONFIRMED on the live project 2026-10-22 by reading `pg_default_acl`.**

**SETTLED.** `pg_default_acl` on `onpkspfxfmjkqpomcsse`, read as `postgres`:

```
public | r | postgres=arwdDxtm/supabase_admin anon=arwdDxtm/supabase_admin authenticated=arwdDxtm/supabase_admin service_role=arwdDxtm/supabase_admin
public | S | postgres=rwU/supabase_admin      anon=rwU/supabase_admin      authenticated=rwU/supabase_admin      service_role=rwU/supabase_admin
public | f | postgres=X/supabase_admin        anon=X/supabase_admin        authenticated=X/supabase_admin        service_role=X/supabase_admin
```

So the emulation did not overstate the hazard: tables, sequences **and functions** created
in `public` are auto-granted to `anon`. Two consequences beyond the three controls below:

* the `f` row is why "no function in `public` is callable by any client role" needs an
  explicit revoke in every migration — it is fighting a live default, not tidying up. That
  measurement is one of the two reasons ADR-0016 rejected moving the lifecycle entry points
  into `public`;
* **schema `app` has NO `pg_default_acl` entry of any kind**, so nothing in it is
  auto-granted to anybody. That is why ADR-0016's rule E4 guards against a deliberate grant
  rather than an automatic one, and it is the measured difference between the two schemas.

A stock project ships
`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon,
authenticated, service_role` (and the same for sequences and functions). The consequence is
that a table is, the instant it exists, fully readable and writable by the role the
published GitHub Page resolves to with the publishable key.

This is V2/V30 in different clothes, with one difference: these are real rows in
`pg_default_acl` rather than the built-in PUBLIC default, so `ALTER DEFAULT PRIVILEGES …
REVOKE` **does** delete them (V30's no-op applies only to the built-in default). Three
controls, because the first two can each be undone by something outside this repository:

1. the default ACL rows are deleted in `20261021140000`;
2. every migration that creates a table nevertheless ends with an explicit
   `revoke all on table … from anon, authenticated, service_role` followed by the narrow
   grants it intends;
3. posture rule 1b aborts the run if `anon` holds anything at all.

**Verification status, stated plainly:** `docs/supabase-target.md` §1 measured roles,
`auth.uid()`, ownership and the V2/V30 behaviour on the live project. It did **not** read
`pg_default_acl`. The claim above is Supabase's documented bootstrap, reproduced locally.
The emulation deliberately reproduces the **more dangerous** shape, so if the live project
turns out not to carry these defaults, our controls are merely redundant — which is the
safe direction to be wrong in. **Confirm with a `pg_default_acl` read before the first
push.**

### P5 — the sentinel identity needs a row in `auth.users`. **MEASURED locally; UNVERIFIED on the live project.**

`profile.user_id` carries a real FK to `auth.users(id)`, so the reserved owner must exist
there. The insert is narrow on purpose — `id`, `email`, `created_at`, `updated_at`:

- **no password column is written at all.** `encrypted_password` is nullable and NULL can
  never verify against any credential, which is strictly stronger than `0006`'s trick of
  storing a deliberately malformed argon2 encoding. The sentinel cannot be signed in as.
- the email is at `.invalid` (RFC 2606), so no magic link or recovery mail can reach it.
- four columns, matching exactly what the emulation's minimal `auth.users` provides, so
  the local insert exercises the same column list as the live one.

**Residual:** the real `auth.users` is GoTrue's and carries many more columns. All are
nullable or defaulted as far as the published schema goes, so the insert is *expected* to
succeed — but expected is not measured. If GoTrue requires a column we do not supply, the
migration **aborts at the insert**, which is the correct failure mode: loud, at migration
time, before any real decision is entered.

### P6 — the Supabase CLI cannot run psql backslash commands. **CARRIED constraint, acted on.**

Every original migration began `\set ON_ERROR_STOP on`. The CLI sends migration files to
the server as SQL, so that line is a syntax error there while working locally — a
divergence that would only appear on the first push. **There are no backslash commands
anywhere in `supabase/migrations/`.** Statement-level abort comes from the caller:
`psql -v ON_ERROR_STOP=1` in `migrate.sh`, and the CLI's own per-file transaction.

### P7 — `postgres` needs EXECUTE on `auth.uid()`. **MEASURED.**

The lifecycle functions are SECURITY DEFINER owned by `postgres` and call
`app.require_user_id()` → `auth.uid()`. Without the grant, `authenticated` calling
`app.submit_decision()` fails with **"permission denied for function uid"** from inside the
definer body, because the privilege is checked against the **function owner**, not the
caller. The caller's own grant does not help. The emulation grants it to `postgres`
alongside the three client roles.

### P8 — `postgres` needs REFERENCES on `auth.users`. **MEASURED.**

The first draft of the emulation created the `auth` schema `authorization postgres`, which
made `postgres` the owner and masked the privilege. Creating the FK then failed with
**"permission denied for table users"** once the schema was made platform-owned — which is
the error a deploy would have produced. The emulation now keeps `auth` and `auth.users`
owned by the bootstrap role (mirroring `supabase_auth_admin`) and grants `postgres`
`select, insert, references` and nothing else. UPDATE and DELETE are deliberately withheld:
nothing in this set modifies or removes an identity, and if something later tries it should
fail here rather than discover on the live project that it was editing GoTrue's table.

### P9 — `postgres` cannot redefine `auth.uid()` under the emulation. **MEASURED, and it is a property worth keeping.**

Because the `auth` schema is platform-owned, a migration in this set cannot weaken the
platform's identity accessor even by accident ("permission denied for schema auth"). The
posture probe that mutates `auth.uid()` to IMMUTABLE has to run as the cluster superuser
precisely because nothing our set can do produces that state.

### P10 — `CREATE DATABASE … TEMPLATE` carries neither the database ACL nor the owner. **CARRIED, documented at the point of use.**

`revoke temporary on database` is applied against `current_database()`, so the template has
it and a clone does not (V22: a temp table shadows an unqualified reference to a real
table). And `CREATE DATABASE` sets the owner to the *creating* role, so a clone made by the
bootstrap superuser is owned by it rather than by `postgres` — which changes what
`pg_database_owner` resolves to and therefore who owns schema `public`, which three posture
rules are written against. `db-template.sh` prints both requirements at the end of every
build: clone with `OWNER postgres` and re-apply the database ACL per clone.

### P11 — the ST020/ST021 error-mapping obligation moved, it did not disappear.

`0008` recorded an owed follow-up to map ST020/ST021 in `src/server/db/errors.ts`.
ADR-0015 retires `src/server/db/**` entirely. A custom SQLSTATE now arrives at the browser
through PostgREST in a JSON error body, so the mapping is owed in the slice that builds the
screens. Recorded here rather than dropped with the file that used to carry it.

### P12 — the pipeline-exit-status bug is still live, and I hit it in this session.

`db-template.sh` has carried a comment since Slice 1 that psql must never be piped into a
filter, because a pipeline reports the **filter's** status. While running my own
verification I piped `psql … | grep PASS` and read `rc=0` from a run that had actually
exited **3**. The scripts were already right; the habit is what fails. Both scripts now
capture `$?` on the line immediately after every psql invocation and act on it, and
`migrate.sh` additionally sets `pipefail` so a pipeline added later by someone who does not
read the comment still fails.

### P13 — `migrate.sh` refuses a zero-migration run.

An empty glob would leave an empty database that the posture check passes **trivially**:
every rule enumerates relations, and there are none. That is V7's rule applied to the
migration runner itself, and it is now an explicit refusal rather than a silent success.

---

## 6. Verification log — all against the local emulation, real exit codes

Build, from a dropped database:

```
psql -c 'create database statesman_port_scratch'            rc=0
scripts/migrate.sh statesman_port_scratch                   rc=0
  emulate-supabase.sh                                       rc=0
  20261021140000_harden_public_schema.sql                   rc=0
  20261021140100_app_schema_and_state.sql                   rc=0
  20261021140200_profile.sql                                rc=0
  20261021140300_decision.sql                               rc=0
  20261021140400_lifecycle_functions.sql                    rc=0
  20261021140500_verify_security_posture.sql                rc=0
  20261021140600_sentinels.sql                              rc=0
  20261021140700_scenario_content.sql                       rc=0
  20261021140800_seed_demo_ph_001.sql                       rc=0
  app.verify_security_posture()                             rc=0   "posture OK"
TEST_TEMPLATE_DB=statesman_port_template scripts/db-template.sh  rc=0
```

The in-migration controls run on **every** build, not only in a probe script: the sentinel
paired control (`20261021140600`), CTRL-1 … CTRL-6 (`20261021140700`) and SEED-CTRL-A/B/C
(`20261021140800`). The run above therefore includes them passing.

Template, measured rather than assumed: 11 public tables — 8 forced-RLS with one policy
each (`profile`, `decision`, `decision_revision`, `scenario`, `scenario_version`, `source`,
`scenario_claim`, `rubric_version`), 3 registries exempt and reachable by nobody; all
relations owned by `postgres`; `anon_reachable_public_tables = 0`;
`authenticated_public_tables_owned = 0`; `authenticated_holds_TEMP_on_db = false`;
sentinels 9a 1/1/1 and 9b all five registered.

Probe suite, each leg in its own **rolled-back** transaction, psql's own `rc=0`:

| Leg | What it establishes | Result |
|---|---|---|
| A1 | as `authenticated` with A's claim, A sees A's row | PASS (1) |
| A2 | **no claim → 0 rows AND no error** (the silent-denial semantics) | PASS |
| A3 | A reading B's row by id | PASS (0) |
| A4 | A inserting a row owned by B | PASS (refused, `42501`) |
| A5 | positive control: A sees exactly its own row, not B's and not the sentinel | PASS (1) |
| A6 | the harness facts ADR-0015 requires: `current_user='authenticated'`, `rolbypassrls=false`, 0 owned relations in `public` | PASS |
| B1 | A's own submit | PASS (rev 1, not replayed) |
| B2 | B replaying A's idempotency token | PASS (`ST011`, no row) |
| B3 | **the mutant**: same probe with the owner predicate removed → B receives A's `revision_id`, `replayed=true` | PASS (the leak reproduces) |
| C0 | positive control: posture clean before each probe | PASS |
| C1 | a 9a sentinel deleted | PASS (`ST099`) |
| C2 | a **second** sentinel row — "exactly one" in the other direction | PASS (`ST099`) |
| C3 | a **reference** sentinel deleted — invisible under the old rule 9 | PASS (`ST099`, names rule 9b) |
| C4 | a 9b registry row naming a column that does not exist | PASS (`ST099`) |
| D1 | a BYPASSRLS role that can reach a table | PASS (`ST099`) |
| D2 | **V3's case**: `rolbypassrls=false` but a MEMBER of a bypassrls role | PASS (`ST099`) |
| E1 | `anon` granted SELECT | PASS (`ST099`) |
| E2 | a protected table with no `user_id` and no registration | PASS (`ST099`) |
| E3 | a policy still written against `require_user_id()` | PASS (`ST099`) |
| E4 | `auth.uid()` made IMMUTABLE | PASS (`ST099`) |
| E5 | a function left with PUBLIC EXECUTE (V2/V30) | PASS (`ST099`) |
| F1 | posture clean again after every probe rolled back | PASS |
| G1 | **the rewritten CTRL-3 bites**: a reference policy mutated to `using (true)` makes the claimless read return **2 rows** (the sentinel plus the seeded case), so CTRL-3's `n <> 0` fires | PASS |

G1 is the leg that matters most for the rewrite in P2: CTRL-3 no longer has a SQLSTATE to
catch, so the only question worth asking is whether a zero-row assertion can still be made
to fail. It can — and note that it fails by **2**, not by 1, because `20261021140800`
seeds real content behind the sentinel. The control is exercised over content a user
actually reads, not only over a row labelled "reserved".

The probe script lives at
`<scratchpad>/verify-port.sql` and is **ephemeral** — the scratchpad is session-scoped.
The negative controls in it are exactly what `mutations/` is for, so they should be
promoted there rather than copied to `scripts/`; see §7.

Two databases were left in place for inspection and can be dropped freely:
`statesman_port_scratch` and `statesman_port_template`. Neither is referenced by any
script default.

---

## 7. Owed work

### Owed mutations (canon §8.6b: a new security guard ships with a mutation proving its control bites)

Each is proven by execution above but not yet written as a `mutations/*.mut`, which is
outside this task's ownership.

| id | Target | Guard | Proven by |
|---|---|---|---|
| M18 | `20261021140400_lifecycle_functions.sql` | the `and dr.user_id = me` owner predicate on both idempotency lookups | B2 / B3 |
| M19 | `20261021140500` rule 11 | BYPASSRLS allowlist, **both** directions (attribute and membership) | D1 / D2 |
| M20 | `20261021140500` rule 9b | the reference-sentinel requirement and its registry check | C3 / C4 |
| M21 | `20261021140500` rule 1b | `anon` holds nothing | E1 |
| M22 | the test harness (not mine) | the rewritten role guard: `current_user='authenticated'`, `rolbypassrls=false`, zero owned relations, claim present — ADR-0015 requires it to **abort, not warn**, with its own mutation | A6 measures the facts; the guard itself does not exist yet |

### The existing registry needs re-pointing, and 9 of 19 lose their target

- **4 still apply with a path change:** M1, MS2 (`0003` → `20261021140300`), M14–M17
  (`0008` → `20261021140700`) — that is 6, all mechanical.
- **5 need a path change *and* review:** M5, M6, M8, MS1, M9-class rules in
  `0005` → `20261021140500`. M8 in particular will no longer apply as written: its first
  FIND string `if n <> 1 then` now occurs **twice** (rules 9a and 9b) and the mutation
  declares `count: 1`. Its second string, `and not a.attnotnull`, still occurs once.
- **9 lose their target entirely:** M2, M3, M4, M7 (`src/server/db/scoped.ts`) and
  M10, M11, M12, M13, M9 (`src/server/db/privileged-role.ts`). ADR-0015 retires
  `src/server/db/**`; there is no server pool for `withUser`,
  `assertUnprivilegedOnce()`, the eager probe or `DISCARD ALL` to act on. The *properties*
  they protected have not all gone away — the privileged-role predicate becomes posture
  rules 11 and 12 plus the harness guard M22 — so each of the nine needs an explicit
  decision: re-point at the new control, or retire with a reason. **Not silently delete.**

### THE INVENTORY ABOVE MISSED THE NEGATIVE CONTROLS. Three of them are broken. MEASURED.

The count of "19" and the three buckets above were taken over `mutations/*.mut` and never
looked in `mutations/negative-controls/`. Enumerated by `grep -h '^file:' mutations/`
on 2026-10-22, **every** declared target across all 28 files:

| Target | Mutations | State |
|---|---|---|
| `supabase/migrations/20261021140500_verify_security_posture.sql` | 8 | exists |
| `supabase/migrations/20261021140700_scenario_content.sql` | 4 | exists |
| `supabase/migrations/20261021140400_lifecycle_functions.sql` | 2 | exists |
| `supabase/migrations/20261021140300_decision.sql` | 2 | exists |
| `tests/support/scoped-pg/privileged-role.ts` | 5 | exists |
| `tests/support/scoped-pg/scoped.ts` | 4 | exists |
| `tests/integration/support/db.ts` | 2 | exists |
| `src/server/db/scoped.ts` | 2 | **GONE** — MS7, MS9 |
| `migrations/0005_verify_security_posture.sql` | 1 | **GONE** — MS8 |

- **MS7 and MS9** (`negative-controls/`, both `expect: caught`) point at
  `src/server/db/scoped.ts`, deleted by the port itself. They were already broken before
  the pre-port set was removed; the port's own inventory re-pointed the four `M*` mutations
  that named that file and did not notice its two negative controls naming it too.
- **MS8** points at `migrations/0005_verify_security_posture.sql` and so was broken by the
  deletion recorded in §2. Its purpose is to prove the gate reports **MISATTRIBUTED** for a
  mutation that genuinely goes red while naming a catcher that will not fail — a control
  over the gate's own reasoning, which a missing-file error does not exercise. Its header
  states the edit is MS1's, so the correction is determined rather than invented, and both
  halves of it are measured:

  ```
  file:  migrations/0005_verify_security_posture.sql
    ->   supabase/migrations/20261021140500_verify_security_posture.sql
  FIND:  …has_function_privilege('public',   p.oid, 'EXECUTE')   occurs 0 times in the ported file
    ->   …has_function_privilege(g.grantee, p.oid, 'EXECUTE')   occurs 1 time  (= MS1's ported anchor, count: 1)
  ```

  So it is **not** a path swap: rule 4 now iterates grantees because the port widened it to
  PUBLIC **and** `anon` (§4), and the hardcoded `'public'` literal MS8 anchored on is gone.
  **Left unfixed deliberately**: `mutations/**` is another task's ownership, and silently
  re-anchoring someone else's negative control is how a gate ends up green while proving
  nothing. The fix is two lines and is written out above.

A broken negative control does not weaken a mutation — it weakens the **gate**, which is
the instrument every other row here is read through. These three should be settled before
the next `mutation-check.sh` result is believed.

### Other follow-ups

- ~~Read `pg_default_acl` on the live project and settle finding P4 before the first push.~~ **DONE 2026-10-22**, by execution. P4 is CONFIRMED, not merely assumed; see P4 for the three rows read back and for the two consequences they carry.
- Confirm the `auth.users` sentinel insert against the live project (P5). It fails loudly
  if wrong, so this is a scheduling question, not a safety one.
- The client-side ST020/ST021 mapping (P11).
- `src/app/api/health/route.ts` imports `pg` and cannot survive `output: 'export'`; and
  `src/server/db/**` (1,347 verified lines) has no production role. Both are outside this
  task and untouched by it.
- `docs/superpowers/specs/2026-10-20-statesman-os-p0-mvp-design.md` §4.6b's claim that a
  definer function is scoped "by the same policy that scopes the app role" is now FALSE on
  Supabase (P1). It is one of the canon sections ADR-0015 does *not* list as superseded, so
  either the supersession table or §4.6b needs amending.
- `scripts/gates.sh` still enforces the pre-port architecture and was not touched.
- **`content/README.md` carries two stale procedures that are not path references and were
  therefore left alone**, found while re-pointing its migration paths:
  1. Step 5's instruction to "keep every assertion inside the bracket because an owner read
     under FORCE raises `28000`". Post-port there is no `28000` and the owner is `postgres`,
     which is BYPASSRLS — so the stated *reason* for the bracket is gone even though the
     bracket itself is still right (V8: an owner write under FORCE is a silent no-op). A
     case-2 author following the reason rather than the rule will draw the wrong conclusion.
  2. The drift-check command, which still connects `-U statesman_app` and sets
     `PGOPTIONS="-c app.current_user_id=…"`. Both are retired: the role does not exist and
     nothing reads that GUC. It also pipes `psql` into `jq`, which P12 is about. It cannot
     work as written and needs re-deriving against `authenticated` +
     `request.jwt.claim.sub`.
- `docs/implementation-plan.md`, `docs/requirements.yaml` and
  `docs/requirements-traceability.md` cite roughly 40 `migrations/NNNN_*.sql` paths and the
  `src/server/db/*` modules. Most of those paths name files that **never existed in this
  numbering** (`0010_decision.sql`, `0004_reference_tables.sql`, …) — that is pre-port plan
  drift, not fallout from the deletion, so re-pointing them one by one would be inventing a
  history. They are flagged in `README.md` as the pre-port plan instead, and want one
  deliberate pass rather than a search-and-replace.

---

## 8. Retiring the pre-port set — verification log, real exit codes

Run on 2026-10-22, after `rm -rf migrations/` and after retiring
`scripts/db-bootstrap.sh`. Each number is the command's own status, captured without a
pipeline (P12).

```
bash scripts/db-bootstrap.sh                                      rc=2   (the intended refusal; 2 with and without arguments)
npm run db:migrate -- __nope_not_a_db                             refused by emulate-supabase.sh's identifier guard
                                                                         (proves `npm run db:migrate -- <db>` forwards the argument)
bash scripts/migrate.sh statesman_absent_x                        rc=3   'database "statesman_absent_x" does not exist'
bash scripts/db-template.sh                                       rc=0   "posture OK", template ready
  emulate-supabase.sh                                             rc=0
  all nine 20261021*.sql                                          rc=0
  app.verify_security_posture()                                   rc=0
npx vitest run --config vitest.unit.config.ts                      rc=0   36/36, 4 files
node_modules/.bin/tsx scripts/check-import-boundaries.ts          rc=0   33 files scanned, 4 rules, no violations
node_modules/.bin/tsx scripts/check-import-boundaries.ts --selftest rc=0 38/38 fixtures produced exactly their expected rule set
```

That `rc=3` is the one capability the retirement removed: `db-bootstrap.sh` was the only
thing in the tree that ran `CREATE DATABASE` for a *dev* database, and `migrate.sh` does not.
The failure is loud rather than silent, so the gap costs a confusing minute rather than a
broken database, and `README.md` now prints `createdb statesman_dev` as its own step. Worth
recording because P12 bit again while measuring it: `bash scripts/migrate.sh … | tail -3`
reported **0** for the run that actually exited 3. The pipeline reads the filter's status.
Capture `$?` on the next line, every time, including when you are only looking.

`db-template.sh` reporting `rc=0` **is** the evidence that nothing functional depended on
the deleted directory: it runs the emulation, the whole ported set and the posture gate, and
its report re-measured 11 public tables, 8 of them forced-RLS with one policy each, all owned
by `postgres`, `anon_reachable_public_tables = 0`, sentinels 9a 1/1/1 and all five 9b rows
registered. `tests/unit/no-unscoped-counts.test.ts`, the V35 source gate, is among the 36.

`npx tsc --noEmit` and `npx eslint .` were also run, and the first reading of both was a
**FAIL that was not ours** — 4 TS2304s and 8 lint errors, all in
`tests/integration/boundary-guards.test.ts`, a file this task did not touch. Its mtime was
six seconds old: another agent was mid-edit, having renamed three `require_user_id` helpers
to their `auth.uid()` forms while four call sites still named the old ones. Re-run once that
settled, both exited **0**. A gate reading taken at one instant of a multi-agent round is a
snapshot of someone else's half-finished edit as much as of your own work; attribute the
failing file before grading the change.

**Not run, and therefore not claimed:** `scripts/mutation-check.sh` (it holds an exclusive
lock, and a previous round lost a gate to two agents running it at once) and
`vitest.integration.config.ts`. The mutation gate's state is unknown, and §7 above now
records three broken negative controls that have to be settled before its next result means
anything.

`scripts/check-import-boundaries.ts` needed **no** change: `DB_DIR_SEGMENTS` was already
`['tests','support','scoped-pg']`, and the two textual fallbacks and all 38 selftest
fixtures are derived from that constant rather than hardcoded, which is what the port's own
header says it did so that re-pointing the constant could not leave a fallback matching a
directory that no longer exists. No rule names `src/server/db`; the only mentions of it in
that file are a header paragraph explaining the move and a MEASURED note recording that
`import('…/src/server/db/Pool')` once resolved on this case-insensitive filesystem. Both are
history, and no rule was widened or weakened to accommodate the move.
