#!/usr/bin/env bash
# scripts/verify-rest-exposure.sh — prove, over HTTPS, that ALL THREE lifecycle entry points
# in schema `app` are reachable through PostgREST exactly as the browser reaches them, and
# that each is refused or answered by the specific code that proves the path it took.
#
# ===========================================================================
# WHY THIS EXISTS SEPARATELY FROM app.verify_security_posture() / verify_rest_exposure()
# ===========================================================================
# Posture rule E1 reads `pg_roles.rolconfig`. That proves the INTENDED setting is recorded
# in the database. It cannot prove PostgREST is honouring it: the exposed-schema list is
# also project configuration, and if the platform's copy took precedence, rolconfig would
# still name `app` and rule E1 would still pass while every request answered 406. No
# statement executed inside Postgres can see that. One HTTP request can, so this is the
# instrument that does.
#
# This is the project's ONE SMOKE ASSERTION PER TRANSPORT. The components it traverses and
# the main suite does not are listed in docs/transport-blind-spots.md, which is the durable
# artefact; this script is its first entry. ADR-0017 records why the register exists.
#
# ===========================================================================
# WHY ALL THREE FUNCTIONS AND NOT ONE
# ===========================================================================
# ADR-0014 puts the lifecycle write path behind three SECURITY DEFINER functions. An earlier
# version of this script probed only `stamp_milestone`, on the reasoning that the exposed-
# schema list is a property of the schema and therefore one function samples it. That is
# true of the schema list and false of everything else the request crosses:
#
#   * PostgREST resolves RPC by SCHEMA, then by FUNCTION NAME, then by matching the posted
#     JSON KEYS to parameter names, against its own schema cache. Each of those can be
#     stale or wrong per function. `reload config` without `reload schema` leaves exactly
#     this state, measured in ADR-0016: the schema is admitted and the contents are not.
#   * So a probe of one function certifies that one function's cache entry. A signature
#     changed by a later migration — `create or replace` with a new parameter, which this
#     repository has already done twice (20261022170000, then 20261023080000) — leaves the
#     other two answering PGRST202 while the probed one stays green.
#   * The EXECUTE grant is per function, too. `revoke execute on all functions in schema app
#     from public, anon` runs in every migration by the V2/V30 rule, and the three re-grants
#     are three separate lines. Losing one loses one function.
#
# Each function is therefore probed in its own right, with its own argument keys, and graded
# against the ONE code that proves its own body was reached.
#
# ===========================================================================
# THE GRADING TABLE — exact codes, never "not the error I was looking for"
# ===========================================================================
# LEG 1, anonymous (publishable anon key, no user session). All three must answer:
#
#   42501  "permission denied for schema app"   HEALTHY. PostgREST resolved the function in
#          schema `app` from its cache, matched the posted keys to its parameters, and
#          PostgreSQL refused the anonymous role at the SCHEMA boundary — before any policy
#          and before any function body. One answer confirms the exposure, the cached
#          signature, AND the grant-absence that makes the exposure safe.
#   PGRST106 "Invalid schema: app"              THE EXPOSURE IS GONE. The lifecycle write
#          path is unreachable and every submit in the product fails. This is the state the
#          live project was ACTUALLY in before 20261022160000, under a fully green gate run.
#   PGRST202 "...not found in the schema cache" The schema is admitted but THIS function's
#          entry is missing: a stale cache, a renamed function, or a signature that no
#          longer matches the keys the client sends.
#
# LEG 2, authenticated (optional, credentials required). Each function answers a DIFFERENT
# code, and that is the point — see "mutual control" below:
#
#   app.submit_decision  -> ST010  'not a submittable draft'
#   app.append_revision  -> ST011  'not a submitted decision'
#   app.stamp_milestone  -> ST005  'stamp ... affected 0 rows'
#
# A healthy result is an EXPLICIT member of this table, never merely "not PGRST106".
# "Not the error I was looking for" is how a probe comes to pass on a reply it never
# understood; every unrecognised answer below exits non-zero.
#
# ===========================================================================
# THE POSITIVE CONTROLS, AND WHY THE SCRIPT REFUSES TO REPORT WITHOUT THEM
# ===========================================================================
# A probe that can no longer detect the failure it was built for reports success.
#
# LEG 1 control, run PER FUNCTION, before that function is graded: the same request, same
# argument keys, with `Content-Profile:` naming a schema that does not exist and never will.
# That MUST come back PGRST106. Per function rather than once, because the claim being
# controlled is per function: "this request, with these keys, would have told me if schema
# `app` were not served". If any control fails — the endpoint moved, the key is rejected, a
# proxy is answering, the response shape changed — the script cannot tell a missing exposure
# from a present one, and exits non-zero saying so rather than reporting on the real request.
#
# LEG 2 control 1: `stamp_milestone` with an INVALID milestone must return ST012, raised by
# the argument check BEFORE the UPDATE. Two different in-body errors from two different
# inputs is what separates "the body ran" from "something returned an error I recognised".
#
# LEG 2, the MUTUAL property: `submit_decision` and `append_revision` take IDENTICAL argument
# keys and differ only in the body they execute, and ST010 and ST011 are each raised in exactly
# one of the two. So a proxy, a cache collision or a routing fault that sent both calls to one
# function would make the two answers MATCH — and matching means at least one answer is not
# that function's own code, which the per-function exact-match grade rejects. An answer that is
# another entry point's SQLSTATE is reported as a routing fault rather than graded.
#
# LEG 2 control 2 therefore does NOT re-compare the two answers: after the loop that would be
# unfailable, and an assertion that cannot fail is the defect canon §4 names. It checks the one
# thing the loop cannot — that the grading TABLE still offers three distinct codes — and it runs
# before any call is made.
#
# ===========================================================================
# MEASURED: THE TEETH, AND THE PROOF THEY ARE REAL
# ===========================================================================
# Recorded here rather than in a report, because a control nobody can see the result of is
# indistinguishable from one that was never run (canon §4: a test that cannot be made to
# fail has not been shown to work). Runs 0 and A-C below were executed against project
# `onpkspfxfmjkqpomcsse` on 2026-10-23 from `feat/postgrest-transport-smoke`. Run D exercised
# this file's own control-2 block in isolation and reached no network.
#
#   RUN 0 — the real thing, unmodified:                                      exit 0
#     control PGRST106 (http 406) x3, then 42501 (http 401) x3. Leg 2 NOT RUN.
#
#   RUN A — the graded probe pointed at `auth`, a schema that EXISTS on the project but is
#     not in the exposed list. This is a stronger control than a nonexistent schema: it
#     distinguishes "not served" from "not there".                           exit 1
#     -> http 406 PGRST106 -> "THE EXPOSURE IS MISSING". Refused to pass.
#
#   RUN B — the per-function control pointed at `app`, which IS exposed, so the control can
#     no longer detect a missing exposure.                                   exit 1
#     -> control got 42501, not PGRST106 -> "CONTROL FAILED". The script refused to grade
#        the real request at all, which is the behaviour that matters: it does not fall back
#        to reporting on a probe it has just shown it cannot trust.
#
#   RUN C — one function's argument key renamed (`p_milestone` -> `p_milestone_RENAMED`),
#     standing in for a signature changed by a later migration.              exit 1
#     -> submit_decision HEALTHY, append_revision HEALTHY, stamp_milestone http 404
#        PGRST202 "NOT RESOLVED". **Two green and one red in the same run** is the measured
#        reason this script probes all three rather than sampling one: the cache entry and
#        the EXECUTE grant are per function, so one function's verdict is not the schema's.
#
#   RUN D — leg 2's control 2 (the grading table) exercised on its own, by extracting the
#     block from this file and running it against a good table and a broken one, because the
#     leg itself cannot run without credentials.                            exit 0 / exit 1
#     -> three distinct codes: "control OK". Two functions sharing one code: "CONTROL 2
#        FAILED", exit 1. This control replaced an earlier one that compared the two answers
#        AFTER grading them, which could never fail, because the loop already required each
#        answer to equal its own function's code. Recorded because the vacuous version was
#        written here while implementing the rule against vacuous gates.
#
# What is NOT yet measured: every other Leg 2 path. Leg 2 has never been executed, because no
# probe credentials exist on this machine. Its expected codes (ST010/ST011/ST005) are read
# from the function bodies in 20261023080000, which is a reading, not a round trip. The leg
# reports NOT RUN and must not be described as working until someone runs it.
#
# ===========================================================================
# WHY LEG 2 IS SAFE TO RUN AGAINST REAL DATA
# ===========================================================================
# Every call uses an all-zeros decision id and a per-run RANDOM idempotency token.
#
#   submit_decision: the token lookup matches nothing (random), then the draft lookup
#     `where id = $1 and user_id = me and submitted_at is null` matches nothing, and ST010
#     is raised BEFORE the insert. Nothing is written.
#   append_revision: identical shape, ST011 raised BEFORE the insert. Nothing is written.
#   stamp_milestone: the UPDATE runs but is scoped `where id = $1 and user_id = $2`, matches
#     nothing, `get diagnostics` reads 0, and ST005 rolls the statement back. Nothing is
#     written, and no existing row is touched even in principle, because no row has that id.
#
# The token is random per run rather than fixed so that it cannot collide with a token a
# real submission already holds. A collision would make the function return 200 with a
# replayed revision instead of raising, which this script reports as unrecognised — correct,
# but a false alarm worth not manufacturing.
#
# ===========================================================================
# EXIT STATUS, AND THE KEYS
# ===========================================================================
# curl is never piped into head/grep/tail: a pipeline reports the FILTER's status, which is
# how this project has twice read a failure as a success (observation 0463). Each response
# goes to a file and the status is read on its own line.
#
# The anon key is PUBLISHABLE and ships inside the static bundle by design, so reading it
# here leaks nothing. It is still never echoed: a value printed into CI output is a value in
# a log that outlives the reason it was there. The service role key is not read at all. The
# probe password is read from the environment, never echoed, never written to a file, and
# never passed on a command line where `ps` would show it.
#
# Exit 0 only when every control held and every graded answer was the expected one. A leg
# that did not run is reported NOT RUN and is never counted as a pass.
set -uo pipefail

