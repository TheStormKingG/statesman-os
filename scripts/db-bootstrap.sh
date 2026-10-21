#!/usr/bin/env bash
#
# db-bootstrap.sh — the one-time cluster bootstrap (migrations/0000_bootstrap_roles.sql).
#
# WHAT IT DOES
#   Creates the three roles and applies the database-level hardening that the
#   ordered migration sequence assumes already exists:
#       statesman_owner     owns schema public and the SECURITY DEFINER functions (nologin)
#       statesman_app       LOGIN, owns nothing, NOBYPASSRLS, NOSUPERUSER  <- the app role
#       statesman_migrator  LOGIN, member of statesman_owner               <- applies migrations
#   plus: revoke CREATE on schema public from PUBLIC, revoke TEMPORARY on the
#   database from PUBLIC (V22: a temp table shadows an unqualified reference to a
#   real table), and pin statesman_app's search_path.
#
# IDEMPOTENCY — READ THIS BEFORE RE-RUNNING
#   migrations/0000 is deliberately NOT idempotent: its own header says re-running
#   it should fail loudly rather than silently re-grant. This wrapper does not
#   paper over that. It is "idempotent where safe" and no further:
#     SAFE, done conditionally  - CREATE DATABASE, only when the database is absent.
#     NOT SAFE, refused         - re-running 0000 when any statesman_* role already
#                                 exists. The script aborts and tells you what it
#                                 found instead of attempting a partial re-apply.
#   A half-applied bootstrap is a security posture you cannot reason about, which
#   is exactly what a convenience `if not exists` everywhere would produce.
#
# INPUT (environment; no secrets on the command line)
#   STATESMAN_DB          required  target database, e.g. statesman_dev
#                                   (may also be given as the first argument)
#   STATESMAN_APP_PW      required  password for statesman_app
#   STATESMAN_MIG_PW      required  password for statesman_migrator
#   BOOTSTRAP_SUPERUSER   optional  role that runs the bootstrap. Default: $(id -un).
#                                   Must be a superuser: CREATE ROLE requires it.
#   BOOTSTRAP_MAINT_DB    optional  database to connect to first. Default: postgres.
#   PGHOST / PGPORT       optional  Default: 127.0.0.1 / 5432.
#
# PASSWORD POLICY (why it refuses)
#   pg_hba.conf is `trust` for local, 127.0.0.1 and ::1 on this machine (V1), so a
#   weak password is invisible locally — it is never challenged, and a typo'd
#   username connects successfully as whatever role it names. The password only
#   starts mattering the moment the cluster is reachable from anywhere else, and by
#   then nobody is re-running bootstrap. So the check happens here, once, where it
#   is still cheap. Refused: empty, whitespace-only, shorter than 12 characters,
#   a known default (including the documented dev values devapp/devmig), the role
#   or database name, and the two passwords being equal to each other.
#
# USAGE
#   export STATESMAN_DB=statesman_dev
#   export STATESMAN_APP_PW='…' STATESMAN_MIG_PW='…'
#   bash scripts/db-bootstrap.sh              # or: npm run db:bootstrap
#   bash scripts/db-bootstrap.sh --dry-run    # every check, no mutation
#
#   Then:  bash scripts/migrate.sh "$STATESMAN_DB"
#
# RESIDUAL, DECLARED NOT ARGUED AWAY
#   psql takes the passwords as `-v` assignments, so they appear in this process's
#   argv and are visible to `ps` for the lifetime of the psql call. psql only
#   interpolates variables for input read from a file or stdin, and 0000 spells them
#   `:app_pw` (the unquoted form), which rules out the `:'var'` auto-quoting form;
#   `\set` from stdin was tested and silently eats spaces in the value, so it is not
#   a safe alternative. On a single-operator machine this is accepted. On a shared
#   host, bootstrap from a local session.
#
# Written for bash 3.2.57 — the only bash on this machine.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BOOTSTRAP_SQL="$ROOT/migrations/0000_bootstrap_roles.sql"

# V27: the postmaster aborts on this macOS build without a valid locale
# ("postmaster became multithreaded during startup"). V26: the server is not
# brew-managed, so its binaries are not necessarily on a login PATH.
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"

DRY_RUN=0

die() { printf 'db-bootstrap: %s\n' "$*" >&2; exit 1; }
note() { printf '  %s\n' "$*"; }
ok() { printf '  ok   %s\n' "$*"; }
head2() { printf '\n== %s\n' "$*"; }

# ------------------------------------------------------------------- arguments

DB_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,70p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option '$1' (try --help)" ;;
    *) [ -z "$DB_ARG" ] || die "unexpected extra argument '$1'"; DB_ARG="$1" ;;
  esac
  shift
done

DB="${DB_ARG:-${STATESMAN_DB:-}}"
APP_PW="${STATESMAN_APP_PW:-}"
MIG_PW="${STATESMAN_MIG_PW:-}"
SUPERUSER="${BOOTSTRAP_SUPERUSER:-$(id -un)}"
MAINT_DB="${BOOTSTRAP_MAINT_DB:-postgres}"
export PGHOST="${PGHOST:-127.0.0.1}"
export PGPORT="${PGPORT:-5432}"

