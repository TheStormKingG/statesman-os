#!/usr/bin/env bash
# scripts/verify-rest-exposure.sh — prove, over HTTP, that schema `app` is reachable
# through PostgREST and that an anonymous caller is refused at the schema boundary.
#
# ===========================================================================
# WHY THIS EXISTS SEPARATELY FROM app.verify_rest_exposure()
# ===========================================================================
# Posture rule E1 reads `pg_roles.rolconfig`. That proves the INTENDED setting is recorded
# in the database. It cannot prove PostgREST is honouring it: the exposed-schema list is
# also project configuration, and if the platform's copy took precedence, rolconfig would
# still name `app` and rule E1 would still pass while every request answered 406. No
# statement executed inside Postgres can see that. One HTTP request can, so this is the
# instrument that does.
#
# ===========================================================================
# WHAT THE ONE REQUEST DISTINGUISHES — three states, not two
# ===========================================================================
# POST /rest/v1/rpc/stamp_milestone with `Content-Profile: app`, using the PUBLISHABLE anon
# key and no user session. All three outcomes were observed during the work that added this:
#
#   42501  "permission denied for schema app"   HEALTHY. PostgREST resolved the function in
#          schema `app` and PostgreSQL refused the anonymous role at the schema boundary,
#          before any policy and before any function body. This single answer confirms the
#          exposure AND the grant-absence that makes it safe.
#   PGRST106 "Invalid schema: app"              THE EXPOSURE IS GONE. The lifecycle write
#          path is unreachable and every submit in the product fails. This is the state the
#          live project was ACTUALLY in before 20261022160000.
#   PGRST202 "...not found in the schema cache" The schema is admitted but its contents are
#          not cached, or the function is missing. Measured once: `notify pgrst, 'reload
#          config'` alone leaves exactly this state, and `reload schema` clears it.
#
# A healthy result is therefore an EXPLICIT 42501, never merely "not PGRST106". "Not the
# error I was looking for" is how a probe comes to pass on a reply it never understood.
#
# ===========================================================================
# THE POSITIVE CONTROL, AND WHY THE SCRIPT REFUSES TO REPORT WITHOUT IT
# ===========================================================================
# A probe that can no longer detect the failure it was built for reports success. So before
# grading the real request, the same request is sent with `Content-Profile:` naming a schema
# that does not exist and never will. That MUST come back PGRST106. If it does not — the
# endpoint moved, the key is rejected, a proxy is answering, the response shape changed —
# then this script cannot tell a missing exposure from a present one, and it exits non-zero
# saying so rather than reporting on the real request.
#
# ===========================================================================
# EXIT STATUS, AND THE KEY
# ===========================================================================
# curl is never piped into head/grep/tail: a pipeline reports the FILTER's status, which is
# how this project has twice read a failure as a success (observation 0463). Each response
# goes to a file and the status is read on its own line.
#
# The anon key is PUBLISHABLE and ships inside the static bundle by design, so reading it
# here leaks nothing. It is still never echoed: a value printed into CI output is a value in
# a log that outlives the reason it was there. The service role key is not read at all.
set -uo pipefail

PROBE_FN="stamp_milestone"
ABSENT_SCHEMA="st_probe_absent_schema"   # never created, so PGRST106 is the only answer
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
  echo "  are required. Set them in the environment or in .env.supabase.local." >&2
  echo "  This check speaks to the live project and is deliberately NOT part of" >&2
  echo "  'npm run gates', which must pass with no credentials and no network." >&2
  exit 2
fi

