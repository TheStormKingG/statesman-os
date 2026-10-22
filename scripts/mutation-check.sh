#!/usr/bin/env bash
# scripts/mutation-check.sh — the mutation gate.
#
# Canon §8: "A test that cannot be made to fail has not been shown to work." That is
# doctrine, and until this script existed nothing enforced it. An adversarial pass through
# this repo mutated eight separate security guards one at a time and the integration suite
# stayed GREEN at 44/44 for every one of them. A guard whose removal leaves the suite
# green is not protecting anything the suite can see.
#
# This script makes that measurable and repeatable. For each mutation registered under
# mutations/ it:
#
#   1. builds an isolated MIRROR of the repo (node_modules and package.json symlinked,
#      src/tests/scripts/migrations/configs copied),
#   2. applies exactly ONE mutation to the mirror, asserting it landed,
#   3. builds that mirror's OWN template database, under a name distinct from the
#      developer template, so a mutated schema never reaches statesman_test_template,
#   4. runs the integration suite in the mirror with the integration config,
#   5. requires a NON-ZERO exit AND that the specific test the mutation names failed,
#   6. destroys the mirror and its databases, and moves on.
#
# ── Every hard requirement below comes from a failure already observed here ───────────
#
# BASELINE FIRST. The unmutated suite must be green before any mutation is interpreted.
#   Without it a broken harness reports every mutation as "caught". A prior version of
#   exactly this kind of script treated ANY non-zero exit as "detected" and would have
#   reported success on all six mutations it ran while testing nothing at all.
#
# NAME THE TEST. Non-zero exit is not evidence. "Something failed" is satisfied by a typo
#   in the runner, a missing database, a port conflict or an unrelated flake. So the
#   verdict requires the EXPECTED test to appear among the failures, matched by name out
#   of `vitest run --reporter=json`.
#
# PASS THE CONFIG EXPLICITLY. `--config vitest.integration.config.ts`, always. Without it
#   vitest picks up no globalSetup, the template is never built, the harness role guard
#   never runs, and the suite collects nothing while exiting non-zero — which reads as
#   "caught" to a harness that only looks at the status.
#
# NEVER PIPE A COMMAND WHOSE STATUS MATTERS. A pipeline reports the LAST stage, so
#   `cmd | tail` hides cmd's failure. This bug has already occurred twice in this repo.
#   Every status-bearing invocation here is either a plain command, a `( … ) > file 2>&1`
#   redirection, or a `$( … )` substitution whose status is checked. The only pipes in
#   this file parse a string that was already captured, and each is marked.
#
# ASSERT THE MUTATION APPLIED. A stale or non-applying mutation leaves the mirror
#   unmutated. mutations/lib/mutation.mjs exits 2 unless the target text was present
#   exactly the required number of times and the replacement reads back from disk; the
#   gate treats that as a hard failure and never as evidence about a guard.
#
# CLEAN UP ON FAILURE TOO. An EXIT trap drops the mutation template and every worker
#   database that appeared during this run, and removes the mirrors.
#
# ── The ledger, not a wall ───────────────────────────────────────────────────────────
#
# Each mutation declares `expect: caught` or `expect: uncaught`. A mutation marked caught
# that is NOT caught FAILS the gate. A mutation marked uncaught that stays uncaught is
# REPORTED and does not fail the gate, because most of the guards in this repo have no
# control yet and a gate that blocked all work would simply be switched off. The file is
# an honest coverage ledger; `uncaught` entries are the backlog.
#
# The standing rule this enforces: a new security guard ships with a mutation proving its
# control bites. See docs/mutation-testing.md.
#
# ── Concurrency warning ──────────────────────────────────────────────────────────────
#
# tests/integration/support/global-setup.ts sweeps EVERY database matching
# `statesman_test_w%` at startup, including another run's. Two integration suites running
# at once therefore destroy each other's worker databases. This script takes a lock so two
# mutation runs cannot overlap, and warns when worker databases already exist — but it
# cannot stop a plain `npm run test:integration` in another terminal. Do not run both.
#
# Usage:
#   scripts/mutation-check.sh                 baseline + every registered mutation
#   scripts/mutation-check.sh --list          list the registry and exit
#   scripts/mutation-check.sh --only M5,MS1   baseline + just those ids
#   scripts/mutation-check.sh --baseline-only prove the mirror mechanism, run no mutation
#   scripts/mutation-check.sh --as-caught     treat every selected mutation as
#                                             `expect: caught`. This is the gate's own
#                                             negative control: run it on a known-uncaught
#                                             mutation and the gate MUST fail. Never use
#                                             it in CI.
#   scripts/mutation-check.sh --keep          leave the mirrors on disk for inspection
#
# Exit status: 0 the gate passed, 1 the gate failed, 2 the harness itself is broken
# (bad usage, missing tooling, baseline red, a mutation that would not apply).

