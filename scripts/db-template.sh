#!/usr/bin/env bash
# scripts/db-template.sh — build the integration-test TEMPLATE database.
#
# Drops and recreates $TEST_TEMPLATE_DB, re-applies the database-level half of
# 0000_bootstrap_roles.sql (roles are cluster-wide and already exist; the per-database
# hardening is NOT), runs scripts/migrate.sh (lexical glob over migrations/0*.sql plus
# app.verify_security_posture()), and leaves the database ready to be cloned with
# CREATE DATABASE ... TEMPLATE.
#
# Rules this script is written to:
#   * LC_ALL is exported or the postmaster aborts (V27).
#   * psql is NEVER piped into head/tail/grep: a pipeline reports the FILTER's exit
#     status, so a failed migration would read as a success. SQL arrives on stdin via a
#     heredoc, which is a redirection rather than a pipe, so $? is psql's own status.
#   * The database name reaches SQL as an IDENTIFIER, which cannot be parameterised. It
#     is validated against a strict pattern and then passed through psql's :"var"
#     identifier quoting — never concatenated into SQL text. Note that psql performs
#     variable interpolation for -f/stdin only, NOT for -c.
#   * CREATE/DROP DATABASE cannot run inside a transaction block, so each gets its own
#     psql invocation and no --single-transaction.
set -euo pipefail

export LC_ALL="${LC_ALL:-en_US.UTF-8}"                      # V27
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"     # Homebrew PG 17.11

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="${TEST_TEMPLATE_DB:-statesman_test_template}"
ADMIN_DB="${TEST_ADMIN_DB:-postgres}"

# CREATE DATABASE needs rolcreatedb. Measured on this cluster: statesman_owner,
# statesman_migrator and statesman_app ALL have rolcreatedb = false, so the template
# build runs as the bootstrap superuser (the macOS login role, via pg_hba `trust`) —
# the same role V10 designates for pg_dump. It is used for DDL only; the tests connect
# as statesman_app, which tests/integration/support/db.ts asserts before any read.
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

echo "==> creating $TEMPLATE"
"${PSQL[@]}" -d "$ADMIN_DB" -v tpl="$TEMPLATE" -f - <<'SQL'
create database :"tpl";
SQL

# The database-level half of 0000. CREATE DATABASE copies schema ownership and schema
# ACLs but NOT the database ACL, so `revoke temporary` and `grant create on database`
# have to be re-applied here — and again on every clone, see
# tests/integration/support/db.ts (V22).
echo "==> applying database-level hardening (0000, \\connect half)"
"${PSQL[@]}" -d "$TEMPLATE" -v tpl="$TEMPLATE" --single-transaction -f - <<'SQL'
alter schema public owner to statesman_owner;
grant  create    on database :"tpl"  to   statesman_owner;
revoke create    on schema   public  from public;
revoke temporary on database :"tpl"  from public;
SQL

echo "==> applying migrations/0*.sql + verify_security_posture()"
bash "$ROOT/scripts/migrate.sh" "$TEMPLATE"

# Report the template's measured posture. Reads, not assumptions: a template that built
# "successfully" with FORCE left off, or with the sentinels missing, makes every tenancy
# test downstream vacuous (V18).
echo "==> template posture (kind|name|rls_enabled|rls_forced|policies)"
"${PSQL[@]}" -d "$TEMPLATE" -A -t -F'|' -f - <<'SQL'
select 'rls', c.relname, c.relrowsecurity::text, c.relforcerowsecurity::text,
       (select count(*) from pg_policy where polrelid = c.oid)::text
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r','p')
 order by c.relname;
SQL

echo "==> template sentinels and app-role privileges"
"${PSQL[@]}" -d "$TEMPLATE" -A -t -F'|' -f - <<'SQL'
select 'sentinel', 'app_user', count(*)::text from public.app_user
          where id = '00000000-0000-0000-0000-00000000dead'
union all
select 'sentinel', 'decision', count(*)::text from public.decision
          where user_id = '00000000-0000-0000-0000-00000000dead'
union all
select 'sentinel', 'decision_revision', count(*)::text from public.decision_revision
          where user_id = '00000000-0000-0000-0000-00000000dead'
union all
select 'privilege', 'statesman_app_holds_TEMP_on_db',
       has_database_privilege('statesman_app', current_database(), 'TEMP')::text
union all
select 'privilege', 'statesman_app_public_tables_owned',
       (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('r','p')
           and pg_get_userbyid(c.relowner) = 'statesman_app')::text;
SQL

echo "template ready: $TEMPLATE"
