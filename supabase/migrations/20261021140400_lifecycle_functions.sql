-- 20261021140400 Lifecycle write path. Ported from migrations/0004_lifecycle_functions.sql.
--
-- `authenticated` holds GRANT UPDATE (draft_payload) on `decision` and nothing more, so
-- it cannot write a milestone timestamp at all (canon §4.6b, which ADR-0015 leaves
-- standing). Every transition runs here, in a SECURITY DEFINER function.
--
-- ===========================================================================
-- A REGRESSION THE PORT INTRODUCES, AND THE ONE CODE CHANGE IN THIS FILE
-- ===========================================================================
-- Canon §4.6b states, and verified at the time:
--
--   "Because policies omit the TO clause and the GUC is transaction-local rather than
--    role-scoped, app.require_user_id() inside a definer function still resolves to the
--    caller's identity even though the function executes as the owner. So a definer
--    function is scoped to the caller's own rows BY THE SAME POLICY that scopes the app
--    role."
--
-- The first half still holds: `auth.uid()` is read from a request-scoped GUC, not from
-- the session role, so `me` is still the CALLER inside a definer function. The second
-- half DOES NOT. These functions were owned by `statesman_owner`, which was
-- `rolbypassrls = false` (V34) and therefore still subject to its own tables under FORCE
-- (V8/V9) — the policy ran inside the function body. On Supabase they are owned by
-- `postgres`, and **`postgres` has `rolbypassrls = true`**. RLS is skipped entirely
-- inside these bodies. The policy that silently scoped every statement in them is simply
-- not evaluated any more.
--
-- This is the port's single most dangerous fact reaching into application code rather
-- than into a test harness, and it is the same shape: the enforcement disappears while
-- everything still returns successfully.
--
-- Most statements were already explicitly scoped (`and d.user_id = me`), so they are
-- unaffected. ONE WAS NOT: the idempotency lookup, in both `submit_decision` and
-- `append_revision`, read
--
--     select dr.id, dr.revision_no from public.decision_revision
--      where dr.idempotency_token = p_token;
--
-- with no owner predicate, because the policy supplied one. Under a bypassrls definer it
-- matches ANY user's row. User B replaying user A's idempotency token would receive A's
-- `revision_id` and `revision_no` with `replayed = true` — a cross-tenant identifier
-- leak out of a code path whose whole purpose is to look like it did nothing. It would
-- raise no error and affect no rows, so V7 covers it and nothing else would.
--
-- FIXED BELOW by adding `and dr.user_id = me` to both lookups. `dr_token_uq` is UNIQUE
-- across the whole table, so the predicate cannot change the behaviour of a legitimate
-- replay by the token's own owner: the row either belongs to the caller and is returned,
-- or it belongs to someone else and must not be. A collision across users means a
-- client-generated uuid4 collision, in which case the correct result is the
-- not-found branch and the unique constraint refusing the insert, rather than a reply
-- describing a stranger's revision.
--
-- THIS IS A NEW SECURITY GUARD, so canon §8.6b's standing rule applies: it ships with a
-- mutation proving the control bites. The mutation is specified but NOT YET WRITTEN —
-- mutations/ is outside this task's ownership. See docs/supabase-port-notes.md §"Owed
-- mutations", M18. It is proven by execution in this task's verification log.
--
-- `app.require_user_id()` is kept as the accessor here, not `auth.uid()`, and that is
-- deliberate: a function body is not a policy predicate, so the fail-loud property of V6
-- survives in the one place the port still permits it. A lifecycle call with no identity
-- raises 28000 rather than reporting ST010 "not a submittable draft", which is the
-- difference between a diagnosable bug and a misleading one.
-- ===========================================================================

set role postgres;

-- Identity is DERIVED, never a parameter. A function taking a user id is the cross-user
-- exploit class from V2.
create function app.submit_decision(
  p_decision_id uuid, p_token uuid, p_content jsonb,
  p_confidence smallint, p_forecast text, p_horizon text, p_rationale text
) returns table (revision_id uuid, revision_no integer, replayed boolean)
  language plpgsql security definer set search_path = pg_catalog, app, public as $$
declare me uuid := app.require_user_id(); n integer; rid uuid;
begin
  -- idempotency before the lock: a replay returns the existing row.
  -- `and dr.user_id = me` is load-bearing on Supabase and was not needed before — see the
  -- header. Without it this lookup reads every tenant's rows, because the definer is
  -- bypassrls.
  select dr.id, dr.revision_no into rid, n
    from public.decision_revision dr
   where dr.idempotency_token = p_token and dr.user_id = me;
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
  -- `and dr.user_id = me`: see submit_decision above and the file header.
  select dr.id, dr.revision_no into rid, existing
    from public.decision_revision dr
   where dr.idempotency_token = p_token and dr.user_id = me;
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

  -- Scoped by decision_id, and the parent was just proven to be the caller's, so this
  -- cannot read across tenants even without RLS.
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

revoke execute on all functions in schema app    from public, anon;
revoke execute on all functions in schema public from public, anon, authenticated, service_role;
grant execute on function app.submit_decision(uuid,uuid,jsonb,smallint,text,text,text) to authenticated;
grant execute on function app.append_revision(uuid,uuid,jsonb,smallint,text,text,text) to authenticated;
grant execute on function app.stamp_milestone(uuid,text) to authenticated;
