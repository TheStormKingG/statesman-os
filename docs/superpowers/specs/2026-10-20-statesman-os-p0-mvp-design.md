# STATESMAN OS — P0 MVP Design Specification

**Spec ID:** SOS-DESIGN-001
**Date:** 2026-10-20
**Status:** Approved for implementation planning
**Derived from:** `docs/PRD.md` (SOS-PRD-001 v1.0), `docs/MASTER_PROMPT.md`
**Supersedes:** nothing

> This document is the **canon**. `architecture.md`, `threat-model.md`,
> `requirements-traceability.md`, `adr/*` and `implementation-plan.md` all derive from
> it. Where any of them disagrees with this file, this file wins and the other is a bug.

---

## 1. Scope

### 1.1 In scope (P0)

Four components plus the minimum private-workspace infrastructure:

| Component | FRs | PRD ref |
|---|---|---|
| Decision Desk | FR-01, FR-02, FR-03 | §5.2 |
| Decision Journal | FR-04, FR-05 | §5.2, §6.1 |
| Challenge Review | FR-07, FR-08, FR-09 | §5.3, §9 |
| Development Plan | FR-10, FR-11, FR-12 | §5.4, §7 |
| Private workspace | FR-14, FR-15, FR-16, FR-19 | §5.5, §10 |

Supporting surfaces: Today (§5.1) and Reflection (§5.4). These are **not** standalone
products.

### 1.2 Out of scope

**Deferred (P1+, gated):** FR-06 case search, FR-13 reviewer sharing, FR-17 monthly
review, FR-18 profile preferences, Crisis Room, Virtual Cabinet, Policy Lab, National
Systems Atlas, Public Service Ledger, Strategic Pathway Studio, live news ingestion.

**Prohibited (not merely deferred):** any composite readiness/character/viability score;
voter profiling or segmentation; targeted political messaging; AI-awarded maturity level
3 or 4; fabricated citations, statutes or institutional positions; impersonation of real
officials; simulated outcomes presented as forecasts; public exposure of journal content;
leaderboards, XP, punitive streaks, social feeds.

**Editorial boundary:** Guyana-first is context, not licence to invent Guyanese statutes,
budgets, prices, institutional positions or health data. All seeded scenario content is
labelled fictional and dated.

---

## 2. Stack

| Layer | Choice | Note |
|---|---|---|
| Runtime | Node v25.5.0 | Declared `engines` accept it; see §9.1 |
| Framework | Next.js App Router, React, TypeScript `strict` | Exact versions pinned at install |
| Styling | Tailwind + small accessible component layer | No component library unless it reduces complexity |
| Database | PostgreSQL 17.11 (Homebrew, local) | **No Docker, no Supabase** — see ADR-0001 |
| DB access | `pg` (node-postgres), hand-written SQL migrations | One persistence strategy; no ORM |
| Validation | Zod at every trust boundary | Including model output |
| Auth | Own session-cookie auth, server-side session table | See §6 |
| AI | Provider-agnostic server-side adapter | Anthropic live later; fixtures now |
| Unit/integration | Vitest | Per-worker template-cloned databases |
| E2E | Playwright (chromium cached) + axe | |

Package manager: **npm 11.8.0** (no pnpm/yarn on the machine; bun present but unused).

---

## 3. Verified facts register

Every row was established by executing a command against this machine on 2026-10-20.
These are not assumptions. **Do not re-litigate these from memory.**

