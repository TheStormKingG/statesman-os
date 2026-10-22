# STATESMAN OS

A private practice system for public leadership decisions.

You are given a sourced governance scenario, you write a decision and the reasoning behind
it, that reasoning is challenged from five professional viewpoints, you reflect on what the
challenge exposed, and you commit to a corrective action. The record is permanent and
auditable.

Its job is to build the habit of making a hard decision, recording the reasoning, receiving
challenge, and improving on evidence. Not to make anyone look prepared.

**It is not** a campaign tool, an election predictor, a governance certification, or an AI
adviser for live emergencies. There is no readiness score, and there never will be: the
product refuses to reduce a person to one number.

## Status: mid-build, no usable interface yet

Honest state as of the latest commit:

| | |
|---|---|
| Database schema, RLS, lifecycle functions | done; ported to Supabase shape, tested against a local emulation |
| Scenario content, source register, claim whitelist | done, tested |
| Security posture check (the release gate) | done, passing on the ported set |
| Typed data-access boundary | **retired as production code** — see the port note below |
| Runnable shell (`npm run dev`) | a status page, nothing more |
| The five screens | **not started** |
| Challenge Review (the AI layer) | **not started** |
| Deployment | target chosen and verified; **not wired up** — see Deployment below |
| Integration test suite | 120 tests, passing, deterministic across 5 runs |

There is no sign-in and no product screen. `npm run dev` serves one page that says exactly
that. The first real screen arrives with the decision-workflow slice.

### The port, in one paragraph

ADR-0015 replaced the original architecture — local Postgres reached by `pg` from Next.js
server code, three hand-made roles, identity in a transaction-local GUC — with a Next.js
**static export** talking to **Supabase** from the browser. The consequence that matters:
there is no server process left, so the server boundary and the grant model are both gone
and **RLS is the only wall**. The typed data-access boundary that used to live in
`src/server/db` therefore has no production role; what survives of it is at
`tests/support/scoped-pg/`, where the integration harness still needs a driver to issue SQL
as a chosen role. `docs/supabase-port-notes.md` records what was measured, including a
cross-user identifier leak the port introduced and fixed.

There is **one** migration set, `supabase/migrations/`, and local Postgres is bent to match
Supabase rather than the reverse. The pre-port set at `migrations/0000..0009` has been
deleted; it is in git history, and two coexisting sets are the exact divergence ADR-0015
exists to prevent.

## Gates

```
npm run gates
```

Runs, in order, failing the build if any step fails: `typecheck`, `lint`, import-boundary
check and its own self-test, unit tests, integration tests, and the mutation gate.

The mutation gate is the unusual one and it is the point. An adversarial pass found eight
security guards whose removal left the test suite entirely green — including one that
turned out to be exploitable. The guards worked; nothing could tell if they stopped. So
`scripts/mutation-check.sh` now removes each guard in turn and fails the build unless the
suite goes red *and the specific test that claims to cover it* is the one that fails.
A new security guard ships with a mutation proving its control bites.

**Current state, stated rather than implied.** `typecheck`, `lint`, the import-boundary
check and its self-test, the 36 unit tests and the 120 integration tests all pass,
and the integration suite is deterministic: five runs, including one single-worker,
all 120/120.

What is **not** yet settled, stated plainly because this README is the first thing
anyone reads: the mutation gate is currently red. Not because a guard failed, but
because seven mutations name test titles that the Supabase port renamed, and the
gate refuses to run at all rather than report a verdict it cannot attribute. One
real gap sits behind it — the port fixed a cross-tenant leak in the idempotency
lookup, and the mutation covering that fix names a same-user test, which cannot
catch it. Deployment to GitHub Pages and Supabase is decided (see
`docs/adr/ADR-0015-*.md`) and not yet wired up.

## Running it locally

Needs PostgreSQL 17 on `127.0.0.1:5432`. See `.env.example`, and `docs/` for the rest.
There is no Docker in this setup, so `supabase start` is not how this runs locally.

```bash
npm install
createdb statesman_dev                 # see the note below — nothing else creates it
npm run db:migrate -- statesman_dev    # emulation + supabase/migrations/*.sql + posture check
npm run dev
```

