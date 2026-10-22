#!/usr/bin/env bash
# scripts/emulate-supabase.sh — make a LOCAL PostgreSQL database look enough like a
# Supabase project that ONE migration set runs unmodified against both.
#
# ===========================================================================
# THIS IS AN EMULATION. READ WHAT IT DOES AND DOES NOT REPRODUCE.
# ===========================================================================
# ADR-0015 chose Next.js static export on GitHub Pages talking to Supabase from the
# browser. `supabase start` needs Docker, which is absent on this machine, so the port is
# developed against local PostgreSQL 17.11 — the SAME major.minor as project
# onpkspfxfmjkqpomcsse (docs/supabase-target.md §1). There is exactly ONE migration set
# (supabase/migrations/), shaped for Supabase. Two sets would drift and the drift would
# be invisible until deploy, so the LOCAL DATABASE IS BENT TO MATCH SUPABASE, never the
# other way round.
#
# REPRODUCED, deliberately and including the hazards:
#   * Roles `anon`, `authenticated`, `service_role`, `authenticator`, `postgres`, with
#     Supabase's attributes: `postgres` is NOSUPERUSER but BYPASSRLS, `service_role` is
#     NOLOGIN BYPASSRLS, `authenticator` is NOINHERIT and holds the other three by
#     membership. `postgres` also holds the three, so it can SET ROLE to them.
#   * `auth.uid()` returning NULL — NOT raising — when no claim is set. This is the
#     single most consequential semantic in the port (ADR-0015 "Missing identity goes
#     from loud to silent") and the temptation to make the shim raise 28000 like
#     `app.require_user_id()` did must be refused: a shim that raises would make every
#     local denial test pass for a reason the live target does not provide.
#     The body is Supabase's published definition, coalescing the flattened
#     `request.jwt.claim.sub` GUC with the `sub` member of the JSON `request.jwt.claims`
#     GUC, so a harness that sets either one works here and there.
#   * Ownership shape: the database is owned by `postgres` and schema `public` by
#     `pg_database_owner` (docs/supabase-target.md §1), so ownership-based posture rules
#     are exercised against the real arrangement rather than the local one.
#   * **Supabase's stock permissive default privileges** in schema `public`:
#     `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES/SEQUENCES/FUNCTIONS TO postgres,
#     anon, authenticated, service_role`. This is reproduced ON PURPOSE. It means a table
#     created by a migration is, by default, fully readable and writable by `anon` — the
#     public web role. Our migration set must revoke that explicitly, and reproducing the
#     hazard locally is the only way those REVOKEs are ever exercised before deploy.
#     See docs/supabase-port-notes.md, finding P4, for its verification status.
#   * A minimal `auth.users` with the four columns our set actually touches, so the
#     profile foreign key and the sentinel identity are exercised locally.
#
# NOT REPRODUCED. Anything depending on these is UNVERIFIED until it runs against the
# live project, and must be declared so rather than assumed:
#   * Supabase Auth (GoTrue) itself: real sign-up, real JWT issuance and verification,
#     email confirmation, refresh tokens, the rest of `auth.users`' real column set, and
#     every other table in the `auth` schema.
#   * PostgREST: the HTTP layer, its role switching, its schema cache, its error shapes.
#   * Edge Functions, Realtime, Storage, the `extensions`/`graphql`/`realtime`/`storage`
#     schemas, and the pooler.
#   * `supabase_admin`, `supabase_auth_admin`, `supabase_storage_admin` and the platform
#     ownership of the `auth` schema. Here the `auth` schema is owned by `postgres`.
#   * The cluster superuser. On this machine the login role is `rolsuper=t,
#     rolbypassrls=t` with `trust` auth (V1). No such role exists on Supabase, where
#     `postgres` is NOSUPERUSER. `auth.is_emulation()` below exists so that the posture
#     check can admit that local-only superuser to its BYPASSRLS allowlist HERE and
#     never there.
#
# Idempotent: safe to re-run on the same database.
#
# Usage: emulate-supabase.sh <database> [admin_role]
set -euo pipefail

export LC_ALL="${LC_ALL:-en_US.UTF-8}"                      # V27
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"     # Homebrew PG 17.11

DB="${1:?usage: emulate-supabase.sh <database> [admin_role]}"
ADMIN_ROLE="${2:-${TEST_ADMIN_ROLE:-$(id -un)}}"
ADMIN_DB="${EMULATE_ADMIN_DB:-postgres}"

