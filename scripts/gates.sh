#!/usr/bin/env bash
#
# gates.sh — the local gate sequence, in canon §8.7 order.
#
#   1. typecheck           tsc --noEmit (strict)
#   2. lint                eslint, as its own step (next build may not lint)
#   3. boundaries          AST import-boundary check over src tests scripts
#   4. boundaries:selftest the import-boundary checker's own positive control
#   5. test:unit           vitest, unit + smoke
#   6. test:integration    vitest, template-cloned databases, posture check first
#
# ── Three rules this script exists to keep ────────────────────────────────────
#
# 1. EVERY GATE RUNS. THERE IS NO SHORT-CIRCUIT.
#    A sequence that stops at the first failure reports the first defect and
#    HIDES every later one, so the gates holding the real findings are never
#    reached. This script was previously doing exactly that: it halted at step 2
#    of 5 because the lint toolchain was absent, and the boundary check, the unit
#    suite and the integration suite were all reported "NOT RUN (stopped after
#    lint)" — which looked like a toolchain problem and was in fact concealing
#    15 lint errors, 2 boundary violations and 2 unit-test failures. Each step
#    now runs regardless of what came before, and the overall status is the AND
#    of all of them. `--stop-on-fail` restores the old behaviour for local
#    iteration; it is never the default.
#
# 2. STATUS IS CAPTURED DIRECTLY, NEVER THROUGH A PIPE.
#    `set -e` is deliberately NOT set, and no step is piped into tee/grep/head.
#    A pipeline reports the LAST command's status, so `vitest | tee log` is green
#    whenever tee succeeds. Each step runs bare and `$?` is read immediately.
#
# 3. AN UNEXECUTED CHECK IS "NOT RUN", NEVER "PASS" (canon §8.6).
#    Every step preflights the tools it needs and returns 127 when one is
#    missing. 127 renders as NOT RUN, and NOT RUN counts as a gate FAILURE: it
#    can never contribute to a green run. There is no code path by which a check
#    that did not execute is reported as passing.
#
# ── What the table is NOT ─────────────────────────────────────────────────────
#
# Canon §8.7 also calls for format, build, E2E + axe, dependency audit, secret
# scan (before and after the test gates) and trace:check. None of those exists
# in this repository yet, and this script deliberately does not invent them: a
# step that is permanently NOT RUN would make the overall status permanently red
# and train the reader to ignore it. The table below is the LOCAL subset. Adding
# the remaining §8.7 gates means adding them here once they are real.
#
# Usage:
#   bash scripts/gates.sh                 run the whole sequence
#   bash scripts/gates.sh --only lint     run one step (used to re-point npm's
#                                         `lint` script at this file; see below)
#   bash scripts/gates.sh --stop-on-fail  stop at the first failing gate
#   bash scripts/gates.sh --list          list the steps
#
# Note on the lint step: it invokes eslint directly rather than `npm run lint`,
# so that package.json's `lint` script may safely be re-pointed at
# `bash scripts/gates.sh --only lint` without recursing. `boundaries:selftest`
# likewise calls tsx directly, because package.json has no script for it.
#
# Exit status: 0 when every gate PASSed, 1 when any gate FAILed or was NOT RUN.
# A single exit status cannot carry six of them, so the per-gate exit codes live
# in the summary table and are the authoritative record.
#
# Written for bash 3.2.57 — the only bash on this machine. No associative
# arrays, no `declare -g`, no `${arr[@]}` expansion of a possibly-empty array.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

# V27: the postmaster aborts on this macOS build without a valid locale, and the
# integration suite starts by connecting. V26: Postgres is not brew-managed, so
# its client binaries are not necessarily on a login PATH.
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"

STEPS="typecheck lint boundaries boundaries:selftest test:unit test:component test:integration mutation"

BOUNDARY_SCRIPT="scripts/check-import-boundaries.ts"

# ------------------------------------------------------------------ step bodies

step_display() {
  case "$1" in
    typecheck)            echo "npm run typecheck" ;;
    lint)                 echo "node_modules/.bin/eslint ." ;;
    boundaries)           echo "npm run boundaries" ;;
    boundaries:selftest)  echo "node_modules/.bin/tsx $BOUNDARY_SCRIPT --selftest" ;;
    test:unit)            echo "npm run test:unit" ;;
    test:component)      echo "npm run test:component" ;;
    test:integration)     echo "npm run test:integration" ;;
    mutation)             echo "bash scripts/mutation-check.sh" ;;
    *)                    echo "<unknown step: $1>" ;;
  esac
}