ABSENT_SCHEMA="st_probe_absent_schema"   # never created, so PGRST106 is the only answer
ZERO_ID="00000000-0000-0000-0000-000000000000"
FUNCTIONS="submit_decision append_revision stamp_milestone"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---------------------------------------------------------------------------
# Configuration. Environment first, then the gitignored local file.
# ---------------------------------------------------------------------------
if [[ -z "${NEXT_PUBLIC_SUPABASE_URL:-}" || -z "${NEXT_PUBLIC_SUPABASE_ANON_KEY:-}" ]]; then
  ENV_FILE="${STATESMAN_ENV_FILE:-.env.supabase.local}"
  if [[ -r "$ENV_FILE" ]]; then
    set -o allexport
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +o allexport
  fi
fi

if [[ -z "${NEXT_PUBLIC_SUPABASE_URL:-}" || -z "${NEXT_PUBLIC_SUPABASE_ANON_KEY:-}" ]]; then
  echo "verify-rest-exposure: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY" >&2
  echo "  are required. Set them in the environment, in .env.supabase.local, or point" >&2
  echo "  STATESMAN_ENV_FILE at a readable file holding them." >&2
  echo "  This check speaks to the live project and is deliberately NOT part of" >&2
  echo "  'npm run gates', which must pass with no credentials and no network." >&2
  exit 2
