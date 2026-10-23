# Transport blind spots — what the gate suite does not traverse

**Owner.** This file owns the blind-spot register and the `TBS-nn` identifiers. ADR-0017
records the decision that created it. Nothing else defines a `TBS` id; a document that names
one not listed here is the document to change (canon §12, one owner per namespace).

## Why this file exists

On 2026-10-22 the product had no working submit button. Schema `app` was never added to the
project's PostgREST exposed-schema list, so every call from a browser answered
`PGRST106 Invalid schema: app`. The only legal writer of `submitted_at` could not be invoked
at all.

Over exactly that state, `bash scripts/gates.sh` reported **133 tests passed** and the
mutation gate reported **zero escapes**. The tests were not weak — every denial is paired
with an after-state read, every guard is proven killable by a registered mutation. They were
all simply on the other side of the fault. The integration suite connects to PostgreSQL with
`psql`, and a direct database connection never consults PostgREST's exposed-schema list, so
no assertion any of those tests could make would ever have been affected by the defect.

The fault was found by hand, by sending one HTTP request while wiring a screen.

The requirement was even known beforehand. `src/lib/supabase/client.ts` carried a comment
saying the schema had to be exposed, marked `UNVERIFIED`, written by a task that was
forbidden from contacting the project. **The knowledge existed; nothing executable depended
on it.**

### The general rule, which is the reason for a register rather than one more test

**A suite's blind spot is exactly the set of components it does not traverse.** A suite that
connects by a privileged, direct or in-process channel — for speed, or because that is the
only channel available offline — has chosen a different path than the user takes. Everything
on the production path and not on the test path is invisible, and **its absence is
indistinguishable from its correctness**.

No coverage percentage can show this, because the uncovered component has no lines in this
repository. A green run is therefore evidence about the slice of the system the harness
happens to touch, and a register is the only artefact that says which slice that is.

## How to read a row

- **TBS-nn** — stable identifier. Numbers are never reused.
- **Status** is a design status, not a run outcome: `COVERED` (a smoke check exists and is
  committed), `OPEN` (named, nothing executable depends on it), `ACCEPTED` (named and
  deliberately not closed, with the reason). Per canon §9, `PASS`, `FAIL` and `NOT RUN` are
  outcomes of an execution and are **not** representable here; they live in volatile
  `reports/` and in the output of the check itself.
- A `COVERED` row names the command. `COVERED` means a check exists, **not** that it ran.

## The register