# The database name reaches SQL as an IDENTIFIER, which cannot be parameterised. Validate
# it against a strict pattern and pass it through psql's :"var" identifier quoting; never
# concatenate it into SQL text. psql interpolates variables for -f/stdin only, not -c.
if [[ ! "$DB" =~ ^[a-z][a-z0-9_]{0,50}$ ]]; then
  echo "emulate-supabase: refusing database '$DB' — not a safe identifier" >&2
  exit 2
fi

# SQL arrives on stdin via a heredoc, which is a REDIRECTION, not a pipe. psql is never
# piped into head/tail/grep anywhere in this project: a pipeline reports the FILTER's exit
# status, so a failed statement would read as a success. That bug has already occurred
# twice here.
PSQL=(psql --no-psqlrc -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5432 -U "$ADMIN_ROLE")

echo "==> emulating Supabase roles (cluster-wide, idempotent)"
"${PSQL[@]}" -d "$ADMIN_DB" -f - <<'SQL'
-- Cluster-level, so this runs against the admin database and is guarded for re-runs.
-- ATTRIBUTES MATCH docs/supabase-target.md §1, including the dangerous ones.
do $$
begin
  -- `postgres`: NOT a superuser, but BYPASSRLS. This is "THE SINGLE MOST DANGEROUS FACT"
  -- of the port — the role the CLI and the dashboard SQL editor use by default reads as
  -- restricted (rolsuper=false) while enforcing no policy at all. Reproduced exactly so
  -- that a probe which accidentally connects as it fails here the same way it would fail
  -- silently there.
  if not exists (select 1 from pg_roles where rolname = 'postgres') then
    create role postgres login nosuperuser bypassrls createdb createrole noinherit;
  else
    alter role postgres nosuperuser bypassrls createdb createrole noinherit;
  end if;

  -- `anon`: the role the published GitHub Page's browser client resolves to with the
  -- publishable key. For STATESMAN OS every table is private, so this role must end the
  -- migration run holding nothing.
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit nobypassrls;
  else
    alter role anon nologin noinherit nobypassrls;
  end if;

  -- `authenticated`: the role a signed-in browser session resolves to. EVERY integration
  -- test connects as this, with a JWT claim set, and never as a BYPASSRLS role.
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated login noinherit nobypassrls;
  else
    alter role authenticated login noinherit nobypassrls;
  end if;

  -- `service_role`: BYPASSRLS. Supabase mandates it; the service key must never reach
  -- the browser or the static bundle. The posture check allowlists it by name and states
  -- why, rather than silently tolerating a bypassrls role.
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  else
    alter role service_role nologin noinherit bypassrls;
  end if;

  -- `authenticator`: what PostgREST connects as, then SET ROLEs to one of the three.
  -- NOINHERIT is load-bearing: with INHERIT it would hold anon's and service_role's
  -- privileges simultaneously and at all times.
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit nobypassrls;
  else
    alter role authenticator login noinherit nobypassrls;
  end if;
end $$;

grant anon, authenticated, service_role to authenticator;
-- Supabase grants the three to `postgres` as well, which is what lets a migration
-- `SET ROLE authenticated` to run a control as the unprivileged role. Our migration set
-- uses exactly that to measure its own policies (CTRL-3/CTRL-4).
--
-- WITH ADMIN OPTION, and `authenticator` included. Both details were MEASURED on project
-- onpkspfxfmjkqpomcsse rather than chosen, by reading pg_auth_members:
--
--   member    granted_role     admin_option
--   postgres  anon             t
--   postgres  authenticated    t
--   postgres  authenticator    t
--   postgres  service_role     t
--
-- The emulation previously granted three of the four and granted them WITHOUT admin
-- option, and that gap was not cosmetic: 20261022160000 runs
-- `alter role authenticator set pgrst.db_schemas = …` as `postgres`, which PostgreSQL 17
-- permits only to a role with CREATEROLE *and* ADMIN OPTION on the target. The migration
-- succeeded against the live project and failed here with
--
--   ERROR: permission denied to alter role
--   DETAIL: Only roles with the CREATEROLE attribute and the ADMIN option on role
--           "authenticator" may alter this role.
--
-- A local run that cannot do what the real project allows reports a fault in the migration
-- when the fault is in the emulation. Matching the measured shape is the fix; loosening the
-- migration would have been the bug.
grant anon, authenticated, service_role, authenticator to postgres with admin option;