fi

# A random token per run. See "why leg 2 is safe" above.
PROBE_TOKEN="$(python3 -c 'import uuid; print(uuid.uuid4())')"
if [[ -z "$PROBE_TOKEN" ]]; then
  echo "verify-rest-exposure: could not generate an idempotency token." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Per-function request bodies. The KEYS must match the function's parameter names
# exactly, or PostgREST answers PGRST202 before PostgreSQL is ever asked — which is
# itself one of the faults this script is here to catch, so the keys are spelled out
# rather than generated.
# ---------------------------------------------------------------------------
body_for () {
  case "$1" in
    submit_decision|append_revision)
      printf '{"p_decision_id":"%s","p_token":"%s","p_content":{},"p_confidence":3,' \
        "$ZERO_ID" "$PROBE_TOKEN"
      printf '"p_forecast":"probe","p_horizon":"probe","p_rationale":"probe"}'
      ;;
    stamp_milestone)
      printf '{"p_decision_id":"%s","p_milestone":"challenged"}' "$ZERO_ID"
      ;;
    *) echo "body_for: unknown function '$1'" >&2; return 1 ;;
  esac
}

# The one in-body SQLSTATE that proves THIS function's body executed.
expected_authed_code () {
  case "$1" in
    submit_decision) echo "ST010" ;;   # 'not a submittable draft'
    append_revision) echo "ST011" ;;   # 'not a submitted decision'
    stamp_milestone) echo "ST005" ;;   # 'stamp ... affected 0 rows'
    *) echo "<unknown>" ; return 1 ;;
  esac
}