| # | Fact | Consequence |
|---|---|---|
| V1 | Login role `stefangravesande` is `rolsuper=t, rolbypassrls=t`; `pg_hba.conf` is `trust` for local/127.0.0.1/::1 | A typo'd username in `DATABASE_URL` connects *successfully* as whatever role it names, with no password error. Role identity must be asserted at runtime in the data path. |
| V2 | A `SECURITY DEFINER` function is created with `EXECUTE` granted to `PUBLIC` by default (`pg_proc.proacl IS NULL`) | Reproduced cross-user deletion as the unprivileged app role. `REVOKE`/`ALTER DEFAULT PRIVILEGES` on **functions** is mandatory; `REVOKE … ON ALL TABLES` does not touch `EXECUTE`. |
| V3 | A role with `rolbypassrls=false` that is a **member** of a BYPASSRLS role passes an `rolbypassrls` check, yet `SET ROLE` to it succeeds | Attribute checks are insufficient. Must test reachability via `pg_has_role(…, 'MEMBER')`. |
| V4 | Table **ownership** bypasses RLS under `ENABLE` (not `FORCE`), independently of `rolsuper`/`rolbypassrls` | Must assert `pg_get_userbyid(relowner) <> current_user`. |
| V5 | A transaction-local GUC reverts to the **empty string**, not NULL, at COMMIT | `''::uuid` raises a cast error. Predicate must use a raising accessor, not a bare `current_setting`. |
| V6 | With no context set, `select … where id='<nonexistent uuid>'` returns **rc=0, zero rows, no error**. The policy raises only when a candidate row actually reaches the qual | Cannot rely on the query plan to enforce context. Must validate eagerly. |
| V7 | A failing RLS `USING` clause affects **zero rows and raises nothing** (reproduced three ways) | A row count of 0 is never a success signal, and never distinguishes denial from absence. |
| V8 | `FORCE ROW LEVEL SECURITY` makes an owner-run `UPDATE … WHERE true` affect zero rows and raise nothing. `SET row_security = off` is refused | Data backfills must bracket `NO FORCE`/`FORCE`. |
| V9 | `FORCE` + policies scoped `TO statesman_app` makes tables unreadable/unwritable by the owner | **Policies must omit the `TO` clause.** |
| V10 | `pg_dump` as non-superuser owner under `FORCE` fails with **rc=1** | The "silently empty backup" hazard does not exist. Dump as bootstrap superuser. |
| V11 | A view over an RLS table executes with the **view owner's** privileges by default (`security_invoker = false`) | Every view over user data needs `WITH (security_invoker = true)`. |
| V12 | `CASE … END::app.decision_state` inside `GENERATED ALWAYS AS … STORED` is rejected: *generation expression is not immutable* (`enum_in` is STABLE). Per-branch enum literals **do** constant-fold | Cast each branch, never the CASE result. |
| V13 | A lowercase custom SQLSTATE (`'st010'`) silently resolves to `42704` (undefined_object) | All custom SQLSTATEs **uppercase**; round-trip tested. |
| V14 | `UNIQUE` treats NULLs as distinct by default, so a partial unique index does not constrain rows where `lens IS NULL` | Use `NULLS NOT DISTINCT`. |
| V15 | `TRUNCATE` bypasses row-level `BEFORE UPDATE/DELETE` triggers | Needs `BEFORE TRUNCATE … FOR EACH STATEMENT` triggers plus `REVOKE TRUNCATE`. |
| V16 | `pg_trigger_depth()` is 2 inside a cascaded delete **and** when the owner types a plain parent `DELETE` | Depth alone cannot distinguish authorised erasure from an ops mistake. |
| V17 | `set_config(…, true)` inside a function carrying a `SET` clause **persists** after the function returns | Erasure flag must be explicitly reset. |
| V18 | An empty table with RLS and an empty table with **no** RLS both return 0 to the app role | "0 rows" cannot prove RLS works. Needs seeded sentinels. |
| V19 | Under RLS with no DELETE policy, a cross-user `DELETE` returns `DELETE 0` with **no error**, byte-identical to deleting a nonexistent id | Denial tests need paired positive controls and after-state reads. |
| V20 | `pg_policies.qual` is **NULL** for INSERT-only policies | A policy-soundness query reading only `qual` flags every INSERT policy and aborts. |
| V21 | `citext` is available (1.6) but **not installed** in any database; `revoke create on schema public from public` blocks creating it there | Use `text` + `unique index on (lower(email))`. No extension. |
| V22 | The app role retains PUBLIC's `TEMPORARY` privilege; a temp table **shadows** an unqualified reference to a real table | `REVOKE TEMPORARY`; schema-qualify everything; pin `search_path`. |
| V23 | An unguarded read-then-write **never blocks**: the follower inserted and committed while the leader's transaction was open; no Lock wait ever appeared | A race test's negative control cannot use lock-wait detection. |
| V24 | A non-privileged observer of `pg_stat_activity` gets one row per pid with `state` and `wait_event_type` **NULL** | "Cannot observe" is otherwise reported as "never blocked". |
| V25 | `z.toJSONSchema()` **drops refinements** | `.check()` rules never reach a constrained decoder; must be enforced server-side after parse. |
| V26 | `brew services list` reports `postgresql@17` as `none` — the running server is not brew-managed and will not survive a reboot | Runbook must say `brew services start postgresql@17`. |
| V27 | Postgres requires `LC_ALL` set on this macOS build or the postmaster aborts: *postmaster became multithreaded during startup* | Runbook and all scripts export `LC_ALL=en_US.UTF-8`. |
| V28 | **`NEW.<col>` is NULL in a `BEFORE UPDATE` trigger when that column is `GENERATED`.** Reproduced: `BEFORE: OLD.state=[draft] NEW.state=[<NULL>]`, while `AFTER` correctly reports `[submitted]` | A `BEFORE UPDATE` trigger comparing `OLD.state → NEW.state` compares against NULL on every transition, so it permits everything or rejects everything. **A transition trigger must never read `NEW.state`.** |
| V29 | An `IMMUTABLE` user-defined SQL function **is** accepted in a `GENERATED ALWAYS AS … STORED` expression, and the same function can derive the prospective state inside the `BEFORE UPDATE` trigger. Reproduced end to end: legal transition permitted, illegal transition raised `ST001` | One definition serves both the column and the guard, so they cannot drift. This supersedes the inline-CASE approach of V12. |
| V30 | **`ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` is a silent no-op.** Tested in the canonical form, issued by the owner role, single schema: `pg_default_acl` stayed empty and a function created afterwards still had `proacl = NULL` with `has_function_privilege('public', oid, 'execute') = true`. The instrument was validated: an explicit `REVOKE` on the same function flipped it to `false` with `proacl = {sp_owner=X/sp_owner}`. By contrast `ALTER DEFAULT PRIVILEGES … GRANT EXECUTE … TO <role>` **does** apply, and the resulting ACL is `{=X/owner, owner=X/owner, role=X/owner}` — the leading `=X` is PUBLIC, carried in from the built-in default. | **This invalidates the "structural half" claim in §4.2.** `ALTER DEFAULT PRIVILEGES` cannot remove the built-in PUBLIC `EXECUTE` default, because `REVOKE` only deletes rows from `pg_default_acl` and never records a negative default. The only working control is an explicit `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA … FROM PUBLIC` **after** the functions exist, repeated at the end of every migration, with `verify_security_posture()` rule 4 as the enforcing gate rather than a backstop. |
| V31 | A `BEFORE UPDATE` trigger whose common-case early `return NEW` sits in front of an invariant check makes that check **unreachable for exactly the case it guards**. Reproduced: a tampering edit to a submitted row took the `prospective = OLD.state` branch and committed. Moving the frozen-draft check above the short-circuit yields `ST003` as intended, with a positive control confirming draft edits on unsubmitted rows still succeed | Invariant checks go **first** in a trigger body. An early return is an optimisation and must never precede a guard. |
| V32 | `decision_revision`'s append-only triggers block `DELETE` and `TRUNCATE` **for the table owner as well**, so fixture teardown cannot use either. Reproduced: the owner's `delete from decision_revision` raised `ST001` | Confirms §8.3's choice of per-worker template-cloned databases dropped at teardown. A fixture that needs to reset in place must `ALTER TABLE … DISABLE TRIGGER USER` and re-enable, bracketed like the `NO FORCE`/`FORCE` rule. |
| V33 | **zod 4's `z.uuid()` rejects this project's identifiers.** It enforces the RFC 9562 version nibble `[1-8]` and variant nibble `[89abAB]`. Executed: `z.uuid()` REJECTS `aaaaaaaa-0000-0000-0000-000000000001` **and** the reserved sentinel `00000000-0000-0000-0000-00000000dead`; `z.guid()` accepts both. Postgres's `uuid` type performs no version check and accepts any 8-4-4-4-12 hex string | The validator was **stricter than the column it guards**, and would have rejected values the database considers legal — in the fixtures as well as the data path. Use `z.guid()` for every identifier. It fails closed, so the symptom is a wall of refusals in code that looks careful. A unit test asserts the real ids parse and that `z.uuid()` would have rejected them, so nobody "tidies" it back. |
| V34 | **`statesman_owner` is privileged without being superuser or `BYPASSRLS`** — it merely owns all 6 public relations, and ownership bypasses RLS (V4). `statesman_migrator` is a MEMBER of it. Measured: `rolsuper=false, rolbypassrls=false` for both | A "is this role privileged" predicate reading only role attributes **passes the migrator**, and with `trust` auth (V1) a one-character typo in `APP_DATABASE_URL` connects as it, from where `SET ROLE statesman_owner` then `ALTER TABLE … NO FORCE` is available. The privilege predicate must also count *owning a relation in public*, plus `rolcreaterole`, `rolcreatedb`, and membership in `pg_read_all_data` / `pg_write_all_data` — each of which was separately shown to slip through. |
| V35 | **In the shared-worker test database, an unscoped `count(*)` measures scheduling order, not behaviour.** `vitest.integration.config.ts` sets `isolate: false`, giving each worker one clone shared by every file it runs. Observed in two independent files: `state-machine.test.ts` failed with 13 and with 20 against an expected 1; `forgery.test.ts` was green in 7 of 9 runs and deterministically red under `--maxWorkers=1`, failing in an `afterAll` **after all 75 assertions had reported passing** | Every count in an integration test is scoped to the rows the file owns. Enforced by `tests/unit/no-unscoped-counts.test.ts`, a source gate with a reasoned opt-out marker, because two authors who could not see each other's work reached for the same construct — which makes it a contract problem rather than a discipline problem. |