| id | Component on the production path | Why the gate suite cannot see it | Status | Instrument |
|---|---|---|---|---|
| **TBS-01** | PostgREST's **exposed-schema list** | The integration suite speaks the PostgreSQL wire protocol directly; the schema list is PostgREST configuration and no SQL statement can read what the gateway is serving. Posture rule E1 reads `pg_roles.rolconfig`, which is the recorded *intent* — it would still pass if the platform's own copy took precedence. | **COVERED** | `bash scripts/verify-rest-exposure.sh` leg 1 |
| **TBS-02** | PostgREST's **per-function schema cache and signature match** | PostgREST resolves an RPC by schema, then name, then by matching posted JSON keys to parameter names, against a cache it builds itself. `notify pgrst, 'reload config'` without `reload schema` leaves the schema admitted and its contents absent (measured, ADR-0016). A `create or replace` that changes a signature — done twice in this repository — breaks the client's keys with no SQL error. | **COVERED** | same script, leg 1, probing **all three** entry points. Measured: renaming one key left two functions green and one red in the same run. |
| **TBS-03** | The **`EXECUTE` grant as the gateway exercises it**, per function | Every migration runs `revoke execute on all functions in schema app from public, anon` by the V2/V30 rule, and the three re-grants are three separate `GRANT` lines. The suite's role is `statesman_app`, not `anon`/`authenticated`, so it never exercises the grant the browser's key resolves to. | **COVERED** (anon refusal) / **OPEN** (authenticated grant) | leg 1 proves `anon` is refused at the schema boundary (`42501`). Leg 2 would prove `authenticated` is admitted — see TBS-04. |
| **TBS-04** | The **JWT-to-role mapping**: that a signed-in user's token resolves to `authenticated` and reaches the function bodies | The suite sets identity by writing the GUC a JWT *would* populate — `set_config('request.jwt.claim.sub', ...)` on a direct connection (verified: every `jwt` reference under `tests/` is that GUC or its JSON sibling `request.jwt.claims`). So the suite exercises everything downstream of the claim and **nothing that produces it**: no test signs in, presents a token, or causes a token to be verified and mapped to a role. The catalogue says `authenticated` holds `USAGE` on `app` and `EXECUTE` on all three entry points — **a privilege reading is not a round trip.** | **OPEN** | `scripts/verify-rest-exposure.sh` leg 2 exists and has **never been executed**: it needs `STATESMAN_PROBE_EMAIL` / `STATESMAN_PROBE_PASSWORD`, and no account credential exists on this machine. It reports **NOT RUN**. Its expected codes (`ST010`/`ST011`/`ST005`) are read from the function bodies, not observed. |
| **TBS-05** | **TLS and the hostname** the browser actually connects to | Every local connection is plaintext over a unix socket or loopback with `pg_hba.conf` set to `trust` (V1). Nothing in the suite performs a TLS handshake or validates a certificate. | **ACCEPTED** | Leg 1 reaches the project over HTTPS, so a total TLS failure would surface as a curl error rather than a pass. Certificate pinning, protocol version and cipher selection are the platform's and are not asserted. |
| **TBS-06** | **GitHub Pages' own serving layer**: that the exported static bundle is published, reachable, and carries the keys it was built with | `npm run build` writes `out/` and the export audit inspects those files on disk. Neither crosses the CDN, and a workflow that builds correctly can still publish nothing, publish a stale commit, or publish without the `NEXT_PUBLIC_*` values substituted. | **OPEN** | None. No check fetches the deployed URL. A shell equivalent of leg 1 against the published bundle would close it. |
| **TBS-07** | **Supabase Auth's own endpoints** (`/auth/v1/**`): sign-up, sign-in, token refresh, session expiry | The pre-port design had its own session table and `pg_hba` trust; under ADR-0015 auth is the platform's and lives entirely behind HTTP. ADR-0002's argon2id parameters and session semantics describe a mechanism this deployment no longer uses. | **OPEN** | Leg 2's sign-in step would exercise `grant_type=password` only. Refresh, expiry and sign-up are untouched by anything in this repository. |
| **TBS-08** | The **browser runtime**: that `supabase-js` serialises the call the way these probes do, and that the Desk screen's handler reaches it | The probes send hand-written JSON with `curl`. The product sends whatever `supabase-js` builds from a typed call. The two agreeing is an assumption. The E2E + axe step canon §8.7 puts in the CI order does not exist: `@playwright/test` is a devDependency and there is no spec, no config and no npm script (`tests/smoke/` is a three-assertion vitest toolchain check, not a browser test). | **OPEN** | **PARTIAL.** `vitest.component.config.ts` (ADR-0018, gate 6 of 8) renders the Desk in jsdom and asserts the clause "the Desk screen's handler reaches it" for the submit-success transition, with its positive control measured by reintroducing the defect. It does NOT address the first clause: `supabase-js` is mocked there, so that it serialises the call the way these probes do is still an assumption, and there is still no real browser, no real network and no axe pass. The one end-to-end confirmation on record remains a manual browser sign-in and draft-to-submit cycle (2026-10-22, repeated 2026-10-23) — evidence that it worked once, not a check that it still does. Closing this needs the canon §8.7 E2E step: `@playwright/test` is a devDependency with no spec, no config and no npm script. |

## Rules

1. **A new transport gets a row before it gets traffic.** A gateway, proxy, CDN, cache, queue
   or external provider added between a client and the thing under test is a blind spot the
   moment it exists, whether or not anyone has thought of a way to check it.
2. **One smoke assertion per transport is enough to close a row, and it must be graded on the
   specific expected answer.** Not breadth — one request that crosses the component and is
   compared against an explicit expected code turns "unreachable" from invisible into loud.
   Grading on "did not return the error I was looking for" reproduces the original defect:
   an answer the check does not recognise is not evidence of health, and must fail.
3. **Every such check carries a positive control, and the control's measurement is recorded
   next to the check** (ADR-0009, canon §4). A probe that can no longer detect the failure it
   was built for reports success. If the control fails, the check must refuse to grade the
   real request rather than fall back to reporting on it.
4. **These checks live outside `scripts/gates.sh`.** They need credentials and the network;
   `gates.sh` must keep passing with neither. They are invoked by path, as
   `scripts/verify-rest-exposure.sh` and `npx supabase db push` already are (ADR-0016,
   `docs/deployment.md` §7).
5. **`gates.sh` prints this register's instruments as NOT RUN, out of band.** They are not
   gate steps and do not change its exit status, but their absence from a green run stays
   visible instead of becoming the normal state. A green `gates.sh` means the offline slice
   passed, and the summary says so in as many words.
6. **An `OPEN` row is a real gap and belongs in the gap register, not in prose.** Masking one
   with a mock, a skipped test or a narrowed assertion is the defect this file exists to
   prevent (canon §9).
7. **A control must be positioned where the thing it doubts is still possible.** An assertion
   placed after a stricter check that subsumes it cannot fail, however sound it reads. The
   first version of this probe's mutual control compared two functions' answers *after*
   requiring each to equal its own expected code — so the comparison was unfailable, and it
   was written while implementing rule 3. Measured and recorded in ADR-0017, run D. Before
   adding a control, name the state in which it reports failure, and check that the state is
   reachable from where it sits.