**Create the database yourself.** `scripts/db-bootstrap.sh` used to do it and is retired;
`scripts/migrate.sh` deliberately does not, because creating a database is not something a
migration runner should do by surprise. Against an absent database it fails loudly —
measured: `database "…" does not exist`, exit **3** — so the mistake is cheap, not silent.
(`scripts/db-template.sh` is the exception and creates its own; it owns that database.)

`scripts/migrate.sh` is the single entry point and runs three mandatory steps in order:

1. **`scripts/emulate-supabase.sh`** — makes the local database behave like Supabase:
   creates `anon`, `authenticated`, `service_role`, `authenticator` and `postgres` with the
   platform's attributes (including the hazardous ones — `postgres` is NOSUPERUSER but
   **BYPASSRLS**), an `auth` schema it does not own, and an `auth.uid()` that returns NULL
   with no claim. Idempotent, so re-running a migrate is safe.
2. **`supabase/migrations/*.sql`** — the ported set, by lexical glob, never a
   hand-maintained list. The Supabase CLI orders by the same timestamp prefix, so local
   order and remote order are one ordering rather than two that happen to agree.
3. **`app.verify_security_posture()`** — the release gate. With the server boundary and the
   grant model gone, this stopped being a quality measure and became the only thing between
   a policy typo and the journal, so a failure here fails the run.

To rebuild the database the integration tests clone:

```bash
bash scripts/db-template.sh            # drops and rebuilds the template, then reports its measured posture
```

It prints the posture it actually built — per-table RLS and FORCE, policy counts, owners,
both sentinel mechanisms, whether `anon` can reach anything, and the BYPASSRLS allowlist in
full. Read it. A template that built "successfully" with FORCE left off or a sentinel
missing makes every tenancy test downstream vacuous, and post-port there is no error raised
to announce it.

`npm run db:bootstrap` is **retired** and exits non-zero. It created the three local roles
that ADR-0015 replaced; the roles are now the platform's on Supabase and the emulation's
locally, so there is no separate bootstrap step.

Two measured gotchas on macOS: Postgres installed by Homebrew is not brew-managed by
default, so after a reboot it needs `brew services start postgresql@17`; and the postmaster
aborts unless `LC_ALL` is set to a valid locale.

## Deployment

**Nothing is deployed, and there is no URL.** The target is settled and verified but not
wired up.

The plan, per `docs/adr/ADR-0015-static-github-pages-plus-supabase.md`: a Next.js static
export on **GitHub Pages**, talking to a **Supabase** project from the browser with a
publishable anon key, with RLS doing the enforcing. What exists today is the migration set
and the posture check, verified against the local emulation only. What does **not** exist:
any push to the Supabase project, Supabase Auth integration, the Pages workflow, and the
Edge Function that Slice 4's AI call has to become so the model key never reaches the
browser.

This repository is public and carries no secret by design — the anon key is publishable and
the journal lives in Supabase, not here. `.env.supabase.local` and `supabase/.temp/` are
gitignored because they can hold a pooler URL or a service-role key; the single most
damaging mistake available in this project is putting a **service_role** key where the anon
key belongs, and `docs/deployment.md` explains why nothing downstream would notice.

## Documentation

- `docs/PRD.md` — the authoritative product requirements
- `docs/adr/ADR-0015-static-github-pages-plus-supabase.md` — the current architecture, and
  a table naming exactly which canon sections it supersedes
- `docs/supabase-port-notes.md` — what the port measured, the findings, and the owed work
- `docs/supabase-target.md` — the live project's shape, every row established by query
- `docs/superpowers/specs/` — the design canon, including a register of facts established
  by running commands rather than by reasoning about them. **Sections 2, 4.1, 4.3, 4.6, 6,
  6.1 and 8.3 are superseded by ADR-0015**; the V-facts are not.
- `docs/threat-model.md`, `docs/requirements-traceability.md`, `docs/deployment.md`
- `docs/mutation-testing.md` — how the mutation gate works and how to add to it
- `docs/ui-ux-design.md`, `PRODUCT.md`, `DESIGN.md` — the interface design

`docs/implementation-plan.md` and `docs/requirements-traceability.md` were written before
the port and still cite `migrations/NNNN_*.sql` paths and `src/server/db/*` modules that no
longer exist. Read them as the pre-port plan, not as a map of the tree.

## Licence and scope

Not licensed for reuse. Built for a single user; the scenario content is fictional
throughout and labelled as such.