-- PostgREST exposed schemas.
--
-- 20261022160000 exposes schema `app` so the lifecycle RPCs are reachable over REST, by
-- running `alter role authenticator set pgrst.db_schemas = …`. That migration CANNOT do it
-- here. `pgrst.db_schemas` is a custom GUC placeholder, which PostgreSQL 17 restricts to a
-- superuser, and the emulated `postgres` is deliberately NOSUPERUSER. The live project's
-- `postgres` is also NOSUPERUSER (rolsuper=f, measured) yet the statement SUCCEEDS there,
-- because it holds `supabase_privileged_role` and authenticator preloads `supautils` —
-- both measured, neither reproducible without the extension.
--
-- So this line stands in for that platform privilege, exactly as the BYPASSRLS allowlist
-- of 20261022150000 stands in for platform roles the emulation has no way to create. The
-- migration then takes its no-op branch locally and does the real work on the project.
--
-- WHAT THIS COSTS, SAID PLAINLY: posture rule E1 locally verifies a value THIS SCRIPT set,
-- not one the migration set, so a local run cannot prove the ALTER ROLE statement works.
-- That statement is verified against the live project by execution, and by the HTTP probe
-- in scripts/verify-rest-exposure.sh. Everything around it — parsing the list, deciding
-- membership, appending without overwriting, and rule E1's own verdict — lives in
-- app.pgrst_schema_exposed() and app.pgrst_schema_list_with(), which are pure, callable and
-- covered locally with positive controls. The uncovered surface is one statement, named.
--
-- The rejected alternative was granting the local `postgres` SUPERUSER so the migration
-- could run unmodified. That is the V1/V34 mistake — a privileged role under test making
-- every isolation check pass vacuously — and this project has already made it twice.
alter role authenticator set pgrst.db_schemas = 'public, graphql_public, app';
SQL

echo "==> emulating database and schema ownership"
"${PSQL[@]}" -d "$ADMIN_DB" -v db="$DB" -f - <<'SQL'
-- On Supabase the project database is owned by `postgres`. Locally it is created by the
-- cluster superuser, so hand it over: this is what makes `postgres` a member of
-- `pg_database_owner`, which is in turn what lets the hardening migration REVOKE on
-- schema `public` as `postgres` rather than needing a superuser.
alter database :"db" owner to postgres;
SQL

"${PSQL[@]}" -d "$DB" -v db="$DB" --single-transaction -f - <<'SQL'
-- docs/supabase-target.md §1: `public` is owned by `pg_database_owner`, NOT by
-- `postgres` directly. Ownership-based posture rules therefore have to be rewritten
-- rather than ported, and they are only exercised correctly if the local arrangement
-- matches.
alter schema public owner to pg_database_owner;

grant usage, create on schema public to postgres;
grant usage           on schema public to anon, authenticated, service_role;
grant create          on database :"db" to postgres;

-- ---------------------------------------------------------------------------
-- SUPABASE'S STOCK DEFAULT PRIVILEGES — THE HAZARD, REPRODUCED ON PURPOSE.
-- ---------------------------------------------------------------------------
-- A stock Supabase project ships these. Their effect is that a table created in `public`
-- by `postgres` is immediately SELECT/INSERT/UPDATE/DELETE-able by `anon`, the role the
-- public web client resolves to. Our set must strip that after every create, exactly as
-- V2/V30 made us strip PUBLIC EXECUTE after every function.
--
-- They are reproduced here rather than omitted because an emulation that is SAFER than
-- the target teaches the wrong lesson: the REVOKEs would never be exercised locally and
-- the first time they mattered would be in production. Erring toward the more dangerous
-- target is the only direction that fails safe.
--
-- `FOR ROLE postgres` is required: default privileges attach to the CREATING role, and
-- every migration in supabase/migrations/ runs `set role postgres`.
alter default privileges for role postgres in schema public
  grant all on tables    to postgres, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to postgres, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on functions to postgres, anon, authenticated, service_role;
SQL

echo "==> emulating the auth schema"
"${PSQL[@]}" -d "$DB" --single-transaction -f - <<'SQL'
-- The `auth` schema is the PLATFORM's, not ours. On the target it is owned by
-- `supabase_auth_admin` and `postgres` merely holds privileges on it, which is why a
-- migration can write `references auth.users (id)` but cannot ALTER that table. The
-- emulation keeps the schema and its table owned by the bootstrap role rather than by
-- `postgres`, so the privileges our set actually needs are EXERCISED here instead of
-- being masked by ownership — the first run of this file granted `authorization postgres`
-- and the profile foreign key then failed on the live-shaped path with
-- "permission denied for table users", which is the error a deploy would have produced.
create schema if not exists auth;
grant usage on schema auth to postgres, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- auth.uid() — THE SEAM, and the semantic the whole port turns on.
-- ---------------------------------------------------------------------------
-- Returns NULL when no claim is present. It MUST NOT RAISE. Our retired
-- `app.require_user_id()` raised 28000, and reproducing that here would be the single
-- most damaging thing this file could do: every local denial test would pass on an error
-- the live target never produces, and the suite would be measuring the emulation.
--
-- Body is Supabase's published definition. The coalesce matters: PostgREST sets the
-- flattened `request.jwt.claim.sub` GUC in some configurations and a JSON
-- `request.jwt.claims` GUC in others, and a shim reading only one would work here and
-- fail there (or vice versa).
--
-- STABLE, never IMMUTABLE. docs/supabase-target.md §1 measured the real one at
-- provolatile='s'. An IMMUTABLE identity accessor was proven in Slice 1 to let a
-- prepared statement leak one user's rows to another from the second execution onward,
-- and posture rule 6 asserts the catalog value for exactly that reason.
create or replace function auth.uid() returns uuid
  language sql stable set search_path = pg_catalog as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

