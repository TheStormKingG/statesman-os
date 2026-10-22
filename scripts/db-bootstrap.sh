#!/usr/bin/env bash
#
# db-bootstrap.sh — RETIRED by ADR-0015. This script no longer does anything.
#
# ===========================================================================
# WHAT IT USED TO DO, AND WHY THAT JOB NO LONGER EXISTS
# ===========================================================================
# It was the one-time cluster bootstrap. It created the three local roles of
# canon §4.1 — `statesman_owner`, `statesman_app`, `statesman_migrator` — with
# a password policy, a refusal to re-run, and post-conditions read back from
# `pg_roles`, by applying `migrations/0000_bootstrap_roles.sql`.
#
# ADR-0015 superseded canon §4.1. There are no `statesman_*` roles any more:
#
#   statesman_app       ->  authenticated
#   statesman_owner     ->  postgres        (and NOTE: `postgres` is BYPASSRLS,
#                                            which `statesman_owner` was not)
#   statesman_migrator  ->  no equivalent. Supabase has no non-bypassrls owner
#                           role, so nothing in this project creates one.
#
# `migrations/0000_bootstrap_roles.sql` has been DELETED along with the rest of
# the pre-port set (`migrations/0000..0009`), because two coexisting migration
# sets are the exact divergence ADR-0015 exists to prevent. The old set is in
# git history at commit b3a5f59; `git show b3a5f59:migrations/0000_bootstrap_roles.sql`
# prints the file this script used to apply.
#
# Nothing replaced the role-creation step, because on both targets the roles
# already exist by the time any migration runs:
#
#   * On Supabase, `anon`, `authenticated`, `service_role` and `postgres` are
#     the platform's. A project cannot create them and must not try.
#   * Locally, `scripts/emulate-supabase.sh` creates them with Supabase's
#     attributes — including the hazardous ones (`postgres` NOSUPERUSER but
#     BYPASSRLS, `service_role` NOLOGIN BYPASSRLS, `authenticator` NOINHERIT) —
#     and `scripts/migrate.sh` runs it FIRST and unconditionally, so there is
#     no separate bootstrap step to forget.
#
# The database-level hardening this script also used to apply (`revoke create
# on schema public`, `revoke temporary on database`) did NOT move into the
# emulation. It is in `supabase/migrations/20261021140000_harden_public_schema.sql`,
# because it must also run against the live project, which has no local
# bootstrap step at all. See `scripts/db-template.sh`'s header.
#
# ===========================================================================
# WHY THIS FILE IS A LOUD REFUSAL RATHER THAN A DELETED FILE OR A WRAPPER
# ===========================================================================
# `npm run db:bootstrap` is in package.json and in three places in
# docs/implementation-plan.md. Deleting the file would make that an opaque
# "No such file or directory" from bash; making it a thin wrapper around
# `emulate-supabase.sh` would be worse still, because the emulation is already
# step 1 of `migrate.sh` and a second entry point into it invites someone to
# bootstrap a database and then wonder why it has no schema. So: it exits
# NON-ZERO and names the command that replaced it. A retired step that exits 0
# is a step that looks done.
#
#   bash scripts/migrate.sh <database>        emulation + the ported set + posture
#   bash scripts/db-template.sh               the integration-test template database
#
# See `docs/adr/ADR-0015-static-github-pages-plus-supabase.md` and
# `docs/supabase-port-notes.md` §3.

set -uo pipefail

cat >&2 <<'MSG'
db-bootstrap: RETIRED — this script has no job left to do.

  ADR-0015 replaced the three local roles (statesman_owner / statesman_app /
  statesman_migrator) with Supabase's own (postgres / authenticated / anon /
  service_role), and deleted migrations/0000_bootstrap_roles.sql, which is the
  file this script applied. It is in git history at commit b3a5f59.

  The roles are no longer bootstrapped separately:
    * on Supabase they are the platform's and cannot be created;
    * locally, scripts/emulate-supabase.sh creates them, and scripts/migrate.sh
      runs it first and unconditionally.

  What you almost certainly want instead:

      bash scripts/migrate.sh <database>    # emulation + supabase/migrations + posture
      bash scripts/db-template.sh           # rebuild the integration-test template

  Exiting 2 rather than 0: a retired step that reports success is a step that
  looks done.
MSG

exit 2