probe () {                       # $1 = schema, $2 = output file; echoes the HTTP status
  curl -sS --max-time 20 -o "$2" -w '%{http_code}' \
    -X POST "${NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/${PROBE_FN}" \
    -H "apikey: ${NEXT_PUBLIC_SUPABASE_ANON_KEY}" \
    -H "Authorization: Bearer ${NEXT_PUBLIC_SUPABASE_ANON_KEY}" \
    -H "Content-Profile: $1" \
    -H "Content-Type: application/json" \
    -d '{"p_decision_id":"00000000-0000-0000-0000-000000000000","p_milestone":"challenged"}'
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

# ---------------------------------------------------------------------------
# 1. The positive control, FIRST. Nothing is graded until the probe is trusted.
# ---------------------------------------------------------------------------
echo "==> control: a schema that does not exist must be refused as PGRST106"
ctl_http="$(probe "$ABSENT_SCHEMA" "$TMP/ctl.json")"
ctl_rc=$?
if [[ $ctl_rc -ne 0 ]]; then
  echo "verify-rest-exposure: the control request itself failed (curl exit $ctl_rc)." >&2
  echo "  Nothing about the real request can be concluded. NOT a pass." >&2
  exit 1
fi
ctl_code="$(code_of "$TMP/ctl.json")"
echo "    http=$ctl_http code=$ctl_code"
if [[ "$ctl_code" != "PGRST106" ]]; then
  echo "verify-rest-exposure: CONTROL FAILED." >&2
  echo "  Asking for schema '$ABSENT_SCHEMA' returned '$ctl_code', not PGRST106." >&2
  echo "  This probe can therefore no longer distinguish an exposed schema from an" >&2
  echo "  unexposed one, so its verdict on schema app would be meaningless. Fix the" >&2
  echo "  probe before trusting any result from it." >&2
  exit 1
fi
echo "    control OK — a missing exposure is detectable"

# ---------------------------------------------------------------------------
# 2. The real request.
# ---------------------------------------------------------------------------
echo "==> probe: schema app, anon key, no user session"
app_http="$(probe app "$TMP/app.json")"
app_rc=$?
if [[ $app_rc -ne 0 ]]; then
  echo "verify-rest-exposure: the probe request failed (curl exit $app_rc)." >&2
  exit 1
fi
app_code="$(code_of "$TMP/app.json")"
echo "    http=$app_http code=$app_code"

case "$app_code" in
  42501)
    echo "    HEALTHY: schema app is served, and the anonymous role is refused at the"
    echo "             schema boundary before any policy or function body runs."
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
    echo "verify-rest-exposure: SCHEMA ADMITTED BUT NOT CACHED." >&2
    echo "  PostgREST searched schema app and found no ${PROBE_FN}. Either the schema" >&2
    echo "  cache is stale — measured: 'notify pgrst, reload config' alone leaves exactly" >&2
    echo "  this state, and 'reload schema' clears it — or the function is absent." >&2
    exit 1
    ;;
  *)
    echo "verify-rest-exposure: UNRECOGNISED RESPONSE (code '$app_code', http $app_http)." >&2
    echo "  Reported as a failure rather than a pass: an answer this script does not" >&2
    echo "  understand is not evidence that the exposure is healthy." >&2
    exit 1
    ;;
