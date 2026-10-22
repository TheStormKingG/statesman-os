#!/usr/bin/env bash
# scripts/migrate.sh — run the Supabase-shaped migration set against a LOCAL database.
#
# Order, and all three steps are mandatory:
#   1. scripts/emulate-supabase.sh      the parts of Supabase the set depends on
#   2. supabase/migrations/*.sql        the ported set, in LEXICAL order
#   3. app.verify_security_posture()    the release gate (ADR-0015), as `postgres`
#
# Lexical glob, never a hand-maintained list, so a new migration cannot be omitted. The
# Supabase CLI orders by the same timestamp prefix, so local order and remote order are
# the same ordering rather than two orderings that happen to agree.
#
# WHAT THIS SCRIPT IS NOT: it is not `supabase db push`. It applies the set to a local
# database that scripts/emulate-supabase.sh has shaped to look like the project. Pushing
# to project onpkspfxfmjkqpomcsse is a separate, deliberate act and is not automated here.
#
# ===========================================================================
# EXIT STATUS, which this project has got wrong twice
# ===========================================================================
# psql is NEVER piped into head/tail/grep/tee. A pipeline reports the FILTER's exit
# status, so a failed migration reads as a success and the run continues over a broken
# database. Every psql invocation below is bare, its status is captured into a variable on
# the very next line, and the script exits with that number. `set -o pipefail` is also on,
# so a pipeline added later by someone who does not read this comment still fails.
set -euo pipefail

export LC_ALL="${LC_ALL:-en_US.UTF-8}"                      # V27: postmaster needs a locale
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"     # Homebrew PG 17.11

DB="${1:?usage: migrate.sh <database>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ADMIN_ROLE="${TEST_ADMIN_ROLE:-$(id -un)}"

PSQL=(psql --no-psqlrc -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5432 -U "$ADMIN_ROLE")

# ---------------------------------------------------------------------------
# 1. The emulation bootstrap.
# ---------------------------------------------------------------------------
# Runs FIRST and unconditionally, because the very first migration references
# `auth.users` and the `postgres` role. Idempotent, so re-running a migrate is safe.
echo "==> emulate-supabase.sh $DB"
bash "$ROOT/scripts/emulate-supabase.sh" "$DB"
rc=$?
if [[ $rc -ne 0 ]]; then
  echo "migrate: emulation bootstrap failed (exit $rc)" >&2
  exit $rc
fi

# ---------------------------------------------------------------------------
# 2. The set.
# ---------------------------------------------------------------------------
shopt -s nullglob
files=("$ROOT"/supabase/migrations/*.sql)
if [[ ${#files[@]} -eq 0 ]]; then
  # A silent zero-migration run would leave an empty database that the posture check
  # passes trivially — every rule enumerates relations, and there are none. V7's rule
  # applied to the migration runner itself: a count of 0 is never a success signal.
  echo "migrate: no migrations found in $ROOT/supabase/migrations — refusing to report success" >&2
  exit 2
fi

for f in "${files[@]}"; do
  echo "==> $(basename "$f")"
  "${PSQL[@]}" -d "$DB" -f "$f"
  rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "migrate: $(basename "$f") failed (psql exit $rc)" >&2
    exit $rc
  fi
done

# ---------------------------------------------------------------------------
# 3. The posture check.
# ---------------------------------------------------------------------------
# ADR-0015: with the server boundary and the grant model both gone, "the posture check and
# the mutation gate stop being good practice and become the only thing standing between a
# policy typo and the journal. This is now a release gate, not a quality measure."
#
# Run as `postgres`, because app.verify_security_posture() is SECURITY INVOKER and reads
# the three posture registries, which `authenticated` deliberately cannot see. It is
# granted to no role; making it a definer function reachable by `authenticated` would be a
# hole in the thing that exists to find holes.
echo "==> app.verify_security_posture()"
"${PSQL[@]}" -d "$DB" -qAt -c "set role postgres; select app.verify_security_posture();"
rc=$?
if [[ $rc -ne 0 ]]; then
  echo "migrate: SECURITY POSTURE FAILED (psql exit $rc)" >&2
  exit $rc
fi
echo "posture OK"

# ---------------------------------------------------------------------------
# 4. The REST exposure check.
# ---------------------------------------------------------------------------
# A SECOND gate, not a second call to the same one. 20261022160000 exposes schema `app` to
# PostgREST so the lifecycle RPCs are reachable from the browser at all; ST097 means that
# surface is wrong (a setting or a grant), where ST099 means the schema is wrong (SQL).
# Two SQLSTATEs because the two have different fixes.
#
# A gate reached only when the one above passes would hide a REST fault behind a schema
# fault, so this runs unconditionally after it and has its own exit status. Every
# app.verify_* function must be invoked here — tests/unit/verify-functions-invoked.test.ts
# asserts exactly that, so a check added later cannot sit in the database uncalled.
echo "==> app.verify_rest_exposure()"
"${PSQL[@]}" -d "$DB" -qAt -c "set role postgres; select app.verify_rest_exposure();"
rc=$?
if [[ $rc -ne 0 ]]; then
  echo "migrate: REST EXPOSURE POSTURE FAILED (psql exit $rc)" >&2
  exit $rc
fi
echo "rest exposure OK"
