-- 20261023080000 — audit_event. Implementation plan task 3.7, NFR-03, FR-16.
--
-- ===========================================================================
-- WHAT NFR-03 ASKS FOR, AND WHY A TIMESTAMP COLUMN IS NOT IT
-- ===========================================================================
-- "All submitted versions, assessment changes and review decisions have ACTOR/TIME
-- metadata." `decision_revision` already carries `user_id` and `created_at`, which answers
-- "whose revision, written when". It cannot answer "who DID this", and the difference is
-- the whole requirement: FR-13 reviewer sharing is deferred, not cancelled, and the moment
-- a second person can act on a record, a row that records only its OWNER has lost the
-- fact that someone else changed it.
--
-- So every row here carries BOTH:
--
--   user_id        the SUBJECT. Whose journal this event belongs to. NOT NULL, and the
--                  column every policy in this schema scopes on.
--   actor_user_id  the ACTOR. Who caused it. NULLABLE, because an event can be caused by
--                  the system rather than by a person, and a NULL that means "no human
--                  did this" is more honest than stamping the subject's own id on a write
--                  they did not make.
--
-- Today they are always equal: there is one reader and no sharing. Recording them as one
-- column now would mean a migration later that cannot reconstruct the distinction for any
-- row already written.
--
-- ===========================================================================
-- NO JOURNAL TEXT, ENFORCED BY THE SCHEMA RATHER THAN BY CARE
-- ===========================================================================
-- CLAUDE.md §6: never log journal content. An audit table is the easiest place in the
-- system to break that rule by accident, because "record what happened" reads as "record
-- what was written".
--
-- Three things stop it, and only the first is a matter of anyone remembering:
--
--   1. the functions below write ids and enum values, never prose;
--   2. `authenticated` holds NO INSERT grant, so the only writers are those functions.
--      Grant-absence is strictly stronger than RLS (canon §5.2);
--   3. `audit_detail_keys_known` REJECTS a row whose `detail` carries any key outside a
--      fixed list. A future function that stuffed a rationale under `detail->'text'` would
--      not be caught by review; it would fail to insert.
--
-- The third is the one that survives someone editing the functions, and it is expressed
-- as `detail - <allowed keys> = '{}'` because a CHECK cannot contain a subquery.
-- `tests/integration/audit.test.ts` adds what the schema cannot: that no audit row
-- contains a substring of the decision's actual rationale.
--
-- ===========================================================================
-- ON DELETE RESTRICT, UNLIKE decision_revision
-- ===========================================================================
-- `dr_parent_fk` cascades: a revision is PART OF its decision and has no meaning without
-- it. An audit row is the record THAT something happened, and canon §5.2 forbids a cascade
-- that "silently destroys the audit history NFR-03 and FR-16 require". So this one
-- restricts: deleting a decision that has audit history fails, and erasure goes through
-- the deliberate path FR-16 describes rather than taking the history with it as a side
-- effect.

set role postgres;

create table public.audit_event (
  id             uuid        primary key default gen_random_uuid(),
  user_id        uuid        not null,
  actor_user_id  uuid        references public.profile (user_id) on delete restrict,
  decision_id    uuid        not null,
  action         text        not null,
  detail         jsonb       not null default '{}'::jsonb,
  occurred_at    timestamptz not null default now(),

  constraint audit_action_known check (action in ('submission', 'revision', 'milestone')),

  -- Composite, so an event cannot be attached to a decision belonging to someone else:
  -- the pair (decision_id, user_id) must resolve to a real row, exactly as dr_parent_fk
  -- does for revisions.
  constraint audit_parent_fk foreign key (decision_id, user_id)
    references public.decision (id, user_id) on delete restrict,

  -- The structural half of "no journal text". `detail - <allowed>` removes the permitted
  -- keys; anything left over means an unexpected key was present.
  constraint audit_detail_keys_known check (
    detail - array['revision_id', 'revision_no', 'milestone', 'replayed']::text[]
      = '{}'::jsonb
  )
);

create index audit_event_user_idx     on public.audit_event (user_id);
create index audit_event_decision_idx on public.audit_event (decision_id, occurred_at);

comment on table public.audit_event is
  'NFR-03 actor/time metadata. Carries the SUBJECT (user_id) and the ACTOR (actor_user_id) separately, because they will differ as soon as FR-13 sharing exists and a row written now could not be split later. Never contains journal text: authenticated holds no INSERT grant and audit_detail_keys_known rejects any unexpected key.';
comment on column public.audit_event.actor_user_id is
  'Who caused the event. NULL means no person did: a system write. Today always equal to user_id, because there is one reader and no sharing.';