esac
# ---------------------------------------------------------------------------
# 3. The authenticated leg — OPTIONAL, and the only thing that proves the path WORKS.
# ---------------------------------------------------------------------------
# WHAT LEG 2 DOES NOT ESTABLISH. `42501 permission denied for schema app` proves the schema
# is served and that an anonymous caller is refused. It does NOT prove a signed-in user can
# actually call the lifecycle RPCs. Those are different claims, and only one of them was
# provable when this script was written: no account existed on the project, and creating one
# — or setting a password — is the owner's action, not this script's.
#
# The catalogue says the privilege chain is there: `authenticated` holds USAGE on schema
# `app` and EXECUTE on all three entry points, measured. But a privilege reading is not a
# round trip, and this project's own rule is that the two are not interchangeable.
#
# So this leg runs when, and only when, credentials are supplied in the environment:
#
#   STATESMAN_PROBE_EMAIL=owner@example.com STATESMAN_PROBE_PASSWORD=... \
#     bash scripts/verify-rest-exposure.sh
#
# It is skipped loudly otherwise. A skipped leg is reported as NOT RUN and never as a pass.
#
# WHY IT IS SAFE TO RUN AGAINST REAL DATA. It calls `app.stamp_milestone` with an all-zeros
# decision id. Inside the function the UPDATE is scoped `where id = $1 and user_id = $2`, so
# it matches nothing, `get diagnostics` reads 0, and the function raises ST005 — which rolls
# the statement back. Nothing is written, and no existing row is touched even in principle,
# because no row has that id.
#
# WHY ST005 IS THE PROOF. ST005 is OUR OWN SQLSTATE, raised from inside the function body
# after `app.require_user_id()` resolved an identity and after the UPDATE ran. PostgREST
# cannot produce it, a permission failure cannot produce it, and a stale schema cache cannot
# produce it. It is only reachable by the body executing.
#
# ITS OWN CONTROL: a second call with an INVALID milestone must return ST012, raised BEFORE
# the UPDATE by the argument check. Two different in-body errors from two different inputs
# is what distinguishes "the body ran" from "something returned an error I recognised".
if [[ -n "${STATESMAN_PROBE_EMAIL:-}" && -n "${STATESMAN_PROBE_PASSWORD:-}" ]]; then
  echo "==> authenticated leg: signing in as ${STATESMAN_PROBE_EMAIL}"

  # The password is read from the environment and never echoed, never written to a file, and
  # never passed on a command line where `ps` would show it: curl reads the body from stdin.
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

  authed_probe () {              # $1 = milestone, $2 = output file
    curl -sS --max-time 20 -o "$2" -w '%{http_code}' \
      -X POST "${NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/${PROBE_FN}" \
      -H "apikey: ${NEXT_PUBLIC_SUPABASE_ANON_KEY}" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "Content-Profile: app" \
      -H "Content-Type: application/json" \
      -d "{\"p_decision_id\":\"00000000-0000-0000-0000-000000000000\",\"p_milestone\":\"$1\"}"
  }

  echo "==> authenticated control: an invalid milestone must be rejected IN THE BODY (ST012)"
  ctl2_http="$(authed_probe "not_a_milestone" "$TMP/authctl.json")"
  ctl2_code="$(code_of "$TMP/authctl.json")"
  echo "    http=$ctl2_http code=$ctl2_code"
  if [[ "$ctl2_code" != "ST012" ]]; then
    echo "verify-rest-exposure: AUTHENTICATED CONTROL FAILED." >&2
    echo "  An invalid milestone returned '$ctl2_code', not ST012. The function body's" >&2
    echo "  argument check was not reached, so a ST005 from the next call could not be" >&2
    echo "  attributed to the body either. NOT a pass." >&2
    exit 1
  fi
  echo "    control OK — the function body is being entered and its checks run"

  echo "==> authenticated probe: a valid milestone on a nonexistent decision (expect ST005)"
  auth_http="$(authed_probe "challenged" "$TMP/authed.json")"
  auth_code="$(code_of "$TMP/authed.json")"
  echo "    http=$auth_http code=$auth_code"
  case "$auth_code" in
    ST005)
      echo "    HEALTHY: a signed-in user reached app.stamp_milestone, identity resolved,"
      echo "             and the row-count assertion fired because no such decision exists."
      echo "             The lifecycle write path is reachable end to end. Nothing written."
      ;;
    42501)
      echo "verify-rest-exposure: the SIGNED-IN user was refused at the schema boundary." >&2
      echo "  authenticated holds no USAGE on schema app, or PostgREST did not resolve the" >&2
      echo "  JWT to the authenticated role. The write path is dead for real users." >&2
      exit 1
      ;;
    *)
      echo "verify-rest-exposure: UNRECOGNISED authenticated response ('$auth_code')." >&2
      echo "  Reported as a failure: an answer this script does not understand is not" >&2
      echo "  evidence that the write path works." >&2
      exit 1
      ;;
  esac
  echo
  echo "RESULT: exposure healthy, anon refused at the door, signed-in caller reaches the body."
  exit 0
else
  echo
  echo "==> authenticated leg: NOT RUN"
  echo "    No STATESMAN_PROBE_EMAIL / STATESMAN_PROBE_PASSWORD in the environment."
  echo "    PROVEN so far: schema app is served, and an anonymous caller is refused at the"
  echo "    schema boundary. NOT PROVEN: that a signed-in user can execute the lifecycle"
  echo "    RPCs. Those are different claims. The catalogue says authenticated holds USAGE"
  echo "    on app and EXECUTE on the three entry points, but a privilege reading is not a"
  echo "    round trip."
  echo "    To close it, create the owner account and re-run with those two variables set."
  exit 0
fi