set -euo pipefail

export LC_ALL="${LC_ALL:-en_US.UTF-8}"                     # V27: the postmaster needs it
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"    # Homebrew PostgreSQL 17.11

REPO="$(cd "$(dirname "$0")/.." && pwd)"
# MUTATION_DIR exists so the gate's OWN negative controls can be kept out of the
# shipped registry: a mutation that is deliberately NOT caught would otherwise fail
# CI forever. See docs/mutation-testing.md, "Proving the gate can fail".
MUT_DIR="${MUTATION_DIR:-$REPO/mutations}"
# The library is NOT swappable with MUTATION_DIR: the registry is data, the applier and
# the reporter parser are the instrument, and an alternate registry must not be able to
# bring its own instrument.
LIB="$REPO/mutations/lib"

# A template name distinct from statesman_test_template. A mutated schema must never be
# able to overwrite the template the developer suite clones from.
TPL="${MUTATION_TEMPLATE_DB:-statesman_mut_tpl}"
ADMIN_DB="${TEST_ADMIN_DB:-postgres}"
ADMIN_ROLE="${TEST_ADMIN_ROLE:-$(id -un)}"
IDENT_RE='^[a-z][a-z0-9_]{0,50}$'

ONLY=''
AS_CAUGHT=0
KEEP=0
BASELINE_ONLY=0
LIST_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --list)          LIST_ONLY=1 ;;
    --only)          shift; ONLY="${1:?--only needs a comma-separated list of ids}" ;;
    --only=*)        ONLY="${1#--only=}" ;;
    --as-caught)     AS_CAUGHT=1 ;;
    --keep)          KEEP=1 ;;
    --baseline-only) BASELINE_ONLY=1 ;;
    -h|--help)       sed -n '1,90p' "$0"; exit 0 ;;
    *)               echo "mutation-check: unknown argument '$1'" >&2; exit 2 ;;
  esac
  shift
done

if ! [[ "$TPL" =~ $IDENT_RE ]]; then
  echo "mutation-check: refusing MUTATION_TEMPLATE_DB='$TPL' — not a safe identifier" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Registry. Self-tests (MS*) run FIRST and deliberately so: they are the gate's own
# positive controls. If MS1 reports anything but CAUGHT, the harness is broken and no
# UNCAUGHT verdict in the same report means anything.
# ---------------------------------------------------------------------------
registry() {
  local f
  for f in "$MUT_DIR"/MS*.mut; do if [ -e "$f" ]; then echo "$f"; fi; done
  for f in "$MUT_DIR"/M[0-9]*.mut; do if [ -e "$f" ]; then echo "$f"; fi; done
  return 0
}

field() { # <mut-file> <field>
  node "$LIB/mutation.mjs" field "$1" "$2"
}

selected() { # <id> — is this id in --only?
  [ -z "$ONLY" ] && return 0
  case ",$ONLY," in *",$1,"*) return 0 ;; esac
  # The MS* self-tests are this gate's own positive controls: MS1 and MS2 are mutations
  # whose catchers MUST fire, so a run in which they did not execute has not shown that
  # the harness can detect anything at all. `--only M5` previously exited 0 with
  # "GATE PASSED" having run exactly one mutation and neither self-test, which is a
  # scoped run reported as a controlled one. --only now narrows the M* registry and
  # always keeps the self-tests.
  case "$1" in MS*) return 0 ;; esac
  return 1
}

if [ "$LIST_ONLY" = 1 ]; then
  printf '%-5s %-9s %s\n' ID EXPECT TITLE
  while IFS= read -r f; do
    printf '%-5s %-9s %s\n' "$(field "$f" id)" "$(field "$f" expect)" "$(field "$f" title)"
  done < <(registry)
  exit 0
