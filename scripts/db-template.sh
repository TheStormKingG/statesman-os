#!/usr/bin/env bash
# scripts/db-template.sh — build the integration-test TEMPLATE database, Supabase-shaped.
#
# Drops and recreates $TEST_TEMPLATE_DB, runs scripts/migrate.sh (which runs the emulation
# bootstrap, then the lexical glob over supabase/migrations/*.sql, then
# app.verify_security_posture()), and leaves the database ready to be cloned with
# CREATE DATABASE ... TEMPLATE.
#
# ===========================================================================
# WHAT CHANGED FROM THE PRE-PORT VERSION
# ===========================================================================
#   * The "database-level half of 0000" step is GONE. It re-applied
#     `alter schema public owner to statesman_owner`, `grant create on database`,
#     `revoke create on schema public` and `revoke temporary on database`. Ownership and
#     the grants now come from scripts/emulate-supabase.sh (which hands the database to
#     `postgres` and `public` to `pg_database_owner`, matching
#     docs/supabase-target.md §1), and the two REVOKEs are in
#     supabase/migrations/20261021140000_harden_public_schema.sql, where they belong:
#     they must also run against the live project, which has no bootstrap step.
#   * migrate.sh is now the single entry point for emulation + set + posture, so this
#     script no longer knows the order.
#   * The posture report reads `profile` rather than `app_user` (ADR-0015 retires our own
#     identity tables) and `anon`/`authenticated` rather than `statesman_app`.
#   * A new report section prints the BYPASSRLS allowlist, because rule 11's local
#     concession (the cluster superuser, admitted only when auth.is_emulation() exists)
#     must be VISIBLE in the build log rather than buried in a registry nobody reads.
#
# Rules this script is written to:
#   * LC_ALL is exported or the postmaster aborts (V27).
#   * psql is NEVER piped into head/tail/grep: a pipeline reports the FILTER's exit
#     status, so a failed migration would read as a success. This project has got that
#     wrong twice. SQL arrives on stdin via a heredoc, which is a redirection rather than
#     a pipe, so $? is psql's own status — and every invocation's status is captured on
#     the line immediately after it and acted on.
#   * The database name reaches SQL as an IDENTIFIER, which cannot be parameterised. It is
#     validated against a strict pattern and then passed through psql's :"var" identifier
#     quoting — never concatenated into SQL text. psql interpolates variables for
#     -f/stdin only, NOT for -c.
#   * CREATE/DROP DATABASE cannot run inside a transaction block, so each gets its own
#     psql invocation and no --single-transaction.
set -euo pipefail

export LC_ALL="${LC_ALL:-en_US.UTF-8}"                      # V27
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"     # Homebrew PG 17.11

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="${TEST_TEMPLATE_DB:-statesman_test_template}"
ADMIN_DB="${TEST_ADMIN_DB:-postgres}"

# CREATE DATABASE needs rolcreatedb. The emulation's `postgres` role has it, but it cannot
# create the database it is about to be given ownership of before that database exists, so
# the template build still runs as the bootstrap superuser (the macOS login role, via
# pg_hba `trust`) — the same role V10 designates for pg_dump. It is used for DDL and for
# reporting only. THE TESTS CONNECT AS `authenticated`, which the harness must assert
# before any read: ADR-0015 requires that guard to ABORT, not warn, because a run that
# connects as `postgres` passes while enforcing nothing.
ADMIN_ROLE="${TEST_ADMIN_ROLE:-$(id -un)}"

if [[ ! "$TEMPLATE" =~ ^[a-z][a-z0-9_]{0,50}$ ]]; then
  echo "db-template: refusing TEST_TEMPLATE_DB='$TEMPLATE' — not a safe identifier" >&2
  exit 2
fi

PSQL=(psql --no-psqlrc -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5432 -U "$ADMIN_ROLE")

echo "==> dropping $TEMPLATE if present"
"${PSQL[@]}" -d "$ADMIN_DB" -v tpl="$TEMPLATE" -f - <<'SQL'
drop database if exists :"tpl" with (force);
SQL
rc=$?
if [[ $rc -ne 0 ]]; then echo "db-template: drop failed (exit $rc)" >&2; exit $rc; fi

echo "==> creating $TEMPLATE"
"${PSQL[@]}" -d "$ADMIN_DB" -v tpl="$TEMPLATE" -f - <<'SQL'
create database :"tpl";
SQL
rc=$?
if [[ $rc -ne 0 ]]; then echo "db-template: create failed (exit $rc)" >&2; exit $rc; fi

# Emulation bootstrap + supabase/migrations/*.sql + app.verify_security_posture().
echo "==> migrate.sh $TEMPLATE"
bash "$ROOT/scripts/migrate.sh" "$TEMPLATE"
rc=$?
if [[ $rc -ne 0 ]]; then
  echo "db-template: migrate.sh failed (exit $rc) — template is NOT usable" >&2
  exit $rc