-- ---------------------------------------------------------------------------
-- RLS: tenancy only, no TO clause (V9), auth.uid() in the predicate.
-- ---------------------------------------------------------------------------
alter table public.audit_event enable row level security;
alter table public.audit_event force  row level security;
create policy audit_event_tenancy on public.audit_event
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Immutability: triggers AND absent grants, both.
-- ---------------------------------------------------------------------------
-- The grants below give `authenticated` SELECT only, so a client cannot reach an UPDATE
-- at all. The triggers exist for the OWNER, which the grants do not bind: V32 recorded
-- that `dr_no_update` raises ST001 for the table owner too, and that is the property that
-- makes "append-only" true of migrations and definer functions rather than only of
-- clients. The TRUNCATE trigger is separate and FOR EACH STATEMENT because TRUNCATE
-- bypasses row-level triggers entirely (V15).
create function app.audit_no_change() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'audit_event is append-only: % refused', TG_OP using errcode = 'ST001';
end $$;

create trigger audit_no_update_delete
  before update or delete on public.audit_event
  for each row execute function app.audit_no_change();

create function app.audit_no_truncate() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'audit_event cannot be truncated' using errcode = 'ST001';
end $$;

create trigger audit_no_truncate
  before truncate on public.audit_event
  for each statement execute function app.audit_no_truncate();

-- ---------------------------------------------------------------------------
-- Grants. SELECT only.
-- ---------------------------------------------------------------------------
-- No INSERT: every row is written by a definer function below. A client that could insert
-- could write a history that did not happen, which is worse than having no history.
revoke all on table public.audit_event from anon, authenticated, service_role;
grant select on public.audit_event to authenticated;

-- ---------------------------------------------------------------------------
-- The sentinel (canon §4.3: every new table gets one, in the same migration).
-- ---------------------------------------------------------------------------
-- Owner-run INSERT under FORCE needs the V8 bracket: without it the write is scoped away,
-- affects zero rows and raises NOTHING, and rule 9a would then report a missing sentinel
-- for a row this file believes it wrote.
--
-- The trigger above does not interfere: it fires BEFORE UPDATE OR DELETE, not INSERT.
alter table public.audit_event no force row level security;   -- V8 bracket OPEN
insert into public.audit_event (id, user_id, actor_user_id, decision_id, action, detail,
                                occurred_at)
values ('00000000-0000-0000-0000-00000000ad17',
        '00000000-0000-0000-0000-00000000dead',
        '00000000-0000-0000-0000-00000000dead',
        '00000000-0000-0000-0000-00000000dec1',
        'submission',
        jsonb_build_object('revision_no', 1),
        '2026-01-01T00:00:00Z'::timestamptz)
on conflict (id) do nothing;
alter table public.audit_event force row level security;      -- V8 bracket CLOSED

do $$
declare n bigint;
begin
  select count(*) into n from public.audit_event
   where user_id = '00000000-0000-0000-0000-00000000dead';
  if n <> 1 then
    raise exception 'audit_event sentinel: expected exactly 1 row, found %', n
      using errcode = 'ST097';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The writers
-- ---------------------------------------------------------------------------
-- One helper, so the row-count assertion exists ONCE rather than three times. Canon §4.4:
-- a privileged write asserts its row count, because a failing policy affects zero rows and
-- raises nothing (V7).
--
-- `actor` is a parameter and `subject` is not derived here, because this function is only
-- ever called from a definer function that has ALREADY resolved both from
-- `app.require_user_id()` and from a row it locked. Deriving them again would be a second
-- definition of who the caller is.
create function app.record_audit_event(
  p_user_id uuid, p_actor_user_id uuid, p_decision_id uuid, p_action text, p_detail jsonb
) returns void
  language plpgsql security definer set search_path = pg_catalog, app, public as $$
declare n integer;
begin
  insert into public.audit_event (user_id, actor_user_id, decision_id, action, detail)
  values (p_user_id, p_actor_user_id, p_decision_id, p_action, p_detail);
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'audit write affected % rows', n using errcode = 'ST005';
  end if;
end $$;

-- ===========================================================================
-- THE THREE LIFECYCLE FUNCTIONS, REDEFINED AGAIN
-- ===========================================================================
-- A `create or replace` makes the definitions in 20261022170000 dead text, exactly as that
-- file made 20261021140400's dead. MEASURED there: M18, the cross-tenant idempotency leak,
-- went ESCAPED because its mutation was editing a body nothing used. The mutations are
-- re-pointed to THIS file in the same change, and the rule is now stated in three places
-- because it has already cost one silent loss of coverage.
create or replace function app.submit_decision(
  p_decision_id uuid, p_token uuid, p_content jsonb,
  p_confidence smallint, p_forecast text, p_horizon text, p_rationale text
) returns table (revision_id uuid, revision_no integer, replayed boolean)
  language plpgsql security definer set search_path = pg_catalog, app, public as $$