fi

# ---------------------------------------------------------------------------
# Preflight. Every tool this script needs, named before anything is built, so a missing
# one is a clear message rather than a confusing mutation verdict.
# ---------------------------------------------------------------------------
missing=''
[ -x "$REPO/node_modules/.bin/vitest" ] || missing="$missing vitest"
[ -f "$REPO/vitest.integration.config.ts" ] || missing="$missing vitest.integration.config.ts"
[ -f "$LIB/mutation.mjs" ] || missing="$missing mutations/lib/mutation.mjs"
[ -f "$LIB/selftest.mjs" ] || missing="$missing mutations/lib/selftest.mjs"
[ -f "$LIB/vitest-summary.mjs" ] || missing="$missing mutations/lib/vitest-summary.mjs"
command -v psql >/dev/null 2>&1 || missing="$missing psql"
command -v node >/dev/null 2>&1 || missing="$missing node"
if [ -n "$missing" ]; then
  echo "mutation-check: cannot run — missing:$missing" >&2
  exit 2
fi

# The applier is an instrument, so it gets a control of its own before it is trusted.
# This is not ceremony: the applier was once silently emptying every single-line @@REPLACE
# block and truncating the first line of every multi-line one, which made mutations apply
# a CORRUPTED edit. The suite went red for the wrong reason and the gate called it
# "MISATTRIBUTED" without being able to say why. Four of these nine checks require the
# applier to report a NEGATIVE; with the bug reintroduced, five of the nine fail.
echo "==> self-testing the mutation applier"
node "$LIB/selftest.mjs"

# Validate every registered mutation before building anything. A syntax error in a .mut
# file found halfway through a run is a waste of a run.
echo "==> validating the mutation registry"
reg_files=''
while IFS= read -r f; do reg_files="$reg_files $f"; done < <(registry)
if [ -z "${reg_files// /}" ]; then
  echo "mutation-check: no mutations registered under $MUT_DIR" >&2
  exit 2
fi
# shellcheck disable=SC2086
node "$LIB/mutation.mjs" validate $reg_files

# ---------------------------------------------------------------------------
# Lock, scratch space, and cleanup that runs even on failure.
# ---------------------------------------------------------------------------
LOCKDIR="${TMPDIR:-/tmp}/statesman-mutation-check.lock"
LOCK_HELD=0
if mkdir "$LOCKDIR" 2>/dev/null; then
  LOCK_HELD=1
else
  echo "mutation-check: another run holds $LOCKDIR." >&2
  echo "  Two integration suites at once destroy each other's worker databases" >&2
  echo "  (global-setup.ts sweeps every statesman_test_w% database at startup)." >&2
  echo "  If no run is active, remove the directory and retry." >&2
  exit 2
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/statesman-mutation.XXXXXX")"

psql_admin() { # catalog reads and DDL as the bootstrap role; never piped
  psql --no-psqlrc -q -A -t -v ON_ERROR_STOP=1 \
       -h 127.0.0.1 -p 5432 -U "$ADMIN_ROLE" -d "$ADMIN_DB" "$@"
}

list_worker_dbs() {
  psql_admin -c "select datname from pg_database where datname like 'statesman_test_w%' order by datname"
}

drop_db() { # <name> — identifier-validated; psql does not parameterise identifiers
  local name="$1"
  if ! [[ "$name" =~ $IDENT_RE ]]; then
    echo "  refusing to drop '$name': not a safe identifier" >&2
    return 0
  fi
  psql_admin -c "drop database if exists \"$name\" with (force)" >/dev/null || true
}

# Worker databases that already existed BEFORE this run. They belong to someone else (a
# crashed run, or — against instructions — a concurrent suite) and are never dropped here.
PRE_EXISTING_WORKERS="$(list_worker_dbs || true)"
if [ -n "$PRE_EXISTING_WORKERS" ]; then
  echo "!!  worker databases already exist; another integration run may be in flight:" >&2
  echo "$PRE_EXISTING_WORKERS" | sed 's/^/      /' >&2   # pipe parses captured text only
  echo "!!  they will NOT be dropped by this run." >&2
fi

