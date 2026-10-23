# Deployment — GitHub Pages + Supabase

**Architecture:** [ADR-0015](adr/ADR-0015-static-github-pages-plus-supabase.md). Target
shape: [supabase-target.md](supabase-target.md).

| Fact | Value |
|---|---|
| Repository | `TheStormKingG/statesman-os`, **public** (measured 2026-10-21: `isPrivate: false`) |
| Default branch | `main` |
| Site URL | `https://thestormkingg.github.io/statesman-os/` |
| `basePath` | `/statesman-os` (set in `next.config.ts`) |
| Build output | `out/`, produced by `npx next build` with `output: 'export'` |
| Workflow | `.github/workflows/pages.yml` |
| Database | Supabase project `onpkspfxfmjkqpomcsse`, `us-east-1` |

There is **no server at runtime.** GitHub Pages serves files. The browser talks to
Supabase directly, holding a publishable key that ships inside the JavaScript. Row
level security in the database is the only thing that protects the data.

---

## 1. Why the repository is public

GitHub Pages on a private repository requires a paid plan. The repository is public so
that Pages works on the free tier, and Stefan asked for it to be made public on
2026-10-21.

That is safe **only because no secret lives in the repository**, and keeping it that way
is now a hard rule rather than hygiene:

- A push of a secret to a public repository is **not undone by deleting the commit.**
  Forks, the Events API, and third-party mirrors mean you must assume it was read the
  moment it landed. The only remedy is rotation.
- `.gitignore` carries `.env`, `.env*.local`, `.env.production` and an explicit
  `.env.supabase.local` entry, plus `supabase/.temp/` (which holds the pooler URL).
  Those entries are load-bearing. Do not relax them.
- The journal itself is not in the repository. It is in Supabase, behind RLS.

## 2. One-time setup

Two of these three are **not done yet** (measured 2026-10-21 by API query).

1. **Repository is public.** Done.
2. **Pages source = GitHub Actions.** *Not configured:*
   `GET /repos/TheStormKingG/statesman-os/pages` answers `404`. The workflow's
   `actions/configure-pages@v5` step passes `enablement: true`, so the **first run
   configures it**. The manual equivalent is Settings → Pages → Build and deployment →
   Source → **GitHub Actions**.
3. **The two build-time configuration values.** *Not configured:* the repository has
   **zero** Actions variables and **zero** Actions secrets. Until they exist, every run
   stops at the preflight step with an explicit error, by design (see §5).

   Settings → Secrets and variables → Actions → **Variables** → New repository variable,
   twice:

   | Name | Value | Where to find it |
   |---|---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://onpkspfxfmjkqpomcsse.supabase.co` | Supabase → Project Settings → API |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the anon / publishable key | Supabase → Project Settings → API |

   A repository **variable** is the right store for both. Both are published in the
   bundle, so hiding them in a secret buys nothing, and a variable is visible in the
   Actions UI, which matches reality. A **secret** also works — the workflow reads
   `vars.NAME || secrets.NAME` — and masks the value in logs. Pick one; do not set both.

   The real values live locally in `.env.supabase.local` (mode 600, gitignored). Copy
   them from there into the GitHub UI. **Never** into a tracked file.

## 3. How to deploy

Push to `main`. That is the whole procedure.

```
git push origin main
```

Or, without a commit: Actions → **Pages** → Run workflow (`workflow_dispatch`).

The run does, in order: preflight the configuration → `npm ci` → five gates →
`next build` → verify the export → audit the bundle → upload → deploy. Every step must
pass; `deploy` declares `needs: build`, so a red gate cannot publish. Nothing is
`continue-on-error`.

Watch the run in Actions. The deployed URL appears on the `deploy` job.

## 4. Building and previewing locally

```
npx next build                       # writes out/
npx serve out                        # or any static server
```

Serving `out/` at a server root puts the app at `/` while the assets ask for
`/statesman-os/...`, so **preview it at the right prefix**: serve a parent directory, or
symlink `statesman-os -> out`, or use a server that supports a base path. A blank page
with 404s for `/statesman-os/_next/...` is this, not a build failure.

`npm run dev` serves the app at **http://localhost:3000/statesman-os**, not at the root.
That is deliberate: `basePath` is set unconditionally so that development exercises the
same paths as production and a basePath mistake cannot hide until deployment.

For the chain check on the page to do anything locally, put the two `NEXT_PUBLIC_`
values in `.env.local` (gitignored). Without them the page says so, in those words,
rather than appearing to be denied by a policy.