declare me uuid := app.require_user_id(); n integer; rid uuid; svid uuid;
begin
  -- `and dr.user_id = me` is load-bearing on Supabase: without it this lookup reads every
  -- tenant's rows, because the definer is bypassrls. A cross-tenant replay returning
  -- another user's revision_id was a measured leak; the control is in lifecycle.test.ts.
  select dr.id, dr.revision_no into rid, n
    from public.decision_revision dr
   where dr.idempotency_token = p_token and dr.user_id = me;
  if found then
    -- A replay writes NO audit row. The event already happened and was recorded; a second
    -- row would turn "this was submitted once" into a history of two submissions.
    return query select rid, n, true; return;
  end if;

  select d.scenario_version_id into svid
    from public.decision d
   where d.id = p_decision_id and d.user_id = me and d.submitted_at is null
   for update;
  if not found then
    raise exception 'not a submittable draft' using errcode = 'ST010';
  end if;

  insert into public.decision_revision
    (decision_id, user_id, scenario_version_id, revision_no, content, confidence, forecast,
     horizon, rationale, idempotency_token)
  values (p_decision_id, me, svid, 1, p_content, p_confidence, p_forecast, p_horizon,
          p_rationale, p_token)
  returning id into rid;

  update public.decision set submitted_at = now()
    where id = p_decision_id and user_id = me;
  get diagnostics n = row_count;
  if n <> 1 then           -- V7: a failing policy affects 0 rows and raises nothing
    raise exception 'submit stamped % rows' , n using errcode = 'ST005';
  end if;

  -- Ids and a number. No content, no forecast, no rationale.
  perform app.record_audit_event(me, me, p_decision_id, 'submission',
    jsonb_build_object('revision_id', rid, 'revision_no', 1));

  return query select rid, 1, false;
end $$;

create or replace function app.append_revision(
  p_decision_id uuid, p_token uuid, p_content jsonb,
  p_confidence smallint, p_forecast text, p_horizon text, p_rationale text
) returns table (revision_id uuid, revision_no integer, replayed boolean)
  language plpgsql security definer set search_path = pg_catalog, app, public as $$
declare me uuid := app.require_user_id(); nxt integer; rid uuid; existing integer; svid uuid;
begin
  select dr.id, dr.revision_no into rid, existing
    from public.decision_revision dr
   where dr.idempotency_token = p_token and dr.user_id = me;
  if found then
    return query select rid, existing, true; return;
  end if;

  select d.scenario_version_id into svid
    from public.decision d
   where d.id = p_decision_id and d.user_id = me and d.submitted_at is not null
   for update;
  if not found then
    raise exception 'not a submitted decision' using errcode = 'ST011';
  end if;

  select coalesce(max(dr.revision_no), 0) + 1 into nxt
    from public.decision_revision dr where dr.decision_id = p_decision_id;

  insert into public.decision_revision
    (decision_id, user_id, scenario_version_id, revision_no, content, confidence, forecast,
     horizon, rationale, idempotency_token)
  values (p_decision_id, me, svid, nxt, p_content, p_confidence, p_forecast, p_horizon,
          p_rationale, p_token)
  returning id into rid;

  perform app.record_audit_event(me, me, p_decision_id, 'revision',
    jsonb_build_object('revision_id', rid, 'revision_no', nxt));

  return query select rid, nxt, false;
end $$;

create or replace function app.stamp_milestone(p_decision_id uuid, p_milestone text)
  returns void language plpgsql security definer
  set search_path = pg_catalog, app, public as $$
declare me uuid := app.require_user_id(); n integer;
begin
  if p_milestone not in ('challenged','reflected','action_recorded','closed') then
    raise exception 'unknown milestone %', p_milestone using errcode = 'ST012';
  end if;
  execute format(
    'update public.decision set %I = now() where id = $1 and user_id = $2 and %I is null',
    p_milestone || '_at', p_milestone || '_at')
    using p_decision_id, me;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'stamp % affected % rows', p_milestone, n using errcode = 'ST005';
  end if;

  -- The milestone NAME is an enum value from the whitelist checked above, not free text.
  perform app.record_audit_event(me, me, p_decision_id, 'milestone',
    jsonb_build_object('milestone', p_milestone));
end $$;

-- V2/V30: the explicit revokes, then this file's own surface restated.
-- `app.record_audit_event` is deliberately NOT granted: it is reachable only from the
-- three definer functions, which already hold the identity it would otherwise have to be
-- told. A client able to call it could write history that did not happen.
revoke execute on all functions in schema app    from public, anon;
revoke execute on all functions in schema public from public, anon, authenticated, service_role;
grant execute on function app.submit_decision(uuid,uuid,jsonb,smallint,text,text,text) to authenticated;
grant execute on function app.append_revision(uuid,uuid,jsonb,smallint,text,text,text) to authenticated;
grant execute on function app.stamp_milestone(uuid,text) to authenticated;
