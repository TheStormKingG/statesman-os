# ADR-0001: Local PostgreSQL instead of Supabase

**Status:** Accepted | **Date:** 2026-10-20

## Context

`MASTER_PROMPT.md` §4 names "PostgreSQL with Supabase Auth and Row Level Security" as the
default, while also requiring that version choices "match the environment". The environment does
not support the Supabase local stack: there is no container runtime on this machine. The Supabase
CLI is installed, but `supabase start` starts containers on a Docker network, so the CLI alone
provides no local database.

PostgreSQL 17.11 (Homebrew) is already running, and the whole security model in canon §4 was
established by executing commands against that exact cluster (V1–V24). Those facts transfer to no
other engine.

## Decision

Use the local PostgreSQL 17.11 cluster, accessed through `pg` (node-postgres) with hand-written
SQL migrations. One persistence strategy, no ORM (canon §2).

The schema stays portable. No Supabase-specific construct appears in it. `app.current_user_id()`
exists as a thin non-raising alias and is **the only** Supabase port seam, standing in for
`auth.uid()`; it is deliberately not used in any policy (canon §4.3). Authentication is built
here instead (ADR-0002), which is the direct cost of this decision.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Supabase Cloud free tier | Puts the pilot user's private journal on third-party infrastructure before the privacy review PRD §13 lists as a dependency, and needs credentials nobody has authorised; `MASTER_PROMPT.md` §0.34 and §12.9 forbid deploying infrastructure without explicit approval. It also moves NFR-02 (O1) to a provider rather than settling it. |
| PGlite | Single-connection by design (recorded rationale; not a canon V-fact and not verified here). Concurrency and double-submit tests would therefore pass **vacuously while appearing to cover the invariant** `MASTER_PROMPT.md` §6 demands — the precise failure mode canon §8 exists to prevent. Also a different engine, so V1–V24 would not apply. |
| Install Docker, run Postgres or Supabase in a container | Adds an infrastructure dependency to satisfy a tooling preference. The hazard it would address — test database isolation — is already handled by per-worker `CREATE DATABASE … TEMPLATE` (canon §8.3). |
| Supabase Auth against a remote project with a local database | Splits identity from the data whose policies depend on it, and reintroduces the remote-credential problem for the one component ADR-0002 can build locally. |

## Consequences

**Positive.** One engine, one access strategy. Every verified fact in canon §3 applies to the
real target rather than to an approximation of it.

**Negative.** No managed backups and no managed encryption at rest: NFR-02 stays an **open
release item** (O1), met locally by FileVault and by an encrypted volume on any deploy. The
server is not brew-managed and will not survive a reboot (V26), and the postmaster aborts without
`LC_ALL` (V27).

**What this now requires.** A bootstrap script creating the three cluster roles (canon §4.1);
runbook lines for `brew services start postgresql@17` and `export LC_ALL=en_US.UTF-8`; and a
standing rule that no migration uses a Supabase-only construct, so `app.current_user_id()`
remains the single seam.

**Status:** no application code, migration or runbook exists yet. This records intent.

## Evidence

- **V26** — `brew services list` reports `postgresql@17` as `none`; the running server is not brew-managed.
- **V27** — Postgres requires `LC_ALL` on this macOS build or the postmaster aborts.
- **V1** — `pg_hba.conf` is `trust` for local/127.0.0.1/::1, so role identity must be asserted at runtime in the data path (see ADR-0006).
- **V10, V18, V19, V23** — the engine-specific behaviours the test doctrine depends on; they were measured on this cluster.
- Verified for this ADR on 2026-10-20: `command -v docker` → not found; no `docker-compose`, `colima`, `podman` or `/Applications/Docker.app`; `psql --version` → 17.11 (Homebrew); `supabase --version` → 2.75.0; `supabase start --help` describes starting containers on a docker network.
