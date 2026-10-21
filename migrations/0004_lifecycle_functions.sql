-- 0004 Lifecycle write path. statesman_app cannot write a milestone timestamp
-- (it holds UPDATE on draft_payload only), so every transition runs here.
\set ON_ERROR_STOP on
set role statesman_owner;

-- Identity is DERIVED, never a parameter. A function taking a user id is the
-- cross-user exploit class from V2.
create function app.submit_decision(
  p_decision_id uuid, p_token uuid, p_content jsonb,
  p_confidence smallint, p_forecast text, p_horizon text, p_rationale text
) returns table (revision_id uuid, revision_no integer, replayed boolean)
  language plpgsql security definer set search_path = pg_catalog, app, public as $$
declare me uuid := app.require_user_id(); n integer; rid uuid;
begin
  -- idempotency before the lock: a replay returns the existing row
  select dr.id, dr.revision_no into rid, n
    from public.decision_revision dr where dr.idempotency_token = p_token;
  if found then
    return query select rid, n, true; return;
  end if;

  -- the row lock is the arbitration for concurrent submits
  perform 1 from public.decision d
    where d.id = p_decision_id and d.user_id = me and d.submitted_at is null
    for update;
  if not found then
    raise exception 'not a submittable draft' using errcode = 'ST010';
  end if;

  insert into public.decision_revision
    (decision_id, user_id, revision_no, content, confidence, forecast, horizon,
     rationale, idempotency_token)
  values (p_decision_id, me, 1, p_content, p_confidence, p_forecast, p_horizon,
          p_rationale, p_token)
  returning id into rid;

  update public.decision set submitted_at = now()
    where id = p_decision_id and user_id = me;
  get diagnostics n = row_count;
  if n <> 1 then           -- V7: a failing policy affects 0 rows and raises nothing
    raise exception 'submit stamped % rows' , n using errcode = 'ST005';
  end if;

  return query select rid, 1, false;
end $$;

create function app.append_revision(
  p_decision_id uuid, p_token uuid, p_content jsonb,
  p_confidence smallint, p_forecast text, p_horizon text, p_rationale text
) returns table (revision_id uuid, revision_no integer, replayed boolean)
  language plpgsql security definer set search_path = pg_catalog, app, public as $$
declare me uuid := app.require_user_id(); nxt integer; rid uuid; existing integer;
begin
  select dr.id, dr.revision_no into rid, existing
    from public.decision_revision dr where dr.idempotency_token = p_token;
  if found then
    return query select rid, existing, true; return;
  end if;

  -- lock the parent: the arbitration for two concurrent corrections
  perform 1 from public.decision d
    where d.id = p_decision_id and d.user_id = me and d.submitted_at is not null
    for update;
  if not found then
    raise exception 'not a submitted decision' using errcode = 'ST011';
  end if;

  select coalesce(max(dr.revision_no), 0) + 1 into nxt
    from public.decision_revision dr where dr.decision_id = p_decision_id;

  insert into public.decision_revision
    (decision_id, user_id, revision_no, content, confidence, forecast, horizon,
     rationale, idempotency_token)
  values (p_decision_id, me, nxt, p_content, p_confidence, p_forecast, p_horizon,
          p_rationale, p_token)
  returning id into rid;

  return query select rid, nxt, false;
end $$;

-- One milestone stamper, parameterised, so the row-count assertion exists once.
create function app.stamp_milestone(p_decision_id uuid, p_milestone text)
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
end $$;

revoke execute on all functions in schema app    from public;
revoke execute on all functions in schema public from public;
grant execute on function app.submit_decision(uuid,uuid,jsonb,smallint,text,text,text) to statesman_app;
grant execute on function app.append_revision(uuid,uuid,jsonb,smallint,text,text,text) to statesman_app;
grant execute on function app.stamp_milestone(uuid,text) to statesman_app;