# Reports what a step needs but has not got. Empty output means "ready to run".
# Printing to stdout keeps the caller free of a subshell for the status itself.
step_missing() {
  missing=""
  case "$1" in
    typecheck)
      [ -x "node_modules/.bin/tsc" ] || missing="$missing tsc"
      [ -f "tsconfig.json" ]         || missing="$missing tsconfig.json"
      ;;
    lint)
      [ -x "node_modules/.bin/eslint" ]        || missing="$missing eslint"
      [ -d "node_modules/typescript-eslint" ]  || missing="$missing typescript-eslint"
      [ -d "node_modules/@eslint/js" ]         || missing="$missing @eslint/js"
      [ -f "eslint.config.mjs" ]               || missing="$missing eslint.config.mjs"
      ;;
    boundaries|boundaries:selftest)
      [ -x "node_modules/.bin/tsx" ] || missing="$missing tsx"
      [ -f "$BOUNDARY_SCRIPT" ]      || missing="$missing $BOUNDARY_SCRIPT"
      ;;
    test:unit)
      [ -x "node_modules/.bin/vitest" ]   || missing="$missing vitest"
      [ -f "vitest.unit.config.ts" ]      || missing="$missing vitest.unit.config.ts"
      ;;
    test:component)
      # jsdom is a devDependency and the suite is the only instrument that
      # renders a screen. Absent, this reports NOT RUN rather than PASS: canon
      # §8.6, an unexecuted check is never a pass.
      [ -x "node_modules/.bin/vitest" ]        || missing="$missing vitest"
      [ -f "vitest.component.config.ts" ]      || missing="$missing vitest.component.config.ts"
      [ -d "node_modules/jsdom" ]              || missing="$missing jsdom"
      [ -d "node_modules/@testing-library/react" ] || missing="$missing @testing-library/react"
      ;;
    test:integration)
      [ -x "node_modules/.bin/vitest" ]        || missing="$missing vitest"
      [ -f "vitest.integration.config.ts" ]    || missing="$missing vitest.integration.config.ts"
      ;;
    mutation)
      # The gate that proves the other gates can fail. It was previously in neither
      # STEPS nor package.json, so `npm run gates` could go fully green while a
      # security guard had been removed from the tree.
      [ -f "scripts/mutation-check.sh" ]       || missing="$missing scripts/mutation-check.sh"
      [ -f "mutations/lib/mutation.mjs" ]      || missing="$missing mutations/lib/mutation.mjs"
      [ -f "mutations/lib/vitest-summary.mjs" ] || missing="$missing mutations/lib/vitest-summary.mjs"
      command -v psql >/dev/null 2>&1          || missing="$missing psql"
      ;;
  esac
  printf '%s' "$missing"
}

step_body() {
  case "$1" in
    typecheck)            npm run typecheck ;;
    lint)                 node_modules/.bin/eslint . ;;
    boundaries)           npm run boundaries ;;
    boundaries:selftest)  node_modules/.bin/tsx "$BOUNDARY_SCRIPT" --selftest ;;
    test:unit)            npm run test:unit ;;
    test:component)      npm run test:component ;;
    test:integration)     npm run test:integration ;;
    mutation)             bash scripts/mutation-check.sh ;;
    *)                    echo "gates.sh: unknown step '$1'" >&2; return 2 ;;
  esac
}

# Exits 127 when the step's toolchain is absent, which the summary renders as
# NOT RUN. 127 is never PASS and never contributes to a green run.
step_run() {
  gaps="$(step_missing "$1")"
  if [ -n "$gaps" ]; then
    {
      echo
      echo "$1: NOT RUN — a tool or config file this gate needs is absent."
      echo "  missing:$gaps"
      echo
      echo "  Reporting NOT RUN (exit 127) rather than passing a check that never ran"
      echo "  (canon §8.6: unexecuted is NOT RUN, never PASSED)."
    } >&2
    return 127
  fi
  step_body "$1"
}

status_for() {
  case "$1" in
    0)   echo "PASS" ;;
    127) echo "NOT RUN (tool missing)" ;;
    *)   echo "FAIL" ;;
  esac
}

# ---------------------------------------------------------------- argument pass

ONLY=""
STOP_ON_FAIL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --only)
      shift
      [ $# -gt 0 ] || { echo "gates.sh: --only needs a step name" >&2; exit 2; }
      ONLY="$1"
      ;;
    --only=*) ONLY="${1#--only=}" ;;
    --stop-on-fail) STOP_ON_FAIL=1 ;;
    --list)
      for s in $STEPS; do printf '%-22s %s\n' "$s" "$(step_display "$s")"; done
      exit 0
      ;;
    -h|--help)
      sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "gates.sh: unknown argument '$1' (try --help)" >&2
      exit 2
      ;;
  esac
  shift
done

if [ -n "$ONLY" ]; then
  found=0
  for s in $STEPS; do [ "$s" = "$ONLY" ] && found=1; done
  if [ "$found" -eq 0 ]; then
    echo "gates.sh: '--only $ONLY' is not a known step. Known: $STEPS" >&2
    exit 2
  fi
  STEPS="$ONLY"
fi

# ------------------------------------------------------------------------ driver

TOTAL=0
for s in $STEPS; do TOTAL=$((TOTAL + 1)); done