cleanup() {
  local status=$?
  set +e
  echo
  echo "==> cleanup"
  drop_db "$TPL"
  local now name
  now="$(list_worker_dbs)"
  for name in $now; do
    case " $PRE_EXISTING_WORKERS " in
      *" $name "*) continue ;;                 # not ours
    esac
    echo "    dropping leftover worker database $name"
    drop_db "$name"
  done
  if [ "$KEEP" = 1 ]; then
    echo "    mirrors kept at $WORK"
  else
    rm -rf "$WORK"
  fi
  [ "$LOCK_HELD" = 1 ] && rmdir "$LOCKDIR" 2>/dev/null
  return $status
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# The mirror
# ---------------------------------------------------------------------------
# node_modules is SYMLINKED: it is large, shared and read-only for our purposes, and
# resolving a dependency through a symlink to the real tree is exactly what we want.
#
# package.json is COPIED, not symlinked, and the distinction is load-bearing. Vite — which
# vitest runs on — resolves the project root by walking up for a package.json and then
# takes its real path. A symlinked package.json can therefore make the REAL repository the
# root, which would silently run the unmutated suite while the harness reported on a
# mutated mirror: every mutation would read as uncaught and the report would be worthless.
# A copy cannot do that. (The MS* self-tests are the standing proof that the mirror is
# what ran: a mutated mirror that goes red cannot be the real repo.)
#
# Everything a mutation may touch is copied, so the real repo is never written to.
# Nothing in the suite resolves a path from the current working directory either: db.ts
# derives REPO_ROOT from import.meta.url and db-template.sh derives ROOT from $0, so both
# land inside the mirror. That is what makes a mirrored run a real run.
make_mirror() { # <dest>
  local dest="$1" d f
  mkdir -p "$dest"
  ln -s "$REPO/node_modules" "$dest/node_modules"
  cp "$REPO/package.json" "$dest/package.json"
  for d in src tests scripts; do
    cp -R "$REPO/$d" "$dest/$d"
  done
  # The migration set moved to supabase/migrations during the port (ADR-0015). Copy ONLY
  # that subtree: supabase/.temp holds the pooler URL, and a mirror has no business
  # carrying a credential. The old top-level migrations/ directory has since been DELETED
  # (it is in git history at commit b3a5f59, and scripts/db-bootstrap.sh, which applied
  # its 0000, is retired), so there is no second set left to copy by accident. When this
  # mirror was still missing supabase/migrations entirely, migrate.sh's refusal to report
  # success over a zero-migration glob is what caught it — rather than a green run over an
  # empty schema, which every posture rule passes trivially (V7).
  mkdir -p "$dest/supabase"
  cp -R "$REPO/supabase/migrations" "$dest/supabase/migrations"
  for f in vitest.integration.config.ts vitest.unit.config.ts tsconfig.json; do
    if [ -f "$REPO/$f" ]; then cp "$REPO/$f" "$dest/$f"; fi
  done
}

# ---------------------------------------------------------------------------
# Running the suite. SUITE_EXIT is the vitest process's own status.
# ---------------------------------------------------------------------------
SUITE_EXIT=0
run_suite() { # <mirror> <logfile> <absolute-json-path>
  local mirror="$1" log="$2" json="$3"
  rm -f "$json"
  # The subshell's output is REDIRECTED, not piped, so $? below is vitest's own status
  # and not some filter's. `set +e` around it because a non-zero exit is the expected
  # result for a caught mutation, not an error in this script.
  set +e
  (
    cd "$mirror" || exit 97
    TEST_TEMPLATE_DB="$TPL" \
    STATESMAN_AI_MODE=unavailable \
    node_modules/.bin/vitest run \
      --config vitest.integration.config.ts \
      --reporter=json \
      --outputFile="$json"
  ) >"$log" 2>&1
  SUITE_EXIT=$?
  set -e
}