create or replace function auth.role() returns text
  language sql stable set search_path = pg_catalog as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  )::text
$$;

create or replace function auth.jwt() returns jsonb
  language sql stable set search_path = pg_catalog as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), ''),
    '{}'
  )::jsonb
$$;

-- ---------------------------------------------------------------------------
-- auth.is_emulation() — the marker that keeps a local-only concession local.
-- ---------------------------------------------------------------------------
-- The posture check's BYPASSRLS rule flags any bypassrls role that can reach a table.
-- On this machine the login role is rolsuper + rolbypassrls with `trust` auth (V1) and
-- would be flagged on every run. It cannot simply be excluded by `rolsuper`, because
-- "ignore superusers" is precisely the V1/V34 mistake that let the privileged-role check
-- pass a privileged role.
--
-- So the allowlist admits the cluster superuser ONLY when this function exists. It is
-- created by this script and by nothing else, so on project onpkspfxfmjkqpomcsse the
-- concession is unreachable and a stray bypassrls role there is reported.
create or replace function auth.is_emulation() returns boolean
  language sql immutable set search_path = pg_catalog as $$ select true $$;

-- ---------------------------------------------------------------------------
-- auth.users — MINIMAL. Four columns, which are exactly the four our migration set
-- touches when it seeds the sentinel identity.
-- ---------------------------------------------------------------------------
-- Keeping it to the columns we use is deliberate: it makes the local insert exercise the
-- same column list as the live one, so a column the real table requires and we do not
-- supply fails LOCALLY too, instead of only on deploy. Everything else GoTrue has
-- (encrypted_password, aud, role, confirmation and recovery tokens, app/user metadata,
-- is_sso_user, is_anonymous, the identities and sessions tables, every trigger and index)
-- is NOT reproduced.
create table if not exists auth.users (
  id         uuid primary key,
  email      text unique,
  created_at timestamptz,
  updated_at timestamptz
);

-- Fixtures need a way to mint an identity, because public.profile carries a real foreign
-- key to auth.users(id) and the real system cannot have a profile without an auth user
-- either. Making that structural rather than a posture rule is the point: a harness that
-- forgets fails immediately, not at the next posture run.
create or replace function auth.emulate_signup(p_id uuid, p_email text default null)
  returns uuid language sql security definer
  set search_path = pg_catalog, auth as $$
  insert into auth.users (id, email, created_at, updated_at)
  values (p_id, coalesce(p_email, p_id::text || '@emulated.invalid'), now(), now())
  on conflict (id) do nothing
  returning p_id
$$;

-- V2/V30 apply to the auth schema too: a newly created function has EXECUTE granted to
-- PUBLIC, and only an explicit REVOKE after creation removes it. ALTER DEFAULT
-- PRIVILEGES REVOKE is a silent no-op.
revoke execute on all functions in schema auth from public;
-- `postgres` is granted these alongside the three client roles, and it is not optional:
-- every lifecycle function in supabase/migrations/20261021140400 is SECURITY DEFINER
-- owned by `postgres` and calls app.require_user_id(), which calls auth.uid(). MEASURED:
-- without this grant, `authenticated` calling app.submit_decision() fails with
-- "permission denied for function uid" from inside the definer body, because the check is
-- made against the FUNCTION OWNER, not the caller. The caller's own grant does not help.
grant  execute on function auth.uid()  to postgres, anon, authenticated, service_role;
grant  execute on function auth.role() to postgres, anon, authenticated, service_role;
grant  execute on function auth.jwt()  to postgres, anon, authenticated, service_role;
-- emulate_signup and is_emulation are granted to `postgres` and to NOBODY else. On the
-- live project minting an identity is GoTrue's job, reached through its admin API with
-- the service key; here it is the privileged migration/fixture role's. Granting it to
-- `authenticated` would hand the browser role the ability to create identities, which is
-- the one thing a static client must never be able to do.
grant execute on function auth.emulate_signup(uuid, text) to postgres;
grant execute on function auth.is_emulation()              to postgres;