# --------------------------------------------------------------------- helpers

# Wraps a value as a single-quoted SQL literal, doubling embedded quotes, so it can
# be handed to psql -v for a bare `:var` reference. Round-trip verified against this
# server for values containing a space, a single quote, a backslash and a tab.
sql_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"; }

# Lowercase without bash 4's ${v,,}.
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

psql_super() { psql -X -q -v ON_ERROR_STOP=1 -U "$SUPERUSER" "$@"; }

scalar() { psql_super -d "$MAINT_DB" -At -c "$1" 2>/dev/null; }

DEFAULT_PWS="devapp devmig password passwd postgres statesman statesman_app \
statesman_migrator statesman_owner changeme change_me secret app_pw mig_pw \
admin letmein 123456 password123 test testing dev development local example"

check_password() {
  label="$1"; value="$2"; peer="$3"
  [ -n "$value" ] || die "$label is empty. Set it in the environment; it is never defaulted."
  stripped="$(printf '%s' "$value" | tr -d '[:space:]')"
  [ -n "$stripped" ] || die "$label is whitespace only."
  if [ "${#value}" -lt 12 ]; then
    die "$label is ${#value} characters. Minimum is 12. See the password policy in this file's header."
  fi
  lv="$(lower "$value")"
  for bad in $DEFAULT_PWS; do
    if [ "$lv" = "$bad" ]; then
      die "$label is a known default. Refusing to bootstrap a cluster with a default password."
    fi
  done
  [ "$lv" != "$(lower "$DB")" ] || die "$label equals the database name."
  if [ -n "$peer" ] && [ "$value" = "$peer" ]; then
    die "STATESMAN_APP_PW and STATESMAN_MIG_PW are identical. The app role and the \
migrator role differ in privilege by design; give them different passwords."
  fi
}

# ------------------------------------------------------------------- preflight

printf '==================================================================\n'
printf ' STATESMAN OS cluster bootstrap%s\n' "$([ "$DRY_RUN" -eq 1 ] && printf ' (DRY RUN)')"
printf '==================================================================\n'

head2 "inputs"
[ -n "$DB" ] || die "no target database. Set STATESMAN_DB or pass it as the first argument."
case "$DB" in
  *[!a-z0-9_]* | [0-9]* | "") die "database name '$DB' must match ^[a-z_][a-z0-9_]*\$ (it is interpolated as an identifier by 0000)." ;;
esac
[ "${#DB}" -le 63 ] || die "database name is ${#DB} characters; Postgres truncates at 63."
ok "database        $DB"
ok "superuser       $SUPERUSER"
ok "maintenance db  $MAINT_DB"
ok "server          $PGHOST:$PGPORT"

head2 "password policy"
check_password "STATESMAN_APP_PW" "$APP_PW" ""
check_password "STATESMAN_MIG_PW" "$MIG_PW" "$APP_PW"
ok "STATESMAN_APP_PW accepted (${#APP_PW} chars, never logged)"
ok "STATESMAN_MIG_PW accepted (${#MIG_PW} chars, never logged)"

head2 "toolchain and reachability"
command -v psql >/dev/null 2>&1 || die "psql not on PATH. Expected /opt/homebrew/opt/postgresql@17/bin."
ok "psql            $(psql --version)"
[ -f "$BOOTSTRAP_SQL" ] || die "missing $BOOTSTRAP_SQL"
ok "bootstrap sql   migrations/$(basename "$BOOTSTRAP_SQL")"

if ! server_version="$(scalar "select current_setting('server_version')")" || [ -z "$server_version" ]; then
  die "cannot connect to $PGHOST:$PGPORT as '$SUPERUSER' (database '$MAINT_DB'). \
Is the server running? V26: it is not brew-managed — 'brew services start postgresql@17'."
fi
ok "server_version  $server_version"

is_super="$(scalar "select current_setting('is_superuser')")"
[ "$is_super" = "on" ] || die "'$SUPERUSER' is not a superuser (is_superuser=$is_super). \
CREATE ROLE needs one. Set BOOTSTRAP_SUPERUSER."
ok "is_superuser    on"

head2 "pre-existing state"
existing="$(scalar "select string_agg(rolname, ' ' order by rolname) from pg_roles \
where rolname in ('statesman_owner','statesman_app','statesman_migrator')")"
if [ -n "$existing" ]; then
  printf '\n' >&2
  printf 'db-bootstrap: REFUSING — these roles already exist: %s\n' "$existing" >&2
  printf '\n' >&2
  printf '  migrations/0000 is not idempotent by design: re-running it must fail loudly\n' >&2
  printf '  rather than silently re-grant. This cluster is already bootstrapped, or a\n' >&2
  printf '  previous run stopped part way.\n\n' >&2
  printf '  If the bootstrap is complete, you want migrate.sh, not this script:\n' >&2
  printf '      bash scripts/migrate.sh %s\n\n' "$DB" >&2
  printf '  If it is genuinely half-applied, inspect and unwind it by hand — a wrapper\n' >&2
  printf '  cannot tell a finished bootstrap from an abandoned one, and guessing wrong\n' >&2
  printf '  leaves a security posture nobody can reason about.\n' >&2
  exit 1