## 5. The keys: what is publishable, what is not

| Key | Publish? | What it does |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | **Yes** | The project's API endpoint. Not a credential. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` (`anon` / `sb_publishable_…`) | **Yes — this is correct** | Identifies the project and selects the `anon` role. Carries **no** authority of its own. |
| `SUPABASE_SERVICE_ROLE_KEY` (`service_role` / `sb_secret_…`) | **NEVER** | `rolbypassrls = true`. Reads and writes every row of every user's journal, ignoring every policy. |
| `SUPABASE_DB_PASSWORD` | **NEVER** | Direct superuser-adjacent database access. |
| Any `postgres://` / `postgresql://` connection string | **NEVER** | Contains the password. |

### Why publishing the anon key is correct, not a compromise

The anon key is a *project identifier plus a role selector*. It is not a password and it
grants nothing by itself. Every request it makes arrives as the `anon` role, or as
`authenticated` when a verified Supabase Auth JWT accompanies it, and **the policies
decide what that role may see.** Supabase is designed this way: the key is intended to
ship in client code, exactly as it does here.

What this *does* mean — and ADR-0015 says it plainly — is that the database is reachable
from the open internet with nothing in front of the policies. The port removed two of the
three layers that used to stand there: the server boundary (`withUser`, the eager identity
probe, `DISCARD ALL`) and the privileged-role grant model. **A single policy error is now
a full breach.** Two measured consequences:

- A missing identity is **silent**. `app.require_user_id()` raised SQLSTATE `28000`;
  `auth.uid()` returns `NULL`. The read returns zero rows and no error.
- An **empty** table under forced RLS does not deny at all — the policy qual is never
  evaluated — so an empty protected table is indistinguishable from an unprotected one.
  This is why `supabase/migrations/20261021140600_sentinels.sql` seeds a reserved row in
  every protected table, and why a denial test without a sentinel proves nothing.

### The guard in the workflow, and why it exists

The single most damaging mistake available here is pasting the **service_role** key into
`NEXT_PUBLIC_SUPABASE_ANON_KEY`. Nothing else in the pipeline would notice: the build
succeeds, the page works *better* than it should, and a key that bypasses RLS is now
published on a public URL. So `pages.yml` decodes the key's own `role` claim and refuses
to build unless it is `anon` (or the key is `sb_publishable_…`). It also refuses any
`sb_secret_…` value outright.

Both branches were **executed**, not reasoned about: a synthetic `service_role` JWT is
refused with exit 1; an `anon` JWT and an `sb_publishable_` key are accepted; a missing
variable, a non-Supabase URL and an unrecognised key format are each refused.

After the build, `pages.yml` scans `out/` and fails before uploading if it finds an
`sb_secret_…` token, a `postgres://`/`postgresql://` string, the name
`SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_DB_PASSWORD`, or **any JWT-shaped token that is
not the publishable key the build was given**. The scan begins with a positive control —
it must be able to find the publishable key, a string known to be present — so a "clean"
result cannot be the scanner failing silently. Measured on a clean export: the bundle
contains zero JWT-shaped tokens of its own, so the check does not false-positive on
`@supabase/supabase-js`.

> One deliberate non-finding, recorded so the next reader does not chase it: the string
> `sb_secret_` *does* appear once in the export, inside `@supabase/supabase-js`, in a key
> **format predicate** — `startsWith("sb_publishable_") || startsWith("sb_secret_")`. It
> is library code, not a key. That is why the scan matches `sb_secret_` followed by at
> least eight key characters rather than the bare prefix.

## 6. If a key leaks: rotation

Rotate first, investigate second. Treat any secret that reached a public artefact as read.

### `SUPABASE_SERVICE_ROLE_KEY` — the urgent one

1. Supabase dashboard → Project Settings → **API Keys** → rotate / revoke the
   `service_role` (secret) key. The old key stops working immediately; anything using it
   breaks, which is the point.
2. Update `.env.supabase.local` with the new value. Nowhere else — it must not appear in
   any tracked file, any CI variable, any CI secret, or any client bundle.
3. Find out what the old key touched: Supabase → Logs → API / Postgres logs. A key with
   `rolbypassrls` leaves no policy trail, so the API log is the only record.
4. If the journal may have been read or written, say so to the user. Do not quietly rotate
   and move on.

### `SUPABASE_DB_PASSWORD`

