-- 20261021140300 Decision and its append-only revisions.
-- Ported from migrations/0003_decision.sql.
--
-- Translated: `app.require_user_id()` -> `auth.uid()` in both policies; `statesman_app`
-- -> `authenticated`; `app_user(id)` -> `profile(user_id)`; the REVOKE-before-GRANT
-- discipline of 20261021140000 added.
--
-- Carried over unchanged, because PostgreSQL 17.11 on the target is identical to local
-- (docs/supabase-target.md §1) and these are properties of the server, not the platform:
-- the generated `state` column with per-branch enum casts (V12/V29), the transition guard
-- that never reads NEW.state (V28) and checks its invariant FIRST (V31), the append-only
-- triggers that fire for the owner too (V32), the statement-level BEFORE TRUNCATE trigger
-- (V15), and the composite foreign key that makes ownership a schema constraint rather
-- than a convention (canon §4.5).
--
-- WHAT THE PORT COSTS HERE: the policies below no longer raise when identity is missing.
-- A SELECT with no claim returns zero rows and no error, and V7 already says a row count
-- of 0 is never a success signal — so with an EMPTY table, a missing policy and a working
-- policy are indistinguishable (V18). The sentinel seeded by 20261021140600 is what makes
-- the zero meaningful, and posture rule 9 is what notices if it goes away.

set role postgres;

create table public.decision (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profile (user_id) on delete restrict,
  draft_payload      jsonb not null default '{}'::jsonb,
  draft_updated_at   timestamptz,
  submitted_at       timestamptz,
  challenged_at      timestamptz,
  reflected_at       timestamptz,
  action_recorded_at timestamptz,
  closed_at          timestamptz,
  created_at         timestamptz not null default now(),
  state app.decision_state generated always as (
    app.derive_decision_state(submitted_at, challenged_at, reflected_at,
                              action_recorded_at, closed_at)) stored,
  constraint decision_owner_scope unique (id, user_id)   -- composite-FK anchor
);
create index decision_user_idx on public.decision (user_id);

create table public.decision_revision (
  id                uuid primary key default gen_random_uuid(),
  decision_id       uuid not null,
  user_id           uuid not null,
  revision_no       integer  not null,
  content           jsonb    not null,
  confidence        smallint not null check (confidence between 0 and 100),
  forecast          text     not null,
  horizon           text     not null,
  rationale         text     not null,
  idempotency_token uuid     not null,
  created_at        timestamptz not null default now(),
  constraint dr_parent_fk foreign key (decision_id, user_id)
    references public.decision (id, user_id) on delete cascade,
  constraint dr_no_uq     unique (decision_id, revision_no),
  constraint dr_token_uq  unique (idempotency_token),
  constraint dr_owner_scope unique (id, user_id)
);

-- ---------------------------------------------------------------------------
-- RLS: tenancy only, no TO clause (V9), auth.uid() in the predicate.
-- ---------------------------------------------------------------------------
-- `auth.uid()` and NOT `app.require_user_id()`. The raising wrapper still exists and is
-- still used by the lifecycle functions, but putting it in a policy would give the local
-- target a failure mode the live one does not have, and every denial test would then be
-- measuring the wrapper instead of the policy. ADR-0015's paired control establishes what
-- these two policies actually do: with A's claim A sees A's rows; with no claim, 0 rows
-- and no error; A reading B's row, 0; A inserting a row owned by B rejected outright.
alter table public.decision enable row level security;
alter table public.decision force  row level security;
create policy decision_tenancy on public.decision
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.decision_revision enable row level security;
alter table public.decision_revision force  row level security;
create policy decision_revision_tenancy on public.decision_revision
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Append-only. Role-independent: these fire for the owner too (V32), so `postgres` cannot
-- quietly edit a revision either — which matters more now than it did, because `postgres`
-- is BYPASSRLS and is the role the dashboard SQL editor uses by default.
create trigger dr_no_update   before update   on public.decision_revision
  for each row       execute function app.forbid_mutation();
create trigger dr_no_delete   before delete   on public.decision_revision
  for each row       execute function app.forbid_mutation();
create trigger dr_no_truncate before truncate on public.decision_revision
  for each statement execute function app.forbid_mutation();   -- V15

-- Transition guard. INVARIANT CHECKS FIRST (V31): an early return placed in front of a
-- guard deletes the guard for the fast path, and this project reproduced exactly that —
-- a tampering edit to a submitted row took the `prospective = OLD.state` branch and
-- committed. Never reads NEW.state, which is NULL in BEFORE UPDATE on a generated column
-- (V28), so the prospective state is DERIVED from the NEW timestamps instead.
create function app.guard_decision_transition() returns trigger
  language plpgsql set search_path = pg_catalog as $$
declare prospective app.decision_state;
begin
  if OLD.submitted_at is not null
     and NEW.draft_payload is distinct from OLD.draft_payload then
    raise exception 'submitted decision draft is frozen' using errcode = 'ST003';
  end if;

  prospective := app.derive_decision_state(
    NEW.submitted_at, NEW.challenged_at, NEW.reflected_at,
    NEW.action_recorded_at, NEW.closed_at);

  if prospective = OLD.state then
    return NEW;
  end if;
  if (OLD.state, prospective) not in (
      ('draft','submitted'), ('submitted','challenged'), ('challenged','reflected'),
      ('reflected','action_recorded'), ('action_recorded','reviewed_closed')) then
    raise exception 'illegal transition % -> %', OLD.state, prospective
      using errcode = 'ST002';
  end if;
  return NEW;
end $$;
create trigger decision_transition before update on public.decision
  for each row execute function app.guard_decision_transition();

-- draft_updated_at is set by trigger, NOT granted, so a payload-only update cannot evade
-- the frozen check by omitting the timestamp.
create function app.touch_draft() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  if NEW.draft_payload is distinct from OLD.draft_payload then
    NEW.draft_updated_at := now();
  end if;
  return NEW;
end $$;
create trigger decision_touch_draft before update on public.decision
  for each row execute function app.touch_draft();

-- ---------------------------------------------------------------------------
-- Grants. REVOKE first (the stock default ACL grants ALL to anon on create), then the
-- narrow set canon §4.6b requires.
-- ---------------------------------------------------------------------------
-- `authenticated` holds UPDATE on draft_payload and NOTHING else on `decision`, so it
-- cannot write a milestone timestamp at all. Every transition goes through a definer
-- function in the next migration. Without the REVOKE the default ACL would hand it
-- UPDATE on every column, and `app.stamp_milestone` would become decoration.
revoke all on table public.decision          from anon, authenticated, service_role;
revoke all on table public.decision_revision from anon, authenticated, service_role;

grant select, insert on public.decision to authenticated;
grant update (draft_payload) on public.decision to authenticated;  -- the ONLY writable column
grant select, insert on public.decision_revision to authenticated;

revoke execute on all functions in schema app    from public, anon;
revoke execute on all functions in schema public from public, anon, authenticated, service_role;