SUMMARY=""          # newline-delimited: name<TAB>exit<TAB>status
PASSED=0
FAILED=0
NOTRUN=0
SKIPPED=0
STOPPED=""
INDEX=0

printf '==================================================================\n'
printf ' STATESMAN OS gate sequence — %d step(s), every one run\n' "$TOTAL"
printf ' root: %s\n' "$ROOT"
printf '==================================================================\n'

for name in $STEPS; do
  INDEX=$((INDEX + 1))

  # Only reachable with --stop-on-fail; the default never sets STOPPED.
  if [ -n "$STOPPED" ]; then
    SUMMARY="$SUMMARY
$name	-	NOT RUN (stopped after $STOPPED)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  printf '\n----- gate %d/%d: %s -----\n' "$INDEX" "$TOTAL" "$name"
  printf '+ %s\n' "$(step_display "$name")"

  # The step runs bare: no pipe, no subshell, no command substitution, so $? is
  # this command's own status and not a pipeline's tail.
  step_run "$name"
  rc=$?

  printf -- '----- %s: exit=%d (%s)\n' "$name" "$rc" "$(status_for "$rc")"
  SUMMARY="$SUMMARY
$name	$rc	$(status_for "$rc")"

  if [ "$rc" -eq 0 ]; then
    PASSED=$((PASSED + 1))
  elif [ "$rc" -eq 127 ]; then
    NOTRUN=$((NOTRUN + 1))
    [ "$STOP_ON_FAIL" -eq 1 ] && STOPPED="$name"
  else
    FAILED=$((FAILED + 1))
    [ "$STOP_ON_FAIL" -eq 1 ] && STOPPED="$name"
  fi
done

# ----------------------------------------------------------------------- summary

printf '\n==================================================================\n'
printf ' SUMMARY\n'
printf '==================================================================\n'
printf ' %-22s %-6s %s\n' "GATE" "EXIT" "STATUS"
printf ' %-22s %-6s %s\n' "----------------------" "------" "----------------------------"
printf '%s\n' "$SUMMARY" | while IFS="	" read -r sname sexit sstatus; do
  [ -n "$sname" ] || continue
  printf ' %-22s %-6s %s\n' "$sname" "$sexit" "$sstatus"
done
printf '==================================================================\n'
printf ' %d of %d PASS · %d FAIL · %d NOT RUN · %d skipped\n' \
  "$PASSED" "$TOTAL" "$FAILED" "$NOTRUN" "$SKIPPED"

# ----------------------------------------------- out of band: the live-only checks
# WHY THIS BLOCK EXISTS. On 2026-10-22 this script reported every gate green while the
# product's only write path was completely unreachable: schema `app` was not in PostgREST's
# exposed-schema list, so every call from a browser answered PGRST106. Nothing here could
# see it, because the integration suite connects to PostgreSQL directly and a direct
# connection never consults that list. A suite's blind spot is exactly the set of components
# it does not traverse (docs/transport-blind-spots.md, ADR-0017).
#
# These checks need credentials and the network, so they CANNOT be gate steps: this script
# must keep passing with neither. But an absent check nobody mentions becomes the normal
# state, so they are printed here, as NOT RUN, on every single run.
#
# THIS BLOCK DELIBERATELY DOES NOT TOUCH $PASSED/$FAILED/$NOTRUN/$SKIPPED, $BAD OR THE EXIT
# STATUS. It is a notice, not a verdict. Making it a verdict would make every offline and
# credential-less run red, which is what gets a warning deleted rather than fixed.
printf '==================================================================\n'
printf ' OUT OF BAND: NOT RUN here, and not counted above\n'
printf '==================================================================\n'
printf ' These cross a transport this suite does not traverse. They are\n'
printf ' offline and credential-less by design, so their absence is NOT a\n'
printf ' gate failure. It is also NOT evidence that the live path works.\n'
printf '\n'
printf ' %-34s %s\n' "CHECK" "COVERS"
printf ' %-34s %s\n' "----------------------------------" "---------------------------"
printf ' %-34s %s\n' "scripts/verify-rest-exposure.sh" "TBS-01 TBS-02 TBS-03 TBS-04"
printf ' %-34s %s\n' "npx supabase db push" "the applied migration set"
printf '\n'
printf ' Blind spots with no instrument at all: TBS-06 (the published bundle),\n'
printf ' TBS-07 (Supabase Auth endpoints), TBS-08 (the browser runtime).\n'
printf ' docs/transport-blind-spots.md is the owner of that register.\n'

BAD=$((FAILED + NOTRUN + SKIPPED))
if [ "$BAD" -eq 0 ]; then
  printf ' ALL GATES PASSED\n'
  printf '==================================================================\n'
  exit 0
fi

printf ' GATES FAILED — %d gate(s) did not pass.\n' "$BAD"
printf ' A NOT RUN gate is a failure, not a pass (canon §8.6).\n'
printf ' Per-gate exit codes are in the table above; this process exits 1.\n'
printf '==================================================================\n'
exit 1
