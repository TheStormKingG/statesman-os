-- 20261021140200 Identity. Ported from migrations/0002_identity.sql, which is where the
-- port changes the data model rather than translating it.
--
-- ===========================================================================
-- WHAT WAS DECIDED, AND WHY — the task asked for this to be stated explicitly
-- ===========================================================================
-- migrations/0002 created three tables: `app_user`, `user_session`, `auth_attempt`.
-- ADR-0015 retires ADR-0002 (our own session-cookie auth, argon2id) in favour of Supabase
-- Auth, and ADR-0015's supersession table marks canon §4.6 — the whole pre-identity path,
-- `create_user` / `find_credentials` / `create_session` / `resolve_session` /
-- `revoke_session` / `touch_session` / `record_attempt` — as replaced.
--
-- DROPPED, not ported:
--   * `user_session`. It stored a token hash, an absolute and an idle expiry, a
--     revocation timestamp and `privilege_epoch_at_issue`. Every one of those is GoTrue's
--     job now, in `auth.sessions` and `auth.refresh_tokens`. Keeping a second session
--     table would mean two sources of truth for whether a session is live, and the one
--     we controlled would be the one not consulted at sign-in.
--   * `auth_attempt`. It existed for sign-in rate limiting and lockout, which happens
--     inside GoTrue before any statement reaches this database. A table we write to only
--     after a successful authentication cannot rate-limit the failures it was built to
--     count.
--   * `app_user.password_hash` and `algo_ver`. Credentials must not exist here at all now.
--     Keeping a column that LOOKS like a credential store next to a real one is how a
--     later slice ends up writing to the wrong one.
--   * `app_user.privilege_epoch`. It was the mechanism for invalidating every live
--     session on a privilege change (ADR-0002). JWT revocation is GoTrue's, and a number
--     we increment that nothing checks is worse than no mechanism, because it reads as
--     one.
--   * `app_user.email`, and the `unique index on (lower(email))` of V21. The email is in
--     `auth.users`, which owns uniqueness and case-folding. V21's finding — citext is
--     available but not installed, so use text plus a functional unique index — is not
--     refuted; it simply no longer has a column to apply to.
--
-- REPLACED BY: `public.profile`, keyed one-to-one to `auth.users.id`. This is the
-- conventional Supabase shape and the one ADR-0015 names.
--
-- THE ONE DESIGN CHOICE WORTH ARGUING ABOUT: the primary key column is called `user_id`,
-- not `id`.
--
-- It is the same value either way, so this looks like a naming preference. It is not.
-- migrations/0005 rule 9 (SENTINELS) and rule 10 (NOT NULL) both locate the owner column
-- by name, and canon §4.8 says in as many words that `app_user` "whose column is `id`"
-- was the table an `attname='user_id'` selector was proven to miss. `app_user` therefore
-- had to be waived out of rule 9 via posture_exempt_table and was carried as
-- "grant-protected" instead — which was true then, because it had no grants to
-- `statesman_app` and was reachable only through definer functions.
--
-- That escape is gone. `profile` IS reachable by `authenticated`: a signed-in user reads
-- and updates their own display name directly, there being no server left to proxy it.
-- So it must be protected by a policy, and a table protected by a policy needs a sentinel
-- or its denial test is a read of an empty table (V18). Naming the column `user_id` makes
-- rules 9 and 10 apply to it with no exemption and no special case. The exemption
-- registry shrinks to the registries themselves.
--
-- The foreign key: `references auth.users (id) on delete restrict`.
--   * `auth.users(id)` is "the identity Supabase actually issues", which the task
--     requires every user-owned table's user_id to reference. `profile` is the single
--     row-level anchor to the `auth` schema; `decision` and `decision_revision` reference
--     `profile(user_id)` instead, which keeps the rest of the foreign-key graph inside
--     `public` — the half of the database this repository actually owns.
--   * ON DELETE RESTRICT, not CASCADE, and this has a visible consequence: deleting a
--     user from the Supabase dashboard FAILS while that user has a profile. That is
--     canon §5.2, which forbids a cascade from the identity table because it "silently
--     destroys the audit history NFR-03 and FR-16 require". Erasure runs through a
--     deliberate path, and FR-16 is a product feature rather than a side effect of
--     clicking delete in someone else's console. The chain is unbroken: decision →
--     profile → auth.users, restrict at every link.
-- ===========================================================================

set role postgres;

create table public.profile (
  user_id      uuid        primary key references auth.users (id) on delete restrict,
  display_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- A display name is optional, but an empty or whitespace-only one is not a name; it is
  -- a rendering bug waiting to happen in a UI that has no server to sanitise it any more.
  constraint profile_display_name_present
    check (display_name is null or length(btrim(display_name)) > 0)
);

comment on table public.profile is
  'The user-owned half of identity. One row per auth.users row. Credentials, email, sessions and rate limiting all belong to Supabase Auth and are deliberately absent (ADR-0015, retiring ADR-0002).';
comment on column public.profile.user_id is
  'PK and FK to auth.users(id). Named user_id, not id, so posture rules 9 and 10 locate it without an exemption — canon 4.8 records that an attname=user_id selector missed app_user for exactly this reason.';

-- ---------------------------------------------------------------------------
-- RLS. Tenancy only, no TO clause (V9), auth.uid() in the predicate.
-- ---------------------------------------------------------------------------
-- A user may read and create their own row and nothing else. `with check` is present on
-- both halves so a forged insert naming another user is refused by the policy rather than
-- by a trigger — ADR-0015 measured that refusal as "new row violates row-level security
-- policy", which is the shape this relies on.
alter table public.profile enable row level security;
alter table public.profile force  row level security;
create policy profile_tenancy on public.profile
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- updated_at is maintained by the database, not granted. A client that could write it
-- could backdate its own row, and the column exists to be trusted.
create function app.touch_profile() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  NEW.updated_at := now();
  return NEW;
end $$;
create trigger profile_touch before update on public.profile
  for each row execute function app.touch_profile();

-- ---------------------------------------------------------------------------
-- Grants. Narrow, and column-scoped on UPDATE.
-- ---------------------------------------------------------------------------
-- No DELETE: erasure is canon §5.2's explicit path, not a row the browser can drop.
-- UPDATE is restricted to display_name, the same shape `decision` uses for draft_payload,
-- so `user_id` and the timestamps are unwritable even to the row's owner.
--
-- The REVOKE comes FIRST and names all three platform roles. On a stock Supabase project
-- `create table` in `public` grants ALL to anon, authenticated and service_role through
-- the default ACL (see 20261021140000), so a migration that only ADDED its intended
-- grants would leave `anon` holding DELETE on the identity table and pass every test
-- written against `authenticated`.
revoke all on table public.profile from anon, authenticated, service_role;
grant select, insert       on public.profile to authenticated;
grant update (display_name) on public.profile to authenticated;

revoke execute on all functions in schema app    from public, anon;
revoke execute on all functions in schema public from public, anon, authenticated, service_role;