1. Supabase dashboard → Project Settings → Database → **Reset database password**.
2. Update `.env.supabase.local`. Re-run any local migration tooling with the new value.
3. Do not attempt to recall the old one: it was generated in-session, 40 characters, and
   is recorded only in that file. If it is lost, reset it rather than guessing.

### `NEXT_PUBLIC_SUPABASE_ANON_KEY`

This one is published on purpose, so a "leak" is not an incident. Rotate it only if it
was **compromised in a way the key itself cannot explain** — for example it turns out not
to have been the anon key at all, or the project's JWT secret was exposed.

1. Rotate the key in Supabase → Project Settings → API Keys.
2. Update the `NEXT_PUBLIC_SUPABASE_ANON_KEY` repository variable.
3. **Re-run the workflow.** The key is inlined at build time, so the published site keeps
   using the old one until a new build is deployed.

### If a secret was committed

1. Rotate it. Immediately, before anything else.
2. Then remove it from history (`git filter-repo`, or GitHub Support for a cache purge)
   — but understand this is cleanup, not containment. Rotation is the containment.
3. Add the path to `.gitignore` so it cannot recur.

## 7. What a green deployment does and does not certify

`pages.yml` runs **six** of the eight gates in `scripts/gates.sh`: `typecheck`, `lint`,
`boundaries`, `boundaries:selftest`, `test:unit`, `test:component`, plus the build and the
export audit. `test:component` (ADR-0018) is jsdom only — no database, no credentials and no
network — so it runs on a bare runner, and it guards the path the defect it exists for
actually took: the Desk shipped staying editable after a successful submit while every other
CI gate was green over that state, because none of them renders a screen.

It does **not** run `test:integration` or `mutation`. Both need a PostgreSQL 17 cluster
with the local emulation of `auth.uid()`, the `anon` and `authenticated` roles, a template
database cloned per Vitest worker, and `psql` on `PATH`. A bare runner has none of that.

`gates.sh` is explicit that an unexecuted check is **NOT RUN, never a pass**, so the
workflow does not call `gates.sh` wholesale — that would be permanently red — and it does
not silently drop the two steps either. It prints them as NOT RUN in the job summary of
every run.

**Therefore:** a green deployment means the code compiles, lints, respects its import
boundaries and passes the unit suite. **It does not mean the row level security policies
are correct**, and under ADR-0015 those policies are the only thing protecting the
journal. That is settled by the integration suite and the mutation gate, which must be run
locally before pushing:

```
bash scripts/gates.sh
```

Closing this gap means adding a Postgres service container plus the emulation to
`pages.yml`. Until then, **do not enter real decisions into the deployed site.** ADR-0015
states this as a release gate, not a quality measure.

### And what no local gate can certify: that the REST surface is actually served

`scripts/gates.sh` passes with no credentials and no network, which is what makes it
runnable. The cost is that it cannot see the live project at all, and one property that
matters only exists there.

ADR-0016 exposes schema `app` to PostgREST so the lifecycle write path is reachable from the
browser. Posture rule **E1** asserts that the setting is recorded in the database — and it
reads `pg_roles.rolconfig`, so it proves what is *recorded*, not what PostgREST is *serving*.
If the platform's own configuration ever took precedence, rolconfig would still name `app`,
rule E1 would still pass, and every submit would answer `PGRST106`. That was the project's
real state before ADR-0016, with a fully green gate run.

One request settles it, and it carries its own positive control:

```
bash scripts/verify-rest-exposure.sh
```

It reads `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` from the environment
or from the gitignored `.env.supabase.local`. Both are publishable. It never reads the
service role key.

It probes **all three** lifecycle entry points — `app.submit_decision`,
`app.append_revision`, `app.stamp_milestone` — not one. PostgREST resolves an RPC by schema,
then by name, then by matching the posted JSON keys against its own cache, and the `EXECUTE`
grant is three separate `GRANT` lines that every migration's
`revoke execute on all functions in schema app` strips. All of that is per function. Measured:
with one argument key renamed, two functions reported healthy and the third returned
`PGRST202` **in the same run**. One green function is not evidence about its siblings.

For each of the three, leg 1 prints:

| It prints | Meaning |
|---|---|
| `42501` | **healthy.** The schema is served, this function's cached signature matches the keys the client sends, and an anonymous caller is refused at the schema boundary, before any policy or function body |
| `PGRST106` | the exposure is **missing** — the whole write path is dead |
| `PGRST202` | the schema is admitted but **this function** is not resolved: a stale cache (`notify pgrst, 'reload schema'`), or a signature that no longer matches the client's keys |
| anything else | reported as a **failure**. An answer the script does not recognise is not evidence of health — grading on "not the error I was looking for" is the original defect restated |