---

## 4. Database security model

### 4.1 Roles

Three roles, created once at cluster level by the bootstrap superuser:

```sql
-- bootstrap only, never in the ordered migration sequence
create role statesman_owner  noinherit nologin;          -- owns schema + definer funcs
create role statesman_app     login noinherit password :'app_pw'
                              nobypassrls nosuperuser nocreatedb nocreaterole;
create role statesman_migrator login noinherit password :'mig_pw'
                              nobypassrls nosuperuser;   -- applies migrations as owner
grant statesman_owner to statesman_migrator;
revoke temporary on database statesman from public;       -- V22
revoke create on schema public from public;
alter role statesman_app set search_path = 'public';      -- V22
```

**`statesman_app` owns nothing** (V4) and has **no** `BYPASSRLS` (V1). The application
connects only as `statesman_app`.

### 4.2 Privileges fail closed

```sql
-- Functions are created with EXECUTE granted to PUBLIC (V2).
-- The ONLY statement that removes it is an explicit REVOKE, after the functions exist:
revoke execute on all functions in schema app    from public;
revoke execute on all functions in schema public from public;
-- then GRANT EXECUTE per function, explicitly, one line each.

-- tables: deliberately NO `alter default privileges ... grant`.
-- Each migration grants per table. A forgotten grant yields an INVISIBLE table
-- (fails closed), not an EXPOSED one (fails open).
```

> **There is no structural default here, and an earlier version of this section claimed
> there was.** `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` is a
> silent no-op (V30): `REVOKE` only deletes rows from `pg_default_acl`, it never records a
> negative default, so the built-in PUBLIC `EXECUTE` survives. Worse, `ALTER DEFAULT
> PRIVILEGES … GRANT` *does* work, and the ACL it materialises **carries the PUBLIC grant
> along with it** (`{=X/owner, …}`), so adding a convenience default makes the exposure
> look configured.
>
> Consequences, all mandatory:
> 1. The two `REVOKE … ON ALL FUNCTIONS IN SCHEMA … FROM PUBLIC` statements run at the
>    **end of every migration that creates a function**, not once at bootstrap.
> 2. `verify_security_posture()` rule 4 is the **primary** control for this hazard, not a
>    backstop, because nothing prevents the next function from being PUBLIC-executable.
> 3. The posture check must therefore run at the end of every migration run in every
>    environment, which §4.8 already requires. That requirement is now load-bearing.

### 4.3 RLS

Enabled **and forced** on every user-owned table. Policies carry **tenancy only** and
**omit the `TO` clause** (V9):

```sql
create or replace function app.require_user_id() returns uuid
  language plpgsql stable                                   -- STABLE, never IMMUTABLE
  set search_path = pg_catalog
as $$
declare v text := current_setting('app.current_user_id', true);
begin
  if v is null or v = '' then                               -- V5
    raise exception 'no user context' using errcode = '28000';
  end if;
  return v::uuid;
end $$;

alter table public.decision enable row level security;
alter table public.decision force row level security;
create policy decision_tenancy on public.decision
  using (user_id = app.require_user_id())
  with check (user_id = app.require_user_id());
```

`app.current_user_id()` exists as a thin non-raising alias and is **the only** Supabase
port seam (`auth.uid()`). It is not used in policies.

**`app.require_user_id()` must remain `STABLE`.** An `IMMUTABLE` variant was proven to
let a prepared statement leak one user's rows to another from the second execution
onward. A catalog assertion (`provolatile = 's'`) is the primary gate, because it cannot
be scheduled away.

### 4.4 State, immutability and row counts

RLS never encodes transitions (V7, and it makes 404 indistinguishable from 409). Instead:

- **One derivation function, used twice.** `app.derive_decision_state(submitted_at,
  challenged_at, reflected_at, action_recorded_at, closed_at)` is `IMMUTABLE`, uses
  **per-branch** enum casts (V12), and is the sole definition of what the state is:

  ```sql
  create function app.derive_decision_state(
    p_submitted timestamptz, p_challenged timestamptz, p_reflected timestamptz,
    p_action timestamptz, p_closed timestamptz
  ) returns app.decision_state language sql immutable as $$
    select case
      when p_closed     is not null then 'reviewed_closed'::app.decision_state
      when p_action     is not null then 'action_recorded'::app.decision_state
      when p_reflected  is not null then 'reflected'::app.decision_state
      when p_challenged is not null then 'challenged'::app.decision_state
      when p_submitted  is not null then 'submitted'::app.decision_state
      else 'draft'::app.decision_state end
  $$;
  ```

- **State** is a `GENERATED ALWAYS AS (app.derive_decision_state(…)) STORED` column (V29).
- **Transitions** are validated in a `BEFORE UPDATE` trigger that derives the
  **prospective** state by calling the same function on `NEW`'s timestamps, and compares
  `OLD.state → prospective` against a whitelist, raising uppercase custom SQLSTATEs (V13)
  that the API maps to distinct HTTP statuses.

  > **The trigger must never read `NEW.state`.** It is NULL in `BEFORE UPDATE` on a
  > generated column (V28), so a trigger that reads it compares against NULL on every
  > transition and therefore permits everything or rejects everything. This is not a
  > style preference; a trigger written the obvious way is inert.

  Required control: a meta-test over **all 32 combinations** of the five milestone
  timestamps asserting that the function's result and the stored column agree, so the
  column and the guard cannot diverge.

  > **Invariant checks go first in the trigger body.** The guard also enforces that a
  > submitted decision's `draft_payload` is frozen. An earlier version put the common-case
  > `if prospective = OLD.state then return NEW; end if;` short-circuit *above* that check,
  > which made it unreachable for precisely the case it guards: a tampering edit to a
  > submitted row moves no milestone, so it took the early return and committed (V31,
  > reproduced). The frozen check now precedes the short-circuit, uses `is distinct from`
  > rather than `<>` so a NULL payload is handled, and carries a positive control asserting
  > that draft edits on unsubmitted rows still succeed.
  >
  > Generalised: an early return is an optimisation. An optimisation placed in front of a
  > guard deletes the guard for the fast path, and the fast path is usually the attack.
