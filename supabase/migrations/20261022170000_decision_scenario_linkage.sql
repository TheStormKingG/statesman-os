-- 20261022170000 — link a decision, and every revision of it, to the scenario version it
-- answers. Implementation plan tasks 3.1 and 3.3, which Slice 1 did not implement.
--
-- ===========================================================================
-- WHAT WAS MISSING, AND HOW IT WAS FOUND
-- ===========================================================================
-- `docs/implementation-plan.md` task 3.1 specifies `decision` with "a partial unique index
-- enforcing ONE OPEN DRAFT PER USER PER SCENARIO VERSION", and task 3.3 specifies the
-- submission inserting a revision "with `scenario_version_id` PINNED BY COMPOSITE FK".
-- Neither exists. MEASURED before writing a line of this file:
--
--   grep -rn scenario_version_id supabase/migrations/*.sql | grep -i decision   ->  nothing
--   live columns of public.decision ......... id user_id draft_payload draft_updated_at
--                                             submitted_at challenged_at reflected_at
--                                             action_recorded_at closed_at created_at state
--   unique indexes on public.decision ....... decision_pkey, decision_owner_scope only
--
-- Slice 1 built the lifecycle — the state machine, the immutability, the row-count
-- assertions — and left out the one column that says what the decision is ABOUT. Nothing
-- failed, because nothing asked: there were no screens, so no code path ever needed to get
-- from a scenario to a draft or back.
--
-- ===========================================================================
-- WHY IT IS NOT ENOUGH TO PUT THE SCENARIO ID IN `draft_payload`
-- ===========================================================================
-- That was the cheap option and it is wrong in three ways that matter here.
--
--   1. `draft_payload` is the ONE column `authenticated` holds UPDATE on. A scenario id
--      living there is client-writable, so a user could repoint a draft at another case
--      after answering, or at an unpublished one. The thing a decision answers is not the
--      user's to edit.
--   2. There would be no uniqueness. "One open draft per user per scenario version" is a
--      product rule (FR-03's reopen-without-loss depends on there being ONE draft to
--      reopen) and a jsonb key cannot carry a partial unique index.
--   3. It would defeat ADR-0008. Grounding is by COMPOSITE FOREIGN KEY: a citation is valid
--      because the claim and the thing citing it are pinned to the same
--      `scenario_version_id` by the key itself, not because something checked. A revision
--      that is not pinned can be challenged against claims from a DIFFERENT version of the
--      case, which is precisely the hole M16 exists to prove is closed for
--      `scenario_claim`. Leaving it open one table over would make that mutation a
--      demonstration about nothing.
--
-- ===========================================================================
-- THE SCENARIO IS DERIVED FROM THE PARENT ROW, NEVER PASSED BY THE CALLER
-- ===========================================================================
-- `app.submit_decision` and `app.append_revision` are redefined below to read
-- `scenario_version_id` out of the `decision` row they ALREADY lock, and to insert that
-- value. Their signatures do not change and no new parameter is added.
--
-- This is canon §4.6's rule about identity applied to grounding, for the same reason: "a
-- uuid parameter is tolerable only on the pre-identity path; once identity exists a call
-- derives it internally and takes no uuid". A `p_scenario_version_id` argument would
-- type-check perfectly while naming a different case than the draft belongs to, and the
-- composite FK would then faithfully pin the revision to the attacker's choice. Removing
-- the parameter removes the channel. There is exactly one place the value can come from,
-- and it is the row the function has just taken a lock on.
--
-- ===========================================================================
-- NO BACKFILL UPDATE, AND THAT IS DELIBERATE — TWO TRAPS AVOIDED
-- ===========================================================================
-- Canon §4.3 requires a data backfill to bracket `no force` / `force` in the same file,
-- because under FORCE an owner-run `UPDATE … WHERE true` affects zero rows and raises
-- nothing (V8). There is no bracket here because there is no UPDATE.
--
-- `ADD COLUMN … DEFAULT` fills the existing rows as part of the DDL, and the default is
-- dropped immediately afterwards so that no future INSERT can silently acquire it. That
-- avoids V8 entirely, and it avoids a second trap that V8 does not cover:
-- `public.decision_revision` is APPEND-ONLY, guarded by `dr_no_update` which raises ST001
-- for the table owner too (V32). An UPDATE to backfill it would not have been merely
-- scoped away by RLS — it would have been REFUSED by the immutability trigger that exists
-- to make exactly that impossible. The backfill a reviewer would reach for first is
-- forbidden by the design, and correctly so.
--
-- The one existing row in each table is the SENTINEL (`…dec1`, `…dec2`, measured), so the
-- default points at the sentinel scenario version `…080003` and the sentinel graph stays
-- closed: sentinel rows reference sentinel rows.
--
-- ===========================================================================
-- WHAT THIS FILE DOES **NOT** DO, recorded rather than left for someone to discover
-- ===========================================================================
-- It does not require a decision's scenario version to be PUBLISHED. MEASURED: the policy
-- on `public.scenario_version` is `using (auth.uid() is not null)` with no `published_at`
-- filter, so any signed-in user can read unpublished content, and nothing stops a draft
-- being opened against it. Two reasons it is not fixed here:
--
--   * the sentinel scenario version is itself unpublished (measured), so a `published`
--     requirement expressed as a constraint would reject the sentinel graph above;
--   * a check constraint cannot reference another table, so the rule would need a trigger
--     — a new enforcement mechanism, which canon §12 says arrives with an ADR, not inside
--     a migration doing something else.
--
-- So it is enforced in the data layer (`src/lib/supabase/scenarios.ts` filters
-- `published_at is not null`) and carried as an open item. The distinction matters: this is
-- an editorial-correctness gap, not a tenancy one. Unpublished scenario content is
-- authored by migration and contains no user data.

set role postgres;

-- ---------------------------------------------------------------------------
-- 1. decision.scenario_version_id
-- ---------------------------------------------------------------------------
-- ON DELETE RESTRICT, never cascade. Canon §5.2 forbids a cascade from a parent whose
-- removal would destroy journal history: deleting a scenario version must not delete the
-- decisions people wrote against it. Retiring content is an editorial act with its own
-- path, not a side effect of a DELETE.
alter table public.decision
  add column scenario_version_id uuid
    default '00000000-0000-0000-0000-000000080003'
    references public.scenario_version (id) on delete restrict;

-- Immediately. A lingering default means a future INSERT that forgets the column gets the
-- SENTINEL scenario silently, which is worse than failing.
alter table public.decision alter column scenario_version_id drop default;
alter table public.decision alter column scenario_version_id set not null;

comment on column public.decision.scenario_version_id is
  'The scenario version this decision answers. NOT in draft_payload: that column is client-writable and the case a decision answers is not the user''s to edit. Anchors the composite FK that grounds every revision (ADR-0008).';

-- The composite-FK anchor, exactly as `decision_owner_scope` anchors the tenancy FK.
alter table public.decision
  add constraint decision_scenario_scope unique (id, scenario_version_id);

-- ---------------------------------------------------------------------------
-- 2. One open draft per user per scenario version
-- ---------------------------------------------------------------------------
-- Plan task 3.1. `where submitted_at is null` is the definition of open, taken from the
-- same timestamp the generated `state` column is derived from, so "open" cannot drift from
-- "draft".
--
-- NULLS NOT DISTINCT is deliberately NOT used here. V14 records that a partial unique
-- index over a NULLABLE column needs it, because two NULLs are distinct by default and the
-- index then permits the duplicates it was added to prevent. Both columns in THIS index
-- are NOT NULL, so the rule does not apply — stated because the two cases look identical
-- and the wrong call is invisible.
create unique index decision_one_open_draft_per_scenario
  on public.decision (user_id, scenario_version_id)
  where submitted_at is null;

-- ---------------------------------------------------------------------------
-- 3. decision_revision.scenario_version_id, pinned to the parent
-- ---------------------------------------------------------------------------
alter table public.decision_revision
  add column scenario_version_id uuid
    default '00000000-0000-0000-0000-000000080003';
alter table public.decision_revision alter column scenario_version_id drop default;
alter table public.decision_revision alter column scenario_version_id set not null;

-- THE COMPOSITE FK, and the whole point of this migration. A revision cannot name a
-- scenario version that disagrees with its parent decision, because the key is
-- (decision_id, scenario_version_id) and the referenced pair is unique on `decision`.
-- There is no code path, privileged or otherwise, that can produce a revision grounded in
-- a different case than the decision it belongs to.
alter table public.decision_revision
  add constraint dr_scenario_fk foreign key (decision_id, scenario_version_id)
    references public.decision (id, scenario_version_id) on delete cascade;

comment on column public.decision_revision.scenario_version_id is
  'Pinned to the parent decision by composite FK (dr_scenario_fk), so a revision can never be grounded in a different scenario version than the decision it answers. Set by app.submit_decision / app.append_revision from the locked parent row, never from a caller argument.';

-- ---------------------------------------------------------------------------
-- 4. The lifecycle writers now pin the scenario, derived from the locked parent
-- ---------------------------------------------------------------------------
-- Both functions already took `for update` on the parent; the only change is that the lock
-- query now RETURNS the scenario version instead of discarding it. `perform` became
-- `select … into`, which is why `found` still behaves identically.
--
-- Signatures are unchanged, so the PostgREST wire contract and the grants in
-- 20261022160000's registry are untouched. `create or replace` preserves the EXECUTE
-- grants; the trailing revokes below are the V2/V30 habit and the re-grants are stated so
-- this file declares its own surface.
--
-- ONE CONSEQUENCE THAT IS NOT OBVIOUS, AND THAT THIS CHANGE WALKED INTO. A
-- `create or replace` here makes the definitions in 20261021140400 DEAD TEXT: migrations
-- run in lexical order, so whatever that file says is overwritten before any test runs.
-- Every mutation in mutations/ that targets the earlier definition therefore stops
-- testing anything while continuing to apply cleanly and report a match.
--
-- MEASURED: M18 — the cross-tenant idempotency leak, the most serious bug this project has
-- found — went ESCAPED on the first full gate run after this migration was written. The
-- guard was intact; the mutation was editing a definition nothing uses. It was caught only
-- because the gate distinguishes ESCAPED from CAUGHT instead of grading on whether the
-- suite went red.
--
-- So: if you redefine a function here, re-point its mutations in the SAME change.
create or replace function app.submit_decision(
  p_decision_id uuid, p_token uuid, p_content jsonb,
  p_confidence smallint, p_forecast text, p_horizon text, p_rationale text
) returns table (revision_id uuid, revision_no integer, replayed boolean)
  language plpgsql security definer set search_path = pg_catalog, app, public as $$
declare me uuid := app.require_user_id(); n integer; rid uuid; svid uuid;
begin
  -- idempotency before the lock: a replay returns the existing row.
  -- `and dr.user_id = me` is load-bearing on Supabase: without it this lookup reads every
  -- tenant's rows, because the definer is bypassrls. A cross-tenant replay returning
  -- another user's revision_id was a measured leak, and tests/integration/lifecycle.test.ts
  -- carries the control.
  select dr.id, dr.revision_no into rid, n
    from public.decision_revision dr
   where dr.idempotency_token = p_token and dr.user_id = me;
  if found then
    return query select rid, n, true; return;
  end if;

  -- The row lock is the arbitration for concurrent submits, AND the only source of the
  -- scenario version. Derived here, never a parameter (see this file's header).
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

  return query select rid, 1, false;
end $$;

create or replace function app.append_revision(
  p_decision_id uuid, p_token uuid, p_content jsonb,
  p_confidence smallint, p_forecast text, p_horizon text, p_rationale text
) returns table (revision_id uuid, revision_no integer, replayed boolean)
  language plpgsql security definer set search_path = pg_catalog, app, public as $$
declare me uuid := app.require_user_id(); nxt integer; rid uuid; existing integer; svid uuid;
begin
  -- `and dr.user_id = me`: see submit_decision above.
  select dr.id, dr.revision_no into rid, existing
    from public.decision_revision dr
   where dr.idempotency_token = p_token and dr.user_id = me;
  if found then
    return query select rid, existing, true; return;
  end if;

  -- Lock the parent: the arbitration for two concurrent corrections, and the source of the
  -- scenario version. A correction stays grounded in the case it answered.
  select d.scenario_version_id into svid
    from public.decision d
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
    (decision_id, user_id, scenario_version_id, revision_no, content, confidence, forecast,
     horizon, rationale, idempotency_token)
  values (p_decision_id, me, svid, nxt, p_content, p_confidence, p_forecast, p_horizon,
          p_rationale, p_token)
  returning id into rid;

  return query select rid, nxt, false;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Grants unchanged, and stated
-- ---------------------------------------------------------------------------
-- `scenario_version_id` is deliberately NOT added to the column-scoped UPDATE grant.
-- `authenticated` holds `update (draft_payload)` and nothing else, so a draft cannot be
-- moved to a different case after the fact even by its owner. The table-level INSERT grant
-- does cover the new column, which is required: creating a draft is how a user says which
-- case they are answering, and the policy's `with check (user_id = auth.uid())` still owns
-- who the row belongs to.
revoke execute on all functions in schema app    from public, anon;
revoke execute on all functions in schema public from public, anon, authenticated, service_role;
grant execute on function app.submit_decision(uuid,uuid,jsonb,smallint,text,text,text) to authenticated;
grant execute on function app.append_revision(uuid,uuid,jsonb,smallint,text,text,text) to authenticated;
grant execute on function app.stamp_milestone(uuid,text) to authenticated;