-- auth.users is readable by neither anon nor authenticated. On the real project the
-- browser reads its identity from the JWT, never from the table.
revoke all on table auth.users from public, anon, authenticated;

-- What `postgres` is given on auth.users, and nothing more:
--   * REFERENCES, so public.profile can carry a real foreign key to auth.users(id). This
--     is the privilege the ubiquitous Supabase `references auth.users (id)` pattern needs.
--   * SELECT and INSERT, because 20261021140600_sentinels.sql seeds the reserved sentinel
--     identity and then counts it.
-- UPDATE and DELETE are deliberately withheld: nothing in this migration set modifies or
-- removes an identity, and if something later tries, it should fail here rather than
-- discover on the live project that it was editing GoTrue's table.
grant select, insert, references on table auth.users to postgres;

-- ---------------------------------------------------------------------------
-- THE EMULATION'S OWN PAIRED CONTROL, and it RAISES rather than reports.
-- ---------------------------------------------------------------------------
-- The one property every denial test downstream inherits from this file is that
-- auth.uid() is NULL-without-a-claim rather than raising. If that ever stops holding —
-- someone "improves" the shim to fail loudly, or the GUC name changes — every local
-- denial result becomes a measurement of the emulation instead of the policy, and V7's
-- rule (a row count of 0 is never a success signal) would be the only thing left
-- standing. So it is asserted here, at the source, in both directions.
do $$
declare got uuid;
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',    '', true);
  begin
    got := auth.uid();
  exception when others then
    raise exception 'EMULATION BROKEN: auth.uid() raised %s (%) with no claim; the live '
                    'target returns NULL and must not be emulated by an error',
                    sqlerrm, sqlstate using errcode = 'ST099';
  end;
  if got is not null then
    raise exception 'EMULATION BROKEN: auth.uid() returned % with no claim, expected NULL',
      got using errcode = 'ST099';
  end if;

  perform set_config('request.jwt.claim.sub',
                     'aaaaaaaa-0000-0000-0000-000000000001', true);
  if auth.uid() <> 'aaaaaaaa-0000-0000-0000-000000000001'::uuid then
    raise exception 'EMULATION BROKEN: auth.uid() = % with the flattened claim set',
      coalesce(auth.uid()::text, 'NULL') using errcode = 'ST099';
  end if;

  -- The other GUC form, because PostgREST uses one or the other depending on version.
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
                     '{"sub":"aaaaaaaa-0000-0000-0000-000000000002","role":"authenticated"}',
                     true);
  if auth.uid() <> 'aaaaaaaa-0000-0000-0000-000000000002'::uuid then
    raise exception 'EMULATION BROKEN: auth.uid() = % with the JSON claims GUC set',
      coalesce(auth.uid()::text, 'NULL') using errcode = 'ST099';
  end if;

  -- V17: set_config(..., true) issued inside a function carrying a SET clause was
  -- measured to persist after the function returns, so the reset is written out rather
  -- than assumed from the `is_local` argument.
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',    '', true);
end $$;
SQL

echo "==> emulation report (fact|value)"
"${PSQL[@]}" -d "$DB" -A -t -F'|' -f - <<'SQL'
select 'role', r.rolname,
       'super='   || r.rolsuper::text   ||
       ' bypassrls=' || r.rolbypassrls::text ||
       ' login='  || r.rolcanlogin::text
  from pg_roles r
 where r.rolname in ('postgres','anon','authenticated','service_role','authenticator')
 order by r.rolname;
select 'database_owner', current_database(), pg_get_userbyid(d.datdba)
  from pg_database d where d.datname = current_database();
select 'public_schema_owner', 'public', pg_get_userbyid(n.nspowner)
  from pg_namespace n where n.nspname = 'public';
select 'auth_uid_volatility', 'auth.uid', p.provolatile::text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'auth' and p.proname = 'uid';
-- The shim's paired control is asserted above, in SQL that RAISES. This line only
-- records that it was reached, so a silently skipped heredoc is visible in the log.
select 'auth_uid_paired_control', 'NULL-without-claim and both GUC forms', 'asserted';
select 'default_acl', d.defaclobjtype::text, pg_catalog.array_to_string(d.defaclacl, ' ')
  from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
 where n.nspname = 'public'
 order by d.defaclobjtype;
SQL

echo "emulation ready on database: $DB"