# Facts out of the reporter output. Each is read from a string already captured, so the
# pipes here carry no exit status that matters.
SUM_PRESENT=0; SUM_TOTAL=0; SUM_PASSED=0; SUM_FAILED=0; SUM_FILES_FAILED=0
SUM_MATCH=0; SUM_NAMES=''; SUM_REASONS=''; SUM_MISSING=''
summarise() { # <absolute-json-path> <expected-test-substring>...
  local out json="$1"
  shift
  if ! out="$(node "$LIB/vitest-summary.mjs" "$json" "$@")"; then
    echo "mutation-check: the reporter output could not be read" >&2
    return 1
  fi
  SUM_PRESENT="$(printf '%s\n' "$out" | sed -n 's/^json_present=//p')"
  SUM_TOTAL="$(printf '%s\n' "$out" | sed -n 's/^total=//p')"
  SUM_PASSED="$(printf '%s\n' "$out" | sed -n 's/^passed=//p')"
  SUM_FAILED="$(printf '%s\n' "$out" | sed -n 's/^failed=//p')"
  SUM_FILES_FAILED="$(printf '%s\n' "$out" | sed -n 's/^files_failed=//p')"
  SUM_MATCH="$(printf '%s\n' "$out" | sed -n 's/^expected_match=//p')"
  SUM_NAMES="$(printf '%s\n' "$out" | sed -n 's/^failed_test=//p')"
  SUM_REASONS="$(printf '%s\n' "$out" | sed -n 's/^failed_reason=//p')"
  SUM_MISSING="$(printf '%s\n' "$out" | sed -n 's/^expected_missing=//p')"
  local files
  files="$(printf '%s\n' "$out" | sed -n 's/^failed_file=//p')"
  if [ -n "$files" ]; then
    SUM_NAMES="$(printf '%s\n%s' "$SUM_NAMES" "$files")"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# 1. BASELINE. Nothing below is interpretable until this is green.
# ---------------------------------------------------------------------------
echo
echo "========================================================================"
echo " BASELINE — the unmutated suite in a mirror"
echo "========================================================================"
echo "    repo      $REPO"
echo "    template  $TPL"
echo "    scratch   $WORK"

BASE="$WORK/baseline"
make_mirror "$BASE"
BASE_LOG="$WORK/baseline.log"
BASE_JSON="$WORK/baseline.json"
echo "==> running: vitest run --config vitest.integration.config.ts (mirror)"
run_suite "$BASE" "$BASE_LOG" "$BASE_JSON"
summarise "$BASE_JSON" ''

echo "    exit=$SUITE_EXIT  tests=$SUM_TOTAL passed=$SUM_PASSED failed=$SUM_FAILED files_failed=$SUM_FILES_FAILED"

baseline_ok=1
[ "$SUITE_EXIT" = 0 ] || baseline_ok=0
[ "$SUM_PRESENT" = 1 ] || baseline_ok=0
[ "${SUM_FAILED:-1}" = 0 ] || baseline_ok=0
[ "${SUM_FILES_FAILED:-1}" = 0 ] || baseline_ok=0
# A green suite that ran nothing is the failure canon §8 exists to prevent, and
# vitest.integration.config.ts deliberately does not set passWithNoTests.
if [ "${SUM_TOTAL:-0}" -lt 1 ]; then baseline_ok=0; fi

if [ "$baseline_ok" != 1 ]; then
  echo
  echo "BASELINE IS NOT GREEN. No mutation will be run and no verdict would mean"
  echo "anything: a harness that cannot produce a green unmutated suite reports every"
  echo "mutation as caught. Last 60 lines of $BASE_LOG:"
  echo "------------------------------------------------------------------------"
  tail -n 60 "$BASE_LOG" || true
  echo "------------------------------------------------------------------------"
  exit 2
fi
echo "    BASELINE GREEN — $SUM_TOTAL tests, 0 failures. Mutations are now interpretable."

# ---------------------------------------------------------------------------
# 1b. CATCHER SPECIFICITY. Every registered `expect-test:` must identify EXACTLY ONE
# test in the baseline inventory.
#
# `expect-test` is matched as a bare substring against failing test names. Without this
# check a catcher named by the single character 'e' makes the gate print
# "CAUGHT — every named control failed" and "GATE PASSED", because almost any failure
# contains an 'e'. A substring that matches zero tests names a control that does not
# exist (a rename leaves a mutation permanently "uncaught" for the wrong reason); one
# that matches several names no control in particular. Either way the ledger stops being
# evidence, so this is checked ONCE against the green baseline and fails the gate.
# ---------------------------------------------------------------------------
INVENTORY="$WORK/baseline-inventory.txt"
node "$LIB/vitest-summary.mjs" "$BASE_JSON" > "$WORK/baseline-summary.txt"
sed -n 's/^inventory_test=//p' "$WORK/baseline-summary.txt" > "$INVENTORY"
INV_COUNT="$(wc -l < "$INVENTORY" | tr -d ' ')"
if [ "$INV_COUNT" -lt 1 ]; then
  echo "mutation-check: the baseline produced no test inventory, so catcher" >&2
  echo "  specificity cannot be checked. Refusing to run: an unvalidated catcher list" >&2
  echo "  is how a false CAUGHT happens." >&2
  exit 2
fi
echo "    inventory  $INV_COUNT test name(s) recorded from the baseline"

spec_bad=0
while IFS= read -r mf; do
  mid="$(field "$mf" id)"
  while IFS= read -r sub; do
    [ -z "$sub" ] && continue
    [ "$sub" = '#abort' ] && continue
    hits="$(grep -cF -- "$sub" "$INVENTORY" || true)"
    if [ "$hits" != 1 ]; then
      echo "    SPEC FAIL  $mid: expect-test matches $hits baseline tests (need exactly 1):" >&2
      echo "               '$sub'" >&2
      spec_bad=1
    fi
  done <<EOF
$(field "$mf" expect-test)
EOF
done < <(registry)

if [ "$spec_bad" != 0 ]; then
  echo >&2
  echo "CATCHER SPECIFICITY FAILED. At least one expect-test does not identify exactly" >&2
  echo "one test. Fix the .mut files before trusting any verdict from this gate." >&2
  exit 2
fi
echo "    CATCHERS SPECIFIC — every expect-test resolves to exactly one baseline test."
rm -rf "$BASE"

if [ "$BASELINE_ONLY" = 1 ]; then
  echo
  echo "--baseline-only: stopping here. The mirror mechanism works."
  exit 0
fi

# ---------------------------------------------------------------------------
# 2. One mirror per mutation.
# ---------------------------------------------------------------------------
REPORT="$WORK/report.tsv"
: >"$REPORT"
gate_failures=0
gate_warnings=0
ran=0

while IFS= read -r mut; do
  id="$(field "$mut" id)"
  selected "$id" || continue
  title="$(field "$mut" title)"
  expect="$(field "$mut" expect)"
  todo="$(field "$mut" todo)"
  # expect-test is a LIST and EVERY entry must appear among the failures. Each line
  # becomes its own argv element, so a test title with spaces survives intact.
  expect_tests=()
  while IFS= read -r line; do
    if [ -n "$line" ]; then expect_tests+=("$line"); fi
  done <<<"$(field "$mut" 'expect-test')"
  if [ "$AS_CAUGHT" = 1 ]; then expect='caught'; fi
  ran=$((ran + 1))

  echo
  echo "========================================================================"
  echo " $id  [expect: $expect]  $title"
  echo "========================================================================"
  echo "    expected catcher(s), ALL of which must fail:"
  for line in "${expect_tests[@]}"; do echo "      * $line"; done

  mirror="$WORK/$id"
  make_mirror "$mirror"

  # Apply, and REQUIRE it to have applied. Exit 2 from mutation.mjs means the target text
  # was not present the required number of times, i.e. the mutation is stale. That is a
  # hard gate failure: a mutation that did not apply tells us nothing about the guard.
  echo "==> applying mutation"
  if ! node "$LIB/mutation.mjs" apply "$mut" "$mirror"; then
    echo "    NOT-APPLIED — the mutation did not land, so it was never exercised."
    printf '%s\t%s\t%s\t%s\n' NOT-APPLIED "$id" "$expect" "$title" >>"$REPORT"
    gate_failures=$((gate_failures + 1))
    rm -rf "$mirror"
    continue
  fi

  log="$WORK/$id.log"
  json="$WORK/$id.json"
  echo "==> running the integration suite against the mutated mirror"
  run_suite "$mirror" "$log" "$json"
  if ! summarise "$json" "${expect_tests[@]}"; then
    printf '%s\t%s\t%s\t%s\n' BROKEN-REPORT "$id" "$expect" "$title" >>"$REPORT"
    gate_failures=$((gate_failures + 1))
    rm -rf "$mirror"
    continue
  fi

  echo "    exit=$SUITE_EXIT  tests=$SUM_TOTAL passed=$SUM_PASSED failed=$SUM_FAILED files_failed=$SUM_FILES_FAILED  expected_match=$SUM_MATCH"
  if [ -n "$SUM_NAMES" ]; then
    echo "    failing tests:"
    echo "$SUM_NAMES" | sed 's/^/      - /'          # parses captured text only
  fi
  if [ -n "$SUM_REASONS" ]; then
    echo "    first failure message(s):"
    echo "$SUM_REASONS" | sed 's/^/      /'          # parses captured text only
  fi
  if [ -n "$SUM_MISSING" ]; then
    echo "    expected catcher(s) that did NOT fail:"
    echo "$SUM_MISSING" | sed 's/^/      ! /'        # parses captured text only
  fi

  red=0
  if [ "$SUITE_EXIT" != 0 ]; then red=1; fi

  verdict=''
  if [ "$expect" = 'caught' ]; then
    if [ "$red" = 0 ]; then
      verdict='ESCAPED'
      echo "    ESCAPED — the suite stayed GREEN with this guard mutated. The control this"
      echo "    mutation claims does not exist. Either write the test or change the"
      echo "    mutation to 'expect: uncaught' with a todo."
      gate_failures=$((gate_failures + 1))
    elif [ "$SUM_MATCH" = 1 ]; then
      verdict='CAUGHT'
      echo "    CAUGHT — every named control failed."
    else
      verdict='MISATTRIBUTED'
      echo "    MISATTRIBUTED — the suite went red, but at least one named control did"
      echo "    NOT fail (listed above). 'Something failed' is not evidence that the"
      echo "    right thing failed."
      gate_failures=$((gate_failures + 1))
    fi
  else
    if [ "$red" = 0 ]; then
      verdict='UNCAUGHT'
      echo "    UNCAUGHT (known gap) — suite green at $SUM_PASSED/$SUM_TOTAL."
      echo "    TODO: $todo"
    elif [ "$SUM_MATCH" = 1 ]; then
      verdict='PROMOTABLE'
      echo "    PROMOTABLE — a control now EXISTS for this guard: every named catcher"
      echo "    failed. Change this mutation to 'expect: caught' and drop its todo."
    else
      verdict='UNATTRIBUTED'
      echo "    UNATTRIBUTED — the suite went red, but at least one named catcher did"
      echo "    not fail. The guard may have a control under a different name, or this"
      echo "    mutation breaks something unrelated. Update 'expect-test:' and re-run."
      gate_warnings=$((gate_warnings + 1))
    fi
  fi

  printf '%s\t%s\t%s\t%s\n' "$verdict" "$id" "$expect" "$title" >>"$REPORT"
  rm -rf "$mirror"
done < <(registry)

# ---------------------------------------------------------------------------
# 3. Report
# ---------------------------------------------------------------------------
echo
echo "========================================================================"
echo " MUTATION GATE REPORT"
echo "========================================================================"
printf '%-14s %-5s %-9s %s\n' VERDICT ID EXPECT TITLE
while IFS=$'\t' read -r v i e t; do
  printf '%-14s %-5s %-9s %s\n' "$v" "$i" "$e" "$t"
done <"$REPORT"
echo "------------------------------------------------------------------------"
echo "ran $ran mutation(s); gate failures: $gate_failures; warnings: $gate_warnings"

if [ "$ran" = 0 ]; then
  echo "no mutation matched --only '$ONLY'" >&2
  exit 2
fi
if [ "$gate_failures" != 0 ]; then
  echo
  echo "GATE FAILED. A guard marked as controlled is not controlled, or a mutation is"
  echo "stale. Nothing here is a flake to be re-run away: fix the mutation or the test."
  exit 1
fi
echo
echo "GATE PASSED. Every 'expect: caught' mutation was caught by every test it names."
if grep -q "^UNCAUGHT" "$REPORT"; then
  echo "The UNCAUGHT rows above are the coverage backlog. They are not a pass."
fi
if [ "$gate_warnings" != 0 ]; then
  echo "$gate_warnings warning(s): an uncaught mutation went red on an unexpected test."
fi
exit 0
