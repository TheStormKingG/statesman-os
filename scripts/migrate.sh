#!/usr/bin/env bash
# Applies migrations/0*.sql in LEXICAL order, then runs the posture check.
# Lexical glob, never a hand-maintained list, so a new migration cannot be omitted.
set -euo pipefail
export LC_ALL="${LC_ALL:-en_US.UTF-8}"          # V27: postmaster needs a valid locale
DB="${1:?usage: migrate.sh <database>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

for f in "$ROOT"/migrations/0*.sql; do
  case "$(basename "$f")" in 0000_*) continue ;; esac   # bootstrap is run separately
  echo "==> $(basename "$f")"
  psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$f"
done

echo "==> verify_security_posture()"
psql -d "$DB" -v ON_ERROR_STOP=1 -qAt -c "set role statesman_owner; select app.verify_security_posture();"
echo "posture OK"