Before grading each function it asks PostgREST for a schema that does not exist, with that
function's own argument keys, which **must** come back `PGRST106`. If it does not, the probe
can no longer tell a missing exposure from a present one, and it **refuses to grade the real
request at all** rather than falling back to reporting on a probe it has just shown it cannot
trust.

The controls have been observed failing, which is the only thing that shows they work. Five
runs on 2026-10-23, recorded in the script's own header:

| run | changed | result | exit |
|---|---|---|---|
| 0 | nothing | control `PGRST106` ×3, then `42501` ×3 | **0** |
| A | probe pointed at `auth` — a schema that exists but is not exposed | "THE EXPOSURE IS MISSING" | **1** |
| B | control pointed at `app`, which **is** exposed | "CONTROL FAILED", nothing graded | **1** |
| C | one argument key renamed | two healthy, one "NOT RESOLVED" | **1** |
| D | leg 2's grading-table control, extracted and run against a sound and a broken table | three distinct codes OK; two sharing one code → "CONTROL 2 FAILED" | **0** / **1** |

**What it does not yet certify.** `42501` proves anonymous callers are refused. It does not
prove a *signed-in* user can execute the lifecycle RPCs — a different claim, and unprovable
until an account exists on the project. The catalogue says the chain is intact
(`authenticated` holds `USAGE` on `app` and `EXECUTE` on the three entry points), but a
privilege reading is not a round trip. Supply credentials and the script runs the second leg,
in which each entry point must answer its own SQLSTATE from inside its own function body:

```
STATESMAN_PROBE_EMAIL=... STATESMAN_PROBE_PASSWORD=... bash scripts/verify-rest-exposure.sh
```

Each function answers a **different** in-body SQLSTATE, and that is the point:
`submit_decision` must return `ST010`, `append_revision` `ST011`, `stamp_milestone` `ST005`.
The first two take identical argument keys and differ only in the body they run, so a proxy, a
cache collision or a misdirected route would make their answers match — and matching means at
least one answer is not that function's own code, which the per-function grade rejects. An
answer that is another entry point's SQLSTATE is reported as a routing fault, not graded.

What the per-function grade *cannot* see is the expectations table itself, so a separate control
runs before any request and asserts the three expected codes are still pairwise distinct. An
earlier version of this control compared the two answers *after* grading them and could never
fail; ADR-0017 records why, and run D shows the replacement failing.

Every call uses an all-zeros decision id and a random per-run idempotency token, so each
function raises before its `INSERT` (or updates zero rows and rolls back). Nothing is written.

**Leg 2 has never been executed**, because no probe credential exists on this machine. Its
expected codes are read from the function bodies, and a reading is not a round trip. Without
credentials the leg prints **NOT RUN** and is never counted as a pass.

### The register is the durable artefact, not this probe

`docs/transport-blind-spots.md` lists every component on the production path that
`scripts/gates.sh` does not traverse, with a `TBS-nn` id each — the exposed-schema list, the
per-function schema cache, the `EXECUTE` grant as the gateway exercises it, the JWT-to-role
mapping, TLS, the published bundle, the Auth endpoints and the browser runtime. The probe
above closes four of those rows; **three have no instrument at all** and are recorded as open.

ADR-0017 records why the register exists rather than just one more test: a suite's blind spot
is exactly the set of components it does not traverse, and no coverage percentage can show it,
because the uncovered component has no lines in this repository. `gates.sh` prints the
live-only checks as NOT RUN in an out-of-band block on every run — outside its counters and
its exit status, so an offline run stays green while the absence stays visible.

## 8. What is not deployed, and will not be

- **Route Handlers and Server Actions.** `output: 'export'` forbids them. `src/app/api/`
  was deleted for this reason: a route that cannot exist in the shipped artefact but still
  sits in the tree is a lie about what runs. What the health endpoint proved is now proved
  by the chain check on the page itself, from the browser — the path a user actually takes.
- **`src/server/db/**` and `src/server/session/resolve.ts`.** Still typechecked, still
  inside the import-boundary gate, but nothing in the app graph imports them, so they are
  not bundled. Their premise — a server-side connection pool — no longer exists.
  Retiring them is ADR-0015 migration work with its own evidence, not a side effect of
  this change.
- **The AI layer.** It must be a Supabase Edge Function in Deno (Slice 4). The model key
  must never reach the browser, and an Edge Function is the only server-side execution
  context left.