fi
ok "no statesman_* role exists yet"

db_exists="$(scalar "select 1 from pg_database where datname = '$DB'")"
if [ "$db_exists" = "1" ]; then
  ok "database '$DB' already exists (0000 will harden it in place)"
  CREATE_DB=0
else
  note "database '$DB' is absent — it will be created (the idempotent-where-safe step)"
  CREATE_DB=1
fi

# ------------------------------------------------------------------------- plan

APP_LIT="$(sql_quote "$APP_PW")"
MIG_LIT="$(sql_quote "$MIG_PW")"

head2 "plan"
[ "$CREATE_DB" -eq 1 ] && note "psql -U $SUPERUSER -d $MAINT_DB -c 'create database \"$DB\"'"
note "psql -U $SUPERUSER -d $MAINT_DB \\"
note "     -v db=$DB -v app_pw='<STATESMAN_APP_PW>' -v mig_pw='<STATESMAN_MIG_PW>' \\"
note "     -v ON_ERROR_STOP=1 -f migrations/$(basename "$BOOTSTRAP_SQL")"
note "psql -U $SUPERUSER -d $DB   # post-conditions"

if [ "$DRY_RUN" -eq 1 ]; then
  printf '\n== dry run: every check above passed; nothing was executed.\n'
  exit 0
fi

# ---------------------------------------------------------------------- execute

if [ "$CREATE_DB" -eq 1 ]; then
  head2 "create database"
  psql_super -d "$MAINT_DB" -c "create database \"$DB\""
  rc=$?
  [ "$rc" -eq 0 ] || die "create database failed (exit $rc)"
  ok "created $DB"
fi

head2 "apply migrations/$(basename "$BOOTSTRAP_SQL")"
psql_super -d "$MAINT_DB" -v db="$DB" -v app_pw="$APP_LIT" -v mig_pw="$MIG_LIT" -f "$BOOTSTRAP_SQL"
rc=$?
APP_LIT=""; MIG_LIT=""
if [ "$rc" -ne 0 ]; then
  die "bootstrap failed (psql exit $rc). The cluster may be partially bootstrapped; \
inspect pg_roles before retrying — this script will refuse to re-run while any \
statesman_* role exists."
fi
ok "0000 applied"

# ------------------------------------------------------------------ postconditions
#
# A bootstrap that "ran" is not a bootstrap that is correct. These read back the
# attributes the whole security model rests on (V1 for BYPASSRLS/superuser, V4 for
# ownership), so a silent partial apply cannot be mistaken for success.

head2 "post-conditions"
posture="$(psql -X -q -At -U "$SUPERUSER" -d "$DB" -c "
  select
    (select count(*) from pg_roles where rolname = 'statesman_owner')
  || '|' || (select count(*) from pg_roles
             where rolname = 'statesman_app'
               and rolcanlogin and not rolbypassrls and not rolsuper
               and not rolcreatedb and not rolcreaterole)
  || '|' || (select count(*) from pg_roles where rolname = 'statesman_migrator' and rolcanlogin)
  || '|' || (select count(*) from pg_auth_members m
             join pg_roles r on r.oid = m.roleid
             join pg_roles g on g.oid = m.member
             where r.rolname = 'statesman_owner' and g.rolname = 'statesman_migrator')
  || '|' || (select count(*) from pg_namespace
             where nspname = 'public' and pg_get_userbyid(nspowner) = 'statesman_owner')
  || '|' || (select case when has_schema_privilege('public', 'public', 'create')
                    then 0 else 1 end)
" 2>&1)"
rc=$?
[ "$rc" -eq 0 ] || die "post-condition query failed (exit $rc): $posture"

OLD_IFS="$IFS"; IFS='|'; set -- $posture; IFS="$OLD_IFS"
failed=0
check() { if [ "$1" = "1" ]; then ok "$2"; else printf '  FAIL %s\n' "$2" >&2; failed=1; fi; }
check "${1:-0}" "statesman_owner exists"
check "${2:-0}" "statesman_app is LOGIN, NOBYPASSRLS, NOSUPERUSER, NOCREATEDB, NOCREATEROLE (V1)"
check "${3:-0}" "statesman_migrator is LOGIN"
check "${4:-0}" "statesman_migrator is a member of statesman_owner"
check "${5:-0}" "schema public is owned by statesman_owner (V4: app must own nothing)"
check "${6:-0}" "CREATE on schema public revoked from PUBLIC"

printf '\n==================================================================\n'
if [ "$failed" -ne 0 ]; then
  printf ' BOOTSTRAP INCOMPLETE — a post-condition failed above.\n'
  printf ' Do not run migrations against this database yet.\n'
  printf '==================================================================\n'
  exit 1
fi
printf ' BOOTSTRAP OK — %s is ready for migrations.\n' "$DB"
printf '   next: bash scripts/migrate.sh %s\n' "$DB"
printf '==================================================================\n'
