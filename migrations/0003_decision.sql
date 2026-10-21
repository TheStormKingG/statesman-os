-- 0003 Decision and its append-only revisions.
\set ON_ERROR_STOP on
set role statesman_owner;

create table public.decision (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.app_user(id) on delete restrict,
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

-- RLS: tenancy only, no TO clause (V9), raising accessor (V5/V7).
alter table public.decision enable row level security;
alter table public.decision force  row level security;
create policy decision_tenancy on public.decision
  using (user_id = app.require_user_id())
  with check (user_id = app.require_user_id());

alter table public.decision_revision enable row level security;
alter table public.decision_revision force  row level security;
create policy decision_revision_tenancy on public.decision_revision
  using (user_id = app.require_user_id())
  with check (user_id = app.require_user_id());

-- Append-only. Role-independent: these fire for the owner too (V32).
create trigger dr_no_update   before update   on public.decision_revision
  for each row       execute function app.forbid_mutation();
create trigger dr_no_delete   before delete   on public.decision_revision
  for each row       execute function app.forbid_mutation();
create trigger dr_no_truncate before truncate on public.decision_revision
  for each statement execute function app.forbid_mutation();   -- V15

-- Transition guard. INVARIANT CHECKS FIRST (V31): an early return placed in front of a
-- guard deletes the guard for the fast path. Never reads NEW.state, which is NULL in
-- BEFORE UPDATE on a generated column (V28).
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

-- draft_updated_at is set by trigger, NOT granted, so a payload-only update cannot
-- evade the frozen check by omitting the timestamp.
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

grant select, insert on public.decision to statesman_app;
grant update (draft_payload) on public.decision to statesman_app;  -- the ONLY writable column
grant select, insert on public.decision_revision to statesman_app;

revoke execute on all functions in schema app    from public;
revoke execute on all functions in schema public from public;
