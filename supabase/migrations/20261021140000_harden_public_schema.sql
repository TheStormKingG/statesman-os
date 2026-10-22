-- 20261021140000 Harden schema `public` on a stock Supabase project.
--
-- This is what survives of migrations/0000_bootstrap_roles.sql. Everything else in that
-- file created the three roles of canon §4.1, and ADR-0015 replaced that model wholesale:
-- `anon`, `authenticated`, `service_role` and `postgres` already exist on the target and
-- are created by scripts/emulate-supabase.sh locally. Roles are therefore NOT created
-- here — a migration that tried would fail on the live project, where they are the
-- platform's.
--
-- NOTE ON FILE FORMAT, and it is a porting constraint rather than a preference: there are
-- no psql backslash commands anywhere in supabase/migrations/. The Supabase CLI sends
-- these files to the server as SQL, so a `\set ON_ERROR_STOP on` line would be a syntax
-- error there while working locally. Statement-level abort is supplied by the caller
-- (`psql -v ON_ERROR_STOP=1` in scripts/migrate.sh; the CLI wraps each file in a
-- transaction).
--
-- ===========================================================================
-- WHY A HARDENING MIGRATION EXISTS AT ALL
-- ===========================================================================
-- A stock Supabase project ships permissive default privileges in `public`:
--
--   alter default privileges in schema public
--     grant all on tables to postgres, anon, authenticated, service_role;
--
-- and the same for sequences and functions. The consequence is that a table created by a
-- migration is, the instant it exists, SELECT/INSERT/UPDATE/DELETE-able by `anon` — the
-- role the published GitHub Page's browser client resolves to with the publishable key,
-- which ADR-0015 notes is public by design.
--
-- This is V2/V30 wearing different clothes. V30 established that there is no structural
-- way to remove a default: `ALTER DEFAULT PRIVILEGES ... REVOKE` never records a negative
-- default. The difference is that Supabase's grants are REAL rows in pg_default_acl
-- rather than the built-in PUBLIC EXECUTE default, and REVOKE does delete those rows. So
-- here, unlike V30's case, removing the default actually works — and it is still not
-- trusted on its own:
--
--   1. The default ACL rows are deleted below, so a table created by a LATER migration
--      does not acquire the grants in the first place.
--   2. Every migration that creates a table or a function nevertheless ends with an
--      explicit REVOKE from `anon`, `authenticated` and `service_role` followed by the
--      narrow grants it actually intends — because the platform owns these settings and
--      may restore them, and because a project restored from a backup or re-created from
--      the dashboard starts stock again.
--   3. app.verify_security_posture() rule 1 is the enforcing gate: a table reachable by
--      `anon` at all, or reachable by `authenticated` without forced RLS and a policy,
--      aborts the migration run. Rule 1 is the primary control, not a backstop, for the
--      same reason rule 4 is the primary control for PUBLIC EXECUTE.
--
-- Three controls, because the first two can each be undone by something outside this
-- repository.
--
-- VERIFICATION STATUS: the default privileges above are Supabase's documented bootstrap
-- and are reproduced by scripts/emulate-supabase.sh, so steps 1-3 are exercised locally.
-- They were NOT measured on project onpkspfxfmjkqpomcsse — docs/supabase-target.md §1
-- measured roles, `auth.uid()`, ownership and the V2/V30 behaviour, not pg_default_acl.
-- See docs/supabase-port-notes.md finding P4. The emulation deliberately reproduces the
-- MORE dangerous shape, so if the live project turns out not to carry these defaults our
-- controls are merely redundant, which is the safe direction to be wrong in.
-- ===========================================================================

set role postgres;

-- ---------------------------------------------------------------------------
-- 1. Remove the permissive defaults at their root.
-- ---------------------------------------------------------------------------
-- `FOR ROLE postgres` is required and is not cosmetic: a default privilege attaches to
-- the role that CREATES the object, and every migration in this directory runs
-- `set role postgres`. A REVOKE written without FOR ROLE would target the current role's
-- own defaults and silently leave postgres's in place.
alter default privileges for role postgres in schema public
  revoke all on tables    from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The canon §4.2 / V22 hardening that still applies.
-- ---------------------------------------------------------------------------
-- No role but `postgres` creates objects in `public`. On the target `public` is owned by
-- `pg_database_owner` and `postgres` is the database owner, so it is a member and may
-- revoke here; the emulation reproduces that ownership precisely so this statement is
-- exercised rather than assumed.
revoke create on schema public from public;

-- V22: the app role retains PUBLIC's TEMPORARY privilege, and a temp table SHADOWS an
-- unqualified reference to a real table. Every migration and function in this set pins
-- `search_path`, and this removes the other half. The database name is an identifier and
-- cannot be parameterised, so it goes through format('%I') on current_database() rather
-- than being hardcoded — the one set runs against statesman_port_scratch,
-- statesman_test_template and the live project under three different names.
do $$
begin
  execute format('revoke temporary on database %I from public', current_database());
end $$;

-- ---------------------------------------------------------------------------
-- 3. Strip what is already granted.
-- ---------------------------------------------------------------------------
-- Step 1 governs objects created from now on. Anything that already exists — in a
-- re-applied set, or a project that was stock before this migration ran — keeps the
-- grants it was created with. There is nothing of ours in `public` yet on a first run, so
-- these are no-ops then and load-bearing on every later one.
revoke all on all tables    in schema public from anon, authenticated, service_role;
revoke all on all sequences in schema public from anon, authenticated, service_role;

-- V2/V30: a new function is created with EXECUTE granted to PUBLIC, and the ONLY
-- statement that removes it is an explicit REVOKE after the function exists. Repeated at
-- the end of every migration in this set, per canon §4.2 consequence 1. `anon` and
-- `authenticated` are named as well as PUBLIC, because Supabase's default ACL grants them
-- EXECUTE directly and revoking from PUBLIC does not touch a direct grant.
revoke execute on all functions in schema public from public, anon, authenticated, service_role;