fi

# ---------------------------------------------------------------------------
# Report the template's MEASURED posture. Reads, not assumptions: a template that built
# "successfully" with FORCE left off, or with a sentinel missing, makes every tenancy test
# downstream vacuous (V18) — and post-port there is no 28000 to announce it, so the report
# is the only place a human sees it.
# ---------------------------------------------------------------------------
echo "==> template posture (kind|name|rls_enabled|rls_forced|policies|owner)"
"${PSQL[@]}" -d "$TEMPLATE" -A -t -F'|' -f - <<'SQL'
select 'rls', c.relname, c.relrowsecurity::text, c.relforcerowsecurity::text,
       (select count(*) from pg_policy where polrelid = c.oid)::text,
       pg_get_userbyid(c.relowner)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r','p')
 order by c.relname;
SQL
rc=$?
if [[ $rc -ne 0 ]]; then echo "db-template: posture report failed (exit $rc)" >&2; exit $rc; fi

echo "==> template sentinels and client-role privileges"
"${PSQL[@]}" -d "$TEMPLATE" -A -t -F'|' -f - <<'SQL'
-- The sentinels, by the two mechanisms posture rule 9 uses. These are read as the
-- bootstrap superuser, which is BYPASSRLS, so they report EXISTENCE and not visibility —
-- visibility through the policy is what the paired control inside
-- 20261021140600_sentinels.sql measures, as `authenticated`.
select 'sentinel_9a', 'profile', count(*)::text from public.profile
          where user_id = '00000000-0000-0000-0000-00000000dead'
union all
select 'sentinel_9a', 'decision', count(*)::text from public.decision
          where user_id = '00000000-0000-0000-0000-00000000dead'
union all
select 'sentinel_9a', 'decision_revision', count(*)::text from public.decision_revision
          where user_id = '00000000-0000-0000-0000-00000000dead'
union all
select 'sentinel_9b', s.table_name, s.sentinel_id
  from public.posture_sentinel_row s
union all
-- anon must hold NOTHING. If this is ever greater than 0, posture rule 1b has already
-- failed the build; it is reported anyway so the number is visible rather than inferred.
select 'privilege', 'anon_reachable_public_tables',
       (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('r','p')
           and (has_table_privilege('anon', c.oid, 'SELECT')
             or has_table_privilege('anon', c.oid, 'INSERT')
             or has_table_privilege('anon', c.oid, 'UPDATE')
             or has_table_privilege('anon', c.oid, 'DELETE')))::text
union all
select 'privilege', 'authenticated_public_tables_owned',
       (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('r','p')
           and pg_get_userbyid(c.relowner) = 'authenticated')::text
union all
select 'privilege', 'authenticated_holds_TEMP_on_db',
       has_database_privilege('authenticated', current_database(), 'TEMP')::text;
SQL
rc=$?
if [[ $rc -ne 0 ]]; then echo "db-template: sentinel report failed (exit $rc)" >&2; exit $rc; fi

echo "==> BYPASSRLS allowlist (rule 11) — every row here ignores every policy"
"${PSQL[@]}" -d "$TEMPLATE" -A -t -F'|' -f - <<'SQL'
-- Printed in full on every build, deliberately. Rule 11 admits the local cluster
-- superuser because auth.is_emulation() exists, and that concession must be read by a
-- human rather than discovered later. A row here that is NOT one of
-- postgres / service_role / supabase_admin / authenticator and is NOT marked
-- "LOCAL EMULATION ONLY" is a finding.
select 'bypassrls_allow', a.rolname,
       (select r.rolbypassrls::text from pg_roles r where r.rolname = a.rolname),
       left(a.reason, 72)
  from public.posture_bypassrls_allow a
 order by a.rolname;
SQL
rc=$?
if [[ $rc -ne 0 ]]; then echo "db-template: allowlist report failed (exit $rc)" >&2; exit $rc; fi

cat <<'NOTE'

==> NOTE FOR WHOEVER CLONES THIS TEMPLATE
Two things do NOT travel with CREATE DATABASE ... TEMPLATE, and both were load-bearing:

  1. The DATABASE ACL. `revoke temporary on database` is applied by
     20261021140000_harden_public_schema.sql against current_database(), so the TEMPLATE
     has it and a CLONE does not (V22: the app role keeps PUBLIC's TEMPORARY privilege,
     and a temp table shadows an unqualified reference to a real table). Re-apply it per
     clone, as the pre-port harness did.
  2. The DATABASE OWNER. CREATE DATABASE sets the owner to the CREATING role, so a clone
     made by the bootstrap superuser is owned by it rather than by `postgres` — which
     changes what `pg_database_owner` resolves to and therefore who owns schema `public`.
     Clone with `CREATE DATABASE <clone> TEMPLATE <tpl> OWNER postgres` to keep the
     ownership shape the posture rules are written against.
NOTE

echo "template ready: $TEMPLATE"