- **Immutability** of a submitted revision is enforced by `BEFORE UPDATE OR DELETE`
  triggers **and** `BEFORE TRUNCATE … FOR EACH STATEMENT` (V15) **and** absent grants.
- **Every privileged write asserts its row count:**

```sql
get diagnostics n = row_count;
if n <> 1 then raise exception 'transition did not apply'
  using errcode = 'ST005'; end if;                          -- V7: silence is not success
```

- **Backfills** bracket `alter table … no force` / `… force` in the same migration file
  (V8); a migration lint rejects an unmatched `no force`.

### 4.5 Ownership enforced relationally

Child tables carry `user_id NOT NULL` and a **composite** foreign key, so ownership is a
schema constraint rather than a convention:

```sql
alter table public.challenge_run add constraint challenge_run_owner_scope
  unique (id, user_id);
alter table public.challenge add constraint challenge_run_fk
  foreign key (challenge_run_id, user_id)
  references public.challenge_run (id, user_id) on delete cascade;
```

### 4.6 The pre-identity path

Sign-up and sign-in happen **before** any user context exists, so they cannot pass RLS.
They go through `SECURITY DEFINER` functions owned by `statesman_owner`, each with
`set search_path = pg_catalog, public`, each explicitly granted to `statesman_app` only:

```
app.create_user(p_email text, p_password_hash text, p_algo_ver smallint) returns uuid
app.find_credentials(p_email text) returns table(user_id uuid, password_hash text, algo_ver smallint)
app.create_session(p_user_id uuid, p_token_hash bytea, p_absolute_expires_at timestamptz) returns void
app.resolve_session(p_token_hash bytea) returns uuid
app.revoke_session(p_token_hash bytea) returns void
app.touch_session(p_token_hash bytea) returns void
app.record_attempt(p_identifier text, p_outcome text) returns void
app.erase_self() returns void            -- derives identity internally, NEVER takes a uuid (V2)
app.get_profile() returns table(...)
```

`app_user`, `user_session` and `auth_attempt` receive **no direct grants** to
`statesman_app`. Grant-absence is strictly stronger than RLS, and it removes the
`FORCE` + INSERT contradiction that would otherwise make user creation impossible.

### 4.6b The lifecycle path

`statesman_app` holds `GRANT UPDATE (draft_payload)` on `decision` and nothing more, so it
**cannot write a milestone timestamp at all**. Verified: a direct
`update decision set submitted_at = now()` as the app role raises `42501 permission
denied`. That is the intended design, and an earlier version of this spec left no legal
writer for those columns, which would have blocked the whole lifecycle.

Every transition therefore goes through a `SECURITY DEFINER` function owned by
`statesman_owner`, each with `set search_path = pg_catalog, app, public`, each granted
`EXECUTE` to `statesman_app` only:

```
app.submit_decision(p_decision_id, p_token, p_content, p_confidence, p_rationale)
    returns table (revision_id uuid, revision_no integer, replayed boolean)
app.append_revision(p_decision_id, p_token, p_content, p_confidence, p_rationale)
app.mark_challenged(p_decision_id)
app.record_reflection(p_decision_id, p_notes)
app.record_action(p_decision_id, …)
app.close_decision(p_decision_id)
app.save_draft(p_decision_id, p_payload)   -- NOT a definer function; direct UPDATE on the
                                           -- granted column, which keeps the hot path cheap
```

`app.submit_decision` is the pattern for all of them, and all four of its properties are
verified:

1. **Identity is derived, never passed.** `me := app.require_user_id()`. No function takes a
   user id as a parameter (V2's exploit class).
2. **The row lock is the arbitration.** `select … where id = … and user_id = me and
   submitted_at is null for update` before any write. Two concurrent submits serialise on
   the lock rather than racing.
3. **Idempotency precedes the lock.** A replay of the same `idempotency_token` returns the
   existing revision with `replayed = true` instead of raising. Verified: a second call
   returned `rev=1 replayed=true` and the revision count stayed at 1.
4. **The row count is asserted.** `get diagnostics n = row_count; if n <> 1 then raise …
   using errcode = 'ST005'`, because a failing policy affects zero rows and raises nothing
   (V7).

Because policies omit the `TO` clause and the GUC is transaction-local rather than
role-scoped, `app.require_user_id()` inside a definer function still resolves to the
*caller's* identity even though the function executes as the owner. So a definer function
is scoped to the caller's own rows by the same policy that scopes the app role. Verified:
user B calling `app.submit_decision` against user A's decision raised `ST010`, not a
successful hijack.

### 4.7 Views

Every view over user data is created `WITH (security_invoker = true)` (V11). A
`verify_security_posture()` function scans `pg_class` for `relkind='v'` and raises unless
the option is set, so a new view fails the build.

### 4.8 The posture check

A single SQL function, called at the end of **every** migration run in **every**
environment — not only in test setup — and as the first integration test:

```
verify_security_posture() raises unless ALL hold:
  1. REACHABILITY   every public table on which statesman_app holds any of
                    SELECT/INSERT/UPDATE/DELETE (has_table_privilege) has
                    relrowsecurity AND relforcerowsecurity AND >= 1 pg_policy row
  2. ENUMERATION    every public table is either in a version-controlled allowlist of
                    global reference tables or is RLS-enabled-and-forced
                    (so a new table fails by default)
  3. OWNERSHIP      pg_get_userbyid(relowner) <> 'statesman_app' for all public tables
  4. NO PUBLIC EXEC no function in public/app has EXECUTE for PUBLIC
  5. VIEWS          every relkind='v' over a protected table has security_invoker=true
  6. VOLATILITY     app.require_user_id() has provolatile='s'
  7. NO TRUNCATE    statesman_app lacks TRUNCATE on every immutable table
  8. POLICY SHAPE   no policy has qual='true' or with_check='true'; read BOTH columns (V20)
  9. SENTINELS      exactly one sentinel row per protected table
 10. NOT NULL       every user_id column is attnotnull
```

Rules 1 and 2 are deliberately **column-name independent**: an `attname='user_id'`
selector was proven to exclude `app_user` (whose column is `id`) and every indirectly
scoped table.

---

## 5. Data model

Reference tables (readable by any authenticated user, written only by migration/seed):
`scenario`, `scenario_version`, `source`, `scenario_claim`, `rubric_version`,
`schema_migrations`.

User-owned tables (RLS enabled + forced, composite-FK scoped):
`decision`, `decision_revision`, `challenge_run`, `challenge`, `challenge_source_claim`,
`challenge_response`, `dimension_assessment`, `assessment_observation`,
`assessment_observation_source_claim`, `reflection`, `development_action`, `audit_event`.

Grant-protected tables (no app grants; definer functions only):
`app_user`, `user_session`, `auth_attempt`.

### 5.1 Notable columns and constraints

**`scenario_version`** — `content jsonb`, `is_fiction boolean not null`,
`as_of_date date not null`, `unique (id)`, `unique (scenario_id, version_no)`.
Immutable once `published_at` is set.

**`scenario_claim`** — `primary key (scenario_version_id, claim_id)`, FK to `source`.
**This table is the grounding whitelist.** A model citation naming a `(claim_id)` absent
from it is rejected server-side.

**`decision`** — `unique (id, user_id)`; `draft_payload jsonb`; milestone timestamps
`submitted_at`, `challenged_at`, `reflected_at`, `action_recorded_at`, `closed_at`;
`state` generated from them. `grant update (draft_payload)` **only** — `draft_updated_at`
is set by a trigger, so a payload-only update cannot evade the frozen-draft check.
Partial unique index enforcing one open draft per user per scenario version.

**`decision_revision`** — append-only. `revision_no`, `content jsonb`,
`confidence smallint check (confidence between 0 and 100)`, `forecast text not null`,
`horizon`, `rationale text not null`, `scenario_version_id` (pinned, composite FK),
`idempotency_token uuid unique`. `unique (decision_id, revision_no)`,
`unique (id, user_id)`. No UPDATE/DELETE/TRUNCATE grant; triggers on all three.

**`challenge_run`** — `kind check (kind in ('challenge','assessment'))`, `lens`,
`status check (status in ('pending','succeeded','abstained','failed'))`,
`prompt_version`, `rubric_version_id`, `model_id`, `provider`, `provenance`,
`generated_at`, `idempotency_key`, `calls int`, `cost_usd_micros bigint`, `failure_code`.

```sql
create unique index challenge_run_one_live on public.challenge_run
  (decision_revision_id, kind, lens) nulls not distinct      -- V14
  where status in ('pending','succeeded','abstained');
alter table public.challenge_run add constraint provenance_matches_provider
  check ((provider = 'fixture') = (provenance = 'fixture'));
```

The idempotency key is partial over the same live-status set, so a **failed** run can be
retried instead of permanently returning the failure.

**`challenge`** — `lens`, `question`, `target_passage_or_assumption`,
`basis_type check (basis_type in ('fact','inference','hypothetical','value_judgment'))`,
`uncertainty check (uncertainty in ('low','medium','high','insufficient_evidence'))`,
`risk_pathway`, `limitations`.

**`challenge_response`** — `disposition check (disposition in ('accepted','disputed','flagged_incorrect'))`,
`body text`. FR-09: the user's disagreement is preserved and `flagged_incorrect` is
surfaced as its own state, excluded from "addressed".

**`dimension_assessment`** — `dimension`, `observed_level smallint check (observed_level between 0 and 4)`,
`assessor_kind check (assessor_kind in ('ai','human_reviewer'))`,
`evidence_quality check (… in ('high','medium','low','insufficient'))`,
`provisional_comment`.

```sql
constraint ai_never_awards_practice_levels
  check (assessor_kind <> 'ai' or observed_level <= 2)
```

The full 0–4 domain stays in the database; the **AI** is constrained, not the product.
A trigger additionally forbids any AI-path update of a `human_reviewer` row.

**`development_action`** — `description`, `owner`, `due_date`, `status`,
`completion_evidence`, `completed_at`, `origin_challenge_id`,
`origin_dimension_assessment_id`, `reassessment_decision_id`. FR-11 requires the link to
originating feedback; FR-12 requires both attempts to remain visible.

**`audit_event`** — `user_id` (the subject) **and** `actor_user_id` (nullable, the actor).
Two are not the same, and a deletion writes `actor_user_id IS NULL`:

```sql
create policy audit_select on public.audit_event
  for select using (user_id = app.require_user_id());
create policy audit_insert on public.audit_event
  for insert with check (true);          -- NULL actor must be insertable
-- no UPDATE or DELETE policy; immutability + no-truncate triggers
```

**`app_user`** — `email text not null` + `unique index on (lower(email))` (V21),
`password_hash`, `algo_ver smallint`, `privilege_epoch integer not null default 1`.

**`user_session`** — stores a **hash** of the token, never the token
(`token_hash bytea not null unique`), plus `absolute_expires_at`, `idle_expires_at`,
`last_seen_at`, `revoked_at`, `privilege_epoch_at_issue`.

### 5.2 Deletion

`on delete restrict` from `app_user`, **not** cascade — a cascade silently destroys the
audit history NFR-03 and FR-16 require. Deletion runs through `app.erase_self()`, which
enumerates owner columns from a single shared classification, writes the
`account_deleted` audit row with `actor_user_id IS NULL`, resets its erasure flag
explicitly (V17), and guards on `pg_trigger_depth() > 1 AND current_setting('app.erasure', true) = 'on'`
together (V16).

The privacy notice states the real retention behaviour including backups. **No
immediate-erasure promise.**

---

## 6. Authentication

| Concern | Decision |
|---|---|
| Hashing | argon2id via `@node-rs/argon2`, **parameters recorded in ADR-0002** (not ADR-0005, which is the privilege decision). Pinned starting values: `memoryCost = 19456` KiB, `timeCost = 2`, `parallelism = 1`, 16-byte salt, 32-byte output — the RFC 9106 / OWASP low-memory baseline. These are a **decision, not a measurement**: the option *names* and defaults must be read back from the installed `@node-rs/argon2` release before use (open item O4), and a unit test must assert the hashing call uses exactly these values so later drift fails the build. The `algo_ver` column allows rehash-on-login. |
| Pepper | **Cut for MVP.** It would live in the same env as `DATABASE_URL`, so it does not survive the compromise it exists for. Recorded as a decision, not an oversight. |
| Token | 32 bytes from `crypto.randomBytes`, base64url. **Only its SHA-256 hash is stored.** |
| Cookie | `HttpOnly`, `SameSite=Lax`, `Secure` in production, `Path=/`, explicit `Max-Age`. `__Host-` prefix in production only (it requires `Secure`, which local http cannot satisfy). |
| Timeouts | Absolute 30 days; idle 7 days. Idle is slid **conditionally** (`last_seen_at < now() - interval '15 minutes'`), fire-and-forget, and `resolve_session` is a **pure read** — otherwise Next.js prefetches renew the window with no user activity and the idle control is hollow while its test still passes. |
| Sign-out | Revokes the session **row**, then clears the cookie with full matching attributes. Tested by replaying the captured cookie — asserting the cookie is gone proves nothing about the server. |
| Privilege epoch | `AFTER UPDATE` trigger with **no column list**, comparing `to_jsonb(NEW) - 'privilege_epoch' - 'last_seen_at'` against the same projection of OLD, which **deletes** the user's sessions. Deleted rows cannot be resurrected. A `BEFORE UPDATE` guard raises on a decreasing epoch. A hardcoded column allowlist was proven to miss a newly added privilege column. |
| Rate limiting | Per-identifier progressive delay, with the DB client **released before sleeping**. The instance-wide circuit breaker is **cut**: on a single-user app it is account lockout with a worse blast radius and a one-line attacker trigger. The aggregate threshold raises an alert, never a block. |
| Lockout | None, for the same reason. |

### 6.1 The guard must fail closed

```ts
// the ONLY exported data entry points; the Pool is module-private
export async function withUser<T>(fn: (db: UserScopedClient) => Promise<T>): Promise<T>
export async function withMigrator<T>(userId: string, fn: (db: Client) => Promise<T>): Promise<T>
```

`withUser` takes **no session parameter**. It calls `requireSession()` itself. A design in
which the identity arrives as an argument type-checks perfectly when handed a victim's
id, and RLS then faithfully enforces the attacker's chosen identity — a hole straight
through every layer at once. Removing the parameter removes the channel.

`AuthenticatedSession` and `UserScopedClient` are branded with a `unique symbol`
producible only inside `requireSession`/`withUser`. Because a brand is erasable with one
assertion, `as AuthenticatedSession` and `as UserScopedClient` are additionally banned by
an AST check in CI.

`withUser` body, in order:
1. `await assertUnprivilegedOnce()` — a cached promise, so **every** path validates the
   connection's role once per process, independent of framework lifecycle hooks (V1, V3).
2. `BEGIN`
3. `select set_config('app.current_user_id', $1, true)`
4. `select app.require_user_id()` — **eager validation** (V6). One extra round trip makes
   context failure loud regardless of query shape.
5. the caller's work
6. `COMMIT` / `ROLLBACK`
7. `finally`: `DISCARD ALL`, then release. This makes a mistaken `is_local=false` inert
   rather than merely tested-for.

`set local statement_timeout` is set via `set_config($1,$2,true)` with a Zod-validated
number — **zero interpolated values** in transaction setup.

Boundary enforcement: the `pg` package may be imported only within `src/server/db/**`,
checked by an AST script over the TypeScript API that sees static imports, `require` and
dynamic `import()`. `no-restricted-imports` matches the *specifier string*, not the
resolved path, and a grep for `new Pool(` is evaded by an alias — neither is sufficient
alone.

---

## 7. AI challenge architecture

### 7.1 Mode is explicit

```ts
STATESMAN_AI_MODE: 'live' | 'fixture' | 'unavailable'   // default 'unavailable'
```

**Never** keyed on the absence of `ANTHROPIC_API_KEY`. The master prompt permits fixtures
in test/demo mode only; an implicit trigger would ship canned feedback as the production
default. The fixture adapter module **throws on import** when `NODE_ENV === 'production'`.
A missing key in `live` mode renders the NFR-08 unavailable/retry state — it does not
silently fall back.

Provenance is derived from the provider by one mapping function and tied by a database
`CHECK` (§5.1), and the UI labels every fixture-backed response as such.

### 7.2 Contract

Request: approved `scenario_version` facts, the `scenario_claim` registry, the user's
`decision_revision`, the `rubric_version`, one of five lenses, `prompt_version`,
`model_id`. Response per §9.2 of the PRD, validated by Zod server-side.

All model-facing strings come from **one `freeText(min,max)` factory** applying URI and
control-character rejection. A meta-test walks both schemas' type trees and fails any
`ZodString` leaf not produced by the factory — so a newly added field breaks the build
rather than silently opening an exfiltration channel.

**`z.toJSONSchema()` drops refinements (V25)**, so `.check()` rules never reach a
constrained decoder. Every refinement is therefore re-enforced server-side after parse,
and violations are counted.

`extractJson` free-text JSON recovery is **deleted**. On a parse failure: one repair
attempt through the operator channel, then `{code:'schema_invalid'}`. A unit test asserts
no substring/regex JSON recovery exists in the adapter.

### 7.3 Grounding is code, not prompt text

1. Every `evidence_ref` and `source_claim` is checked against `scenario_claim` for the
   pinned `scenario_version_id`. An unknown id is rejected server-side.
2. Relational grounding is enforced by composite FK, not by application checks: the
   citation row references `(scenario_version_id, source_id, claim_id)` **and** the
   owning challenge's `(id, user_id)`. A fabricated citation cannot be persisted.
3. The same chain exists for assessments (`assessment_observation_source_claim`). Without
   it, the grounding gate covers challenges only and the assessment path has none.
4. A challenge whose citations do not all resolve is dropped individually, and the drop
   is recorded with a `failure_code`.

### 7.4 Prompt injection

Scenario text, source excerpts and journal text are untrusted. Structural defences, in
order: role separation (untrusted content never in the system position), explicit
delimiting with generated boundary tokens, schema-constrained output, server-side
post-validation, and the citation whitelist. **No reliance on instructing the model to
ignore instructions.** Worked example and the stopping layer go in `threat-model.md`.

### 7.5 Resilience

Timeouts, a retry cap of 2 with structured backoff, request IDs, and a token/cost budget
**reserved in the same atomic statement that increments the call counter**, rejecting on
the returned total — otherwise the dollar cap is decorative while the call counter is the
only real limit. Per-minute and per-decision allowances are separate, so legitimate
five-lens runs plus repairs are not rejected.

A failing AI call must not delete a draft, mutate a locked revision, or mark review
complete. The model call happens **outside** the write transaction; only the validated
result is written, inside one.

### 7.6 Adversarial evaluation suite

Prompt injection; missing citations; invented legal authority; unapproved source id;
contradictory case facts; sycophantic praise; stereotyping; unjustified certainty; **IDOR
(another user's `decision_revision` and `challenge_run`, including through every view)**;
**pooled-identity leak across two sequential requests on one warmed client**. The last two
were absent from the first draft although the master prompt names them.

Structural cases (schema violation, unapproved source, zero-citation gap, IDOR, identity
leak) are **release blockers** scored automatically. Judgemental cases (sycophancy,
stereotyping) go to the PRD §12.3 reviewer-sample protocol, because a fixture suite scored
against responses we wrote ourselves verifies our validators, not the model.

---

## 8. Test doctrine — no gate without a control

The adversarial pass found 56 gates that would pass while exercising nothing. The
governing rule:

> **A test that cannot be made to fail has not been shown to work.** Every denial
> assertion is paired with a positive control, and every instrument has a test in which
> it must report the negative.

### 8.1 Sentinels

A migration seeds exactly one row per protected table owned by reserved UUID
`00000000-0000-0000-0000-00000000dead`, committed into the template database (V18).
`assertAppRole` then checks **both** directions on non-empty data: with no context, every
protected table returns 0; as the sentinel user, each returns exactly 1. A table shipped
without RLS now leaks its sentinel and the run dies.

### 8.2 Paired denials

```
A sees the row (1)  →  B sees 0  →  B's write raises nothing  →  A still sees 1
```
Plus, inside a rolled-back transaction, **drop the policy** and assert the row becomes
visible. `DELETE 0` is byte-identical to deleting a nonexistent id (V19), so a bare
`rowCount === 0` proves nothing.

### 8.3 Isolation

Per-worker `CREATE DATABASE … TEMPLATE statesman_test_template`, dropped at teardown.
**Not** `TRUNCATE` — the immutability triggers forbid it, by design. Migrations are applied
by lexical glob (`migrations/0*.sql`), never a hand-maintained list, so a new migration
cannot be silently omitted from the test path. Tests connect as `statesman_app`; the
fixture makes a wrong-role connection loudly fatal, and seeding goes through `withUser`
so a missing INSERT policy surfaces instead of being bypassed.

`withUser` contains **no** rollback branch and no `process.env` reference; per-test
transaction isolation is injected by test-only code through an optional provider. A unit
test asserts production code has no env-gated rollback path.

### 8.4 Concurrency

Genuinely concurrent: two clients, explicit `BEGIN`, interleaved statements, and an
overlap probe. Two **instrument** tests are mandatory and harness-fatal:

1. `waitUntilBlocked` must return `false` when two sessions lock **different** rows.
2. The revision-number read helper run sequentially must produce **different** values.

The negative control for the race uses an **application rendezvous plus an `xact_start`
overlap assertion**, not lock-wait detection — an unguarded read-then-write never blocks
(V23). A positive observability assertion distinguishes a NULLed `pg_stat_activity` from
"not yet blocked" (V24).

### 8.5 Accessibility and responsive

A `/__a11y-canary` route, mounted only under `E2E_FAULTS=1`, carries a known serious axe
violation and a 400px fixed block. The axe gate and the 320px overflow detector must
**fail** on it. Focus indication is asserted as a **difference** between focused and
blurred computed styles plus a ≥3:1 contrast ratio — a presence check on `outlineStyle`
can never fail, because UA stylesheets give `:focus-visible` elements `outline-style: auto`
regardless of the author's CSS.

### 8.6 Traceability that stays honest

Two artefacts:

- **`docs/requirements-traceability.md`** — deterministic, committed. Requirement rows,
  priority, PRD ref, acceptance condition, verification method, implementation paths,
  covering test identities. **No timestamps. No per-run outcome.**

  It **may** carry a *design status* from the closed vocabulary `{PLANNED, DEFERRED}`,
  because that is a property of scope, is stable between runs, and is required by master
  prompt §3 item 2. It may **not** carry a *run* status: `PASS`, `FAIL` and `NOT RUN` are
  outcomes of an execution and are not representable in this file at all. The distinction
  is the determinism test — would the value change if the same commit were checked twice
  without editing anything? If yes it belongs in the volatile report.
- **`reports/trace.json` + `reports/traceability-run.md`** — volatile, gitignored.
  Per-requirement outcome per suite, commit sha.

`npm run trace:check` diffs only the deterministic file. Embedding a generation timestamp
in a committed file makes `--check` unpassable by construction.

Coverage is matched by **structural tags** emitted by custom Vitest and Playwright
reporters into `reports/tags-*.json` — never by parsing concatenated test titles, which is
silently empty for every `it.each` test. Requirement ids come from a single
`requirements.yaml`; the count in the document is generated from it.

A requirement is `PASS` only if a tagged test exists, ran, and passed. **Unexecuted is
`NOT RUN`, never `PASSED`.** `gates:selftest` fixtures assert deep equality against an
expected per-requirement object, not an exit code — five fixtures asserting only
`code === 2` let a checker that returns 0/2 pass seven of ten.

### 8.6b Mutation testing is a gate, not an exercise

§8's rule — *a test that cannot be made to fail has not been shown to work* — was a
doctrine nothing enforced. An adversarial pass then mutated the guards one at a time and
found **eight whose removal left the suite green at 44/44**, including `DISCARD ALL`, which
§7.6 names a release blocker, and `decision_revision`'s tenancy `WITH CHECK`, whose
weakening was additionally shown to be exploitable by forging a revision carrying another
user's id.

So the harness is now permanent: `scripts/mutation-check.sh`, wired into `scripts/gates.sh`
and `npm run mutation`. For each registered mutation it mirrors the repo, applies one
change, builds that mirror its own template database, runs the suite, and asserts the suite
goes non-zero **and that the expected test failed**.

Four properties are load-bearing, each from a failure already observed here:

1. **A green baseline first.** A harness that cannot produce a green unmutated suite reports
   every mutation as caught. An earlier script of exactly this kind treated *any* non-zero
   exit as detection and would have reported success on all six of its mutations while
   testing nothing.
2. **Match the expected test, not any failure.** "Something failed" is not evidence the
   right thing failed.
3. **Catcher specificity.** `expect-test` is a substring, and a catcher named `e` was shown
   to make the gate print `GATE PASSED`. Every catcher must now resolve to **exactly one**
   test in the baseline inventory, checked once against the green baseline. Verified by
   re-running that exploit: `SPEC FAIL … matches 75 baseline tests (need exactly 1)`.
4. **`--only` keeps the self-tests.** It previously filtered the whole registry, so
   `--only M5` exited 0 having never run `MS1`/`MS2`, the gate's own positive controls — a
   scoped run reported as a controlled one.

**Standing rule: a new security guard ships with a mutation proving its control bites.**
Current state: 15 mutations registered, 15 caught, verified by an independent agent that
built its own mirror, applier, reporter-parser and template database so it trusted no part
of `mutations/lib`.

### 8.7 CI order

`tsc --strict` → `eslint` (**its own step**; `next build` may not lint) → format →
AST import-boundary check → unit → integration (incl. posture check as test #1) → build →
E2E + axe → dependency audit → secret scan (**before and after** the test gates, so
generated artefacts are covered) → `trace:check`.

No credentials are ever written to a handoff file; workers read connection bases from
their own environment, and `reports/` is gitignored.

Coverage thresholds apply to domain services and security boundaries, with 100% of the
critical invariants in §4.4 tested. No global percentage target.

---

## 9. Open items and declared gaps

| # | Item | Disposition |
|---|---|---|
| O1 | **NFR-02 encryption at rest** has no mechanism. Postgres has no TDE. | FileVault locally; a managed/encrypted volume on any deploy. Declared an **open release item**, not silently met. |
| O2 | React `cache()` outside a render context, used for session resolution in Route Handlers — including the export route that dumps a full journal. | **Settle empirically before relying on it:** put a `randomUUID()` in the uncached implementation and fire two concurrent requests; the ids must differ. If not, resolve per handler explicitly. |
| O3 | Node v25.5.0 is an odd-numbered line. Declared `engines` accept it. | Note, not a blocker. Pin exact versions; verify async `cookies()` and `instrumentation.ts` semantics against the installed release. |
| O4 | Framework/library assertions (Next lint behaviour, flag names, option keys) | Each settled by command against installed tooling before use, never from memory. Recorded in the ADR that cites it. |
| O5 | Postgres is not brew-managed (V26) and needs `LC_ALL` (V27) | Runbook documents `brew services start postgresql@17` and the locale export. |
| O6 | FR-13 reviewer sharing is deferred, and the MVP ships **no** global `role` column | When it arrives: a `record_share` table (resource, grantee, scope, `expires_at`, `revoked_at`) with a policy unioning ownership and an unexpired unrevoked share. A global role cannot express per-item scoped revocable sharing. |

---

## 10. Adjudicated disagreement

Reviewers disagreed on `FORCE ROW LEVEL SECURITY`. One recommended dropping it (it made
tables unreadable by the owner); three recommended keeping it.

**Decision: keep `FORCE`.** The dissent's cause was scoping policies `TO statesman_app`,
not `FORCE` itself (V9). With the `TO` clause omitted, one policy serves both the app role
and the definer functions, and the owner-unreadable problem disappears. `FORCE` is what
protects against the app role ever owning a table and against a definer function reading
across users.

The genuine residual cost is accepted and handled explicitly rather than argued away:
`FORCE` makes owner-run backfills silent no-ops (V8), so every data migration brackets
`NO FORCE`/`FORCE` in the same file and a lint rejects an unmatched `NO FORCE`.

Recorded as ADR-0003.

---

## 11. Cut as over-engineering

`app_editor` role · scenario authoring and publish tables (seed from a migration instead)
· nightly reconciliation cron (CI assertions instead) · password pepper · instance-wide
circuit breaker · global `role` column · `extractJson` · Stryker · the cryptographic
report-integrity chain (clean-tree and headSha enforced only on a release tag) · backup
round-trip row-count verification (V10) · the fabrication-ratio second threshold ·
`withUser`'s unused `readOnly` option · a dead `UUID_RE` guard · a superuser test
connection · the three-column rejection table.

Each was removed because the PRD does not require it, or because the hazard it guarded was
proven not to exist, or because it added a failure surface larger than the one it covered.

---

## 12. Document ownership and numbering

Six deliverables were authored in parallel from this canon by agents that could not see
each other's output, and the consistency audit found exactly the class of collision that
arrangement produces. To prevent recurrence, each shared namespace has **one owner**, and
every other document must match it rather than define its own:

| Namespace | Owner | Rule |
|---|---|---|
| Trust boundary ids `TB-1..TB-9` | `threat-model.md` | Architecture and all other docs adopt its numbering verbatim. The canon does not define a competing set. |
| Threat ids `T-nn`, test-case ids `TC-SEC-nnn` | `threat-model.md` | Must be registered in `requirements.yaml` under a `threats:` key, or no tagged test can ever match them. |
| Requirement ids, invariant ids `INV-nn`, instrument ids `INS-nn` | `requirements.yaml` | `requirements-traceability.md` is a deterministic render of it. Divergence between the two is a `trace:check` failure, including in punctuation and spelling — use the PRD's own US spelling. |
| Migration filenames and source/test file layout | `implementation-plan.md` | It is ordered by migration dependency. `requirements.yaml`'s `implementation_paths` must be rewritten to match it, never the reverse. A path named in the register that no task creates is a defect. |
| ADR numbers | `docs/adr/README.md` | A reference to an ADR that does not yet exist must appear in a committed reserved-numbers list, or the `docs:check` gate cannot pass before the ADR is written. |
| Requirement design status | `requirements.yaml` | Architecture and other documents must not restate a status; they link. |
| Repository state claims | nobody | **No document may assert which other documents exist.** Both the architecture and threat-model agents wrote "`docs/adr/` is empty" minutes after eleven ADRs were created. A document may state that no *application code* exists, because that is durable; it may not inventory its siblings. |

### 12.1 Mechanisms the threat model found undesigned — now required

The threat model correctly marked four controls `UNDESIGNED`. They are in scope for P0 and
belong in Slice 6:

1. **CSRF origin verification** on every state-changing Server Action and Route Handler.
   `SameSite=Lax` alone is not the control. Needs a RED cross-origin E2E test with a
   same-origin positive control, and an ADR recording the mechanism.
2. **Log and telemetry redaction.** A field classification plus a RED test that runs a
   full loop and asserts no journal field value, token or connection string appears in any
   captured log or telemetry payload — with a deliberately-logging fixture as the positive
   control.
3. **Stored-XSS rendering.** All journal text and model output rendered through one
   escaping component, plus a CSP. Note the residual: the `freeText` factory rejects URIs
   and control characters but **not** HTML metacharacters, so escaping at render is
   load-bearing rather than defence in depth.
4. **NFR-10 source integrity.** `source` gains a `status` column (`active | withdrawn |
   unreachable`) and `scenario_version` an archival flag, with a CI assertion that a
   seeded withdrawn source is reported. The PRD requires flagging and archival, not only
   stored dates.

### 12.2 Decisions that must be recorded, not assumed

Master prompt §0.2 requires conflicts with PRD intent to be recorded in `docs/decisions.md`
rather than silently applied. Three qualify:

- **NFR-06** (availability ≥ 99.5% monthly) is deferred because it is measurable only from
  pilot operation and no pre-release instrument exists. The PRD does not defer it, so the
  deferral is ours and must be written down.
- **NFR-07** (core screen load ≤ 3s) — either add a throttled Playwright budget spec with
  its own positive control, or defer it on the same honest basis as NFR-06. It may **not**
  remain marked `P0 / PLANNED` with an implementation path that no task creates.
- **Coverage threshold.** Master prompt §9 asks for ≥85% meaningful coverage of domain
  services alongside 100% of critical invariants. The canon's "no global percentage target"
  does not discharge that, because 85% scoped to domain services is not a global target.
  Either configure a scoped threshold on `src/server/domain/**` or record why the invariant
  rule supersedes it. Both documents may not be silent on it.
- **Dependency audit threshold.** A blocking gate whose threshold is defined nowhere is
  passed at discretion. `CLAUDE.md` must state it explicitly.

### 12.3 Verification legs that cannot be discharged automatically

`FR-16` and `NFR-02` carry a `manual` verification leg. A manual leg needs a named
evidence record (for example `docs/reviews/retention-notice.md`), a rule that the
requirement reaches at most `NOT RUN` until that record exists and is referenced, and a
`docs:check` assertion that every row whose verification includes `manual` names its
record. No sign-off name or date is to be invented.