probe () {        # $1=schema $2=function $3=outfile [$4=bearer] [$5=body override]
  local _body
  if [[ -n "${5:-}" ]]; then _body="$5"; else _body="$(body_for "$2")" || return 1; fi
  curl -sS --max-time 20 -o "$3" -w '%{http_code}' \
    -X POST "${NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/$2" \
    -H "apikey: ${NEXT_PUBLIC_SUPABASE_ANON_KEY}" \
    -H "Authorization: Bearer ${4:-${NEXT_PUBLIC_SUPABASE_ANON_KEY}}" \
    -H "Content-Profile: $1" \
    -H "Content-Type: application/json" \
    -d "$_body"
}

code_of () {                     # the PostgREST/PostgreSQL error code, or '<none>'
  python3 -c '
import json, sys
try:
    with open(sys.argv[1]) as f:
        print(json.load(f).get("code", "<none>"))
except Exception:
    print("<unparseable>")
' "$1"
}

# ===========================================================================
# LEG 1 — anonymous. Each function: its own control, then its own grade.
# ===========================================================================
echo "=================================================================="
echo " LEG 1 — anonymous, publishable key, no user session"
echo "=================================================================="
for fn in $FUNCTIONS; do
  echo "==> $fn — control: schema '$ABSENT_SCHEMA' must be refused as PGRST106"
  ctl_http="$(probe "$ABSENT_SCHEMA" "$fn" "$TMP/ctl.$fn.json")"
  ctl_rc=$?
  if [[ $ctl_rc -ne 0 ]]; then
    echo "verify-rest-exposure: the control request for $fn failed (curl exit $ctl_rc)." >&2
    echo "  Nothing about the real request can be concluded. NOT a pass." >&2
    exit 1
  fi
  ctl_code="$(code_of "$TMP/ctl.$fn.json")"
  echo "    http=$ctl_http code=$ctl_code"
  if [[ "$ctl_code" != "PGRST106" ]]; then
    echo "verify-rest-exposure: CONTROL FAILED for $fn." >&2
    echo "  Asking for schema '$ABSENT_SCHEMA' with ${fn}'s argument keys returned" >&2
    echo "  '$ctl_code', not PGRST106. This probe can therefore no longer distinguish an" >&2
    echo "  exposed schema from an unexposed one, so its verdict on schema app would be" >&2
    echo "  meaningless. Fix the probe before trusting any result from it." >&2
    exit 1
  fi
  echo "    control OK — a missing exposure is detectable for this call"

  echo "==> $fn — probe: schema app, anon key"
  app_http="$(probe app "$fn" "$TMP/app.$fn.json")"
  app_rc=$?
  if [[ $app_rc -ne 0 ]]; then
    echo "verify-rest-exposure: the probe request for $fn failed (curl exit $app_rc)." >&2
    exit 1
  fi
  app_code="$(code_of "$TMP/app.$fn.json")"
  echo "    http=$app_http code=$app_code"

  case "$app_code" in
    42501)
      echo "    HEALTHY: app.$fn is served, its cached signature matches the keys sent,"
      echo "             and the anonymous role is refused at the schema boundary before"
      echo "             any policy or function body runs."
      ;;
    PGRST106)
      echo "verify-rest-exposure: THE EXPOSURE IS MISSING." >&2
      echo "  Schema app is not served by PostgREST, so app.submit_decision," >&2
      echo "  app.append_revision and app.stamp_milestone cannot be called from the" >&2
      echo "  browser and every submit in the product fails." >&2
      echo "  Posture rule E1 may still be passing: it reads rolconfig, which records the" >&2
      echo "  intent, while this reads what PostgREST actually serves. Re-apply" >&2
      echo "  20261022160000, or set Exposed schemas in the project API settings." >&2
      exit 1
      ;;
    PGRST202)
      echo "verify-rest-exposure: SCHEMA ADMITTED BUT app.$fn NOT RESOLVED." >&2
      echo "  PostgREST searched schema app and did not match $fn with the argument keys" >&2
      echo "  this script sent. Either the schema cache is stale — measured: 'notify pgrst," >&2
      echo "  reload config' alone leaves exactly this state, and 'reload schema' clears" >&2
      echo "  it — or the function's signature changed and the client's keys no longer fit." >&2
      echo "  Note that the other two entry points may well be answering 42501: a cache" >&2
      echo "  entry and a grant are both per function." >&2
      exit 1
      ;;
    *)
      echo "verify-rest-exposure: UNRECOGNISED RESPONSE for $fn (code '$app_code', http $app_http)." >&2
      echo "  Reported as a failure rather than a pass: an answer this script does not" >&2
      echo "  understand is not evidence that the exposure is healthy." >&2
      exit 1
      ;;
  esac
done
echo
echo "LEG 1 RESULT: all three lifecycle entry points are served over HTTPS and all three"
echo "              refuse an anonymous caller at the schema boundary (42501)."

# ===========================================================================
# LEG 2 — authenticated. OPTIONAL, and the only thing that proves the path WORKS.
# ===========================================================================
# WHAT LEG 1 DOES NOT ESTABLISH. `42501 permission denied for schema app` proves the schema
# is served and that an anonymous caller is refused. It does NOT prove a signed-in user can
# actually call the lifecycle RPCs. Those are different claims. The catalogue says the
# privilege chain is there: `authenticated` holds USAGE on schema `app` and EXECUTE on all
# three entry points, measured. But a privilege reading is not a round trip, and this
# project's own rule is that the two are not interchangeable.
#
# So this leg runs when, and only when, credentials are supplied in the environment:
#
#   STATESMAN_PROBE_EMAIL=owner@example.com STATESMAN_PROBE_PASSWORD=... \
#     bash scripts/verify-rest-exposure.sh
#
# It is skipped loudly otherwise. A skipped leg is reported as NOT RUN and never as a pass.
if [[ -n "${STATESMAN_PROBE_EMAIL:-}" && -n "${STATESMAN_PROBE_PASSWORD:-}" ]]; then
  echo
  echo "=================================================================="
  echo " LEG 2 — authenticated as ${STATESMAN_PROBE_EMAIL}"
  echo "=================================================================="

  login_http="$(printf '%s' "$(python3 -c '
import json, os
print(json.dumps({"email": os.environ["STATESMAN_PROBE_EMAIL"],
                  "password": os.environ["STATESMAN_PROBE_PASSWORD"]}))
')" | curl -sS --max-time 20 -o "$TMP/login.json" -w '%{http_code}' \
        -X POST "${NEXT_PUBLIC_SUPABASE_URL}/auth/v1/token?grant_type=password" \
        -H "apikey: ${NEXT_PUBLIC_SUPABASE_ANON_KEY}" \
        -H "Content-Type: application/json" --data-binary @-)"
  login_rc=$?
  if [[ $login_rc -ne 0 ]]; then
    echo "verify-rest-exposure: the sign-in request failed (curl exit $login_rc)." >&2
    exit 1
  fi
  if [[ "$login_http" != "200" ]]; then
    echo "verify-rest-exposure: SIGN-IN FAILED (http $login_http)." >&2
    echo "  $(python3 -c '
import json,sys
try:
    d=json.load(open(sys.argv[1])); print(d.get("error_code") or d.get("error"), "-", d.get("msg") or d.get("error_description"))
except Exception: print("<unparseable response>")
' "$TMP/login.json")" >&2
    echo "  The authenticated leg could not run. This is NOT a pass." >&2
    exit 1
  fi

  TOKEN="$(python3 -c '
import json, sys
print(json.load(open(sys.argv[1])).get("access_token", ""))
' "$TMP/login.json")"
  if [[ -z "$TOKEN" ]]; then
    echo "verify-rest-exposure: sign-in returned 200 with no access_token." >&2
    exit 1
  fi
  echo "    signed in (token withheld from output)"

  # ---- control 1: an in-body argument check must fire, proving bodies are entered ----
  echo "==> control 1: stamp_milestone with an invalid milestone must raise ST012 in-body"
  ctl2_http="$(probe app stamp_milestone "$TMP/authctl.json" "$TOKEN" \
    "{\"p_decision_id\":\"$ZERO_ID\",\"p_milestone\":\"not_a_milestone\"}")"
  ctl2_code="$(code_of "$TMP/authctl.json")"
  echo "    http=$ctl2_http code=$ctl2_code"
  if [[ "$ctl2_code" != "ST012" ]]; then
    echo "verify-rest-exposure: AUTHENTICATED CONTROL 1 FAILED." >&2
    echo "  An invalid milestone returned '$ctl2_code', not ST012. The function body's" >&2
    echo "  argument check was not reached, so an ST005 from the next call could not be" >&2
    echo "  attributed to the body either. NOT a pass." >&2
    exit 1
  fi
  echo "    control OK — function bodies are being entered and their checks run"

  # ---- control 2: the grading table must be able to tell the three apart ----
  # WHY THIS IS HERE AND NOT AFTER THE CALLS. The first version of this control compared
  # submit_decision's answer with append_revision's AFTER both were graded, and asserted they
  # differed. That assertion could never fail: the loop below exits non-zero unless each
  # function returns its OWN expected code, so by the time such a comparison ran the two
  # answers were already known to be ST010 and ST011. It was a gate that exercised nothing —
  # the exact defect canon §4 names, written while implementing the rule against it.
  #
  # The response-level mutual property is enforced INSIDE the loop, and genuinely: each answer
  # must equal that function's own code, and an answer that is another entry point's SQLSTATE
  # is reported as a routing fault rather than graded. submit_decision and append_revision take
  # IDENTICAL argument keys and differ only in the body they run, so a proxy, a cache collision
  # or a misdirected route would make their answers match — and matching means at least one of
  # them is not its own code, which the loop rejects.
  #
  # What that leaves unprotected is the TABLE: if `expected_authed_code` ever returned the same
  # code for two functions, the loop would pass them both while discriminating nothing, silently.
  # That is the claim worth controlling, it is checked before any call is made, and it can fail.
  echo "==> control 2: the three expected in-body codes must be pairwise distinct"
  want_list=""
  for fn in $FUNCTIONS; do want_list="$want_list $(expected_authed_code "$fn")"; done
  n_want=$(printf '%s\n' $want_list | wc -l | tr -d ' ')
  n_uniq=$(printf '%s\n' $want_list | sort -u | wc -l | tr -d ' ')
  echo "    expecting:$want_list  ($n_want codes, $n_uniq distinct)"
  if [[ "$n_want" -ne 3 || "$n_uniq" -ne 3 ]]; then
    echo "verify-rest-exposure: CONTROL 2 FAILED." >&2
    echo "  The grading table offers $n_uniq distinct codes for $n_want functions, so a" >&2
    echo "  misdirected route that sent two calls to one function would be graded as healthy." >&2
    echo "  The table cannot discriminate, so nothing graded against it would mean anything." >&2
    exit 1
  fi
  echo "    control OK — three identical request shapes are graded by three distinct codes,"
  echo "    so two calls reaching one body cannot both pass"

  # ---- the three graded calls ----
  authed_codes=""
  for fn in $FUNCTIONS; do
    want="$(expected_authed_code "$fn")"
    echo "==> $fn — signed-in call on a nonexistent decision (expect $want, writes nothing)"
    a_http="$(probe app "$fn" "$TMP/authed.$fn.json" "$TOKEN")"
    a_rc=$?
    if [[ $a_rc -ne 0 ]]; then
      echo "verify-rest-exposure: the authenticated request for $fn failed (curl $a_rc)." >&2
      exit 1
    fi
    a_code="$(code_of "$TMP/authed.$fn.json")"
    echo "    http=$a_http code=$a_code"
    authed_codes="$authed_codes $fn=$a_code"

    if [[ "$a_code" == "$want" ]]; then
      echo "    HEALTHY: a signed-in user reached app.$fn, app.require_user_id() resolved"
      echo "             an identity, and $want was raised from inside the body. Nothing written."
      continue
    fi

    case "$a_code" in
      42501)
        echo "verify-rest-exposure: the SIGNED-IN user was refused at the schema boundary" >&2
        echo "  calling app.$fn. Either authenticated holds no USAGE on schema app, the" >&2
        echo "  EXECUTE grant on this one function was lost — it is a separate GRANT line," >&2
        echo "  stripped by the V2/V30 revoke in every migration — or PostgREST did not" >&2
        echo "  resolve the JWT to the authenticated role. The write path is dead for real" >&2
        echo "  users on this function." >&2
        exit 1
        ;;
      ST010|ST011|ST005)
        echo "verify-rest-exposure: ROUTING FAULT — app.$fn answered '$a_code', which is" >&2
        echo "  another entry point's SQLSTATE, not its own ('$want')." >&2
        echo "  submit_decision and append_revision take identical argument keys and differ" >&2
        echo "  only in the body they run, so their two codes are each other's control: if a" >&2
        echo "  proxy, a cache collision or a misdirected route sent both calls to one" >&2
        echo "  function, the answers would match. They did. Graded as a failure." >&2
        exit 1
        ;;
      *)
        echo "verify-rest-exposure: UNRECOGNISED authenticated response for $fn ('$a_code')." >&2
        echo "  Reported as a failure: an answer this script does not understand is not" >&2
        echo "  evidence that the write path works." >&2
        exit 1
        ;;
    esac
  done


  echo
  echo "=================================================================="
  echo "RESULT: exposure healthy on all three entry points; anon refused at the door;"
  echo "        a signed-in caller reaches all three function bodies. Codes:$authed_codes"
  echo "=================================================================="
  exit 0
else
  echo
  echo "=================================================================="
  echo " LEG 2 — authenticated: NOT RUN"
  echo "=================================================================="
  echo "    No STATESMAN_PROBE_EMAIL / STATESMAN_PROBE_PASSWORD in the environment."
  echo "    PROVEN so far: all three lifecycle entry points are served over HTTPS, their"
  echo "    cached signatures match the keys the client sends, and an anonymous caller is"
  echo "    refused at the schema boundary."
  echo "    NOT PROVEN: that a signed-in user can execute them. Those are different claims."
  echo "    The catalogue says authenticated holds USAGE on app and EXECUTE on the three"
  echo "    entry points, but a privilege reading is not a round trip."
  echo "    To close it, re-run with those two variables set."
  exit 0
fi
