-- 20261021140100 The `app` schema, the identity accessors and the single state derivation.
-- Ported from migrations/0001_context_and_state.sql.
--
-- ===========================================================================
-- WHAT CHANGED, AND THE ONE THING THAT IS LOST
-- ===========================================================================
-- Canon §4.3 built `app.current_user_id()` as "the Supabase port seam, and nothing else
-- uses it". This is that seam being used. The GUC `app.current_user_id`, set per
-- transaction by ADR-0006's `withUser`, is gone: there is no server pool to set it from.
-- Identity now comes from `auth.uid()`, which reads the claim PostgREST sets from the
-- verified JWT.
--
-- THE LOSS, stated once here and measured by the controls in the migrations that follow:
-- `app.require_user_id()` RAISED 28000 when identity was missing. `auth.uid()` returns
-- NULL. ADR-0015 records the paired control that establishes denial and
-- forgery-prevention both still hold — as `authenticated` with no claim, 0 rows and no
-- error; with A's claim, 1 row; A reading B's row, 0; A inserting a row owned by B
-- rejected with "new row violates row-level security policy". So the wall holds; what is
-- gone is that a context failure announces itself. V6's fail-loud property cannot live in
-- a policy predicate any more.
--
-- Two consequences this file acts on rather than notes:
--
--   * POLICIES call `auth.uid()` directly. They do NOT call a raising wrapper. A policy
--     predicate that raised would be a different failure mode from the live target's and
--     every local denial test would then be measuring our wrapper.
--   * `app.require_user_id()` SURVIVES, and is the raising accessor still, but its only
--     callers are the lifecycle SECURITY DEFINER functions of ADR-0014. A function body
--     is not a policy predicate: there, failing loudly is still available and still
--     correct, so the fail-loud property is kept in the one place it can be. A
--     `submit_decision` called with no identity raises 28000 instead of reporting
--     "not a submittable draft" (ST010), which is the difference between a diagnosable
--     bug and a confusing one.
--
-- Because a missing identity is now silent in policies, the sentinel rule of V18 stops
-- being hygiene and becomes the thing that makes a zero-row result mean anything at all.
-- See 20261021140600_sentinels.sql and posture rule 9.
-- ===========================================================================

set role postgres;

create schema if not exists app authorization postgres;

create type app.decision_state as enum
  ('draft','submitted','challenged','reflected','action_recorded','reviewed_closed');

-- ---------------------------------------------------------------------------
-- app.current_user_id() — the non-raising accessor. Kept as an alias, per the task's
-- instruction and because the lifecycle layer and a later Edge Function may both want a
-- name that does not depend on the platform's schema.
-- ---------------------------------------------------------------------------
-- STABLE, never IMMUTABLE: an IMMUTABLE identity shim was proven in Slice 1 to leak one
-- user's rows to another from a prepared statement's second execution onward.
-- docs/supabase-target.md §1 measured the real `auth.uid()` at provolatile='s', which
-- matches. Posture rule 6 asserts the catalog value for both.
create function app.current_user_id() returns uuid
  language sql stable set search_path = pg_catalog as $$
  select auth.uid()
$$;

-- ---------------------------------------------------------------------------
-- app.require_user_id() — the raising accessor, now wrapping auth.uid().
-- ---------------------------------------------------------------------------
-- NOT used in any policy. Used by every lifecycle definer function, where a missing
-- identity is a bug in the caller and should say so. The 28000 and the error text are
-- unchanged from migrations/0001 on purpose: existing tests and the mutation registry
-- name that SQLSTATE, and nothing about moving the source of the identity changes what
-- "no user context" means.
--
-- Do NOT add this to a policy predicate as a "defence in depth" improvement. It would
-- make local behaviour diverge from the live target in the exact direction that makes a
-- denial test pass for the wrong reason.
create function app.require_user_id() returns uuid
  language plpgsql stable set search_path = pg_catalog as $$
declare v uuid := auth.uid();
begin
  if v is null then
    raise exception 'no user context' using errcode = '28000';
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- ONE definition of what the state is (V29), unchanged by the port.
-- ---------------------------------------------------------------------------
-- Used by the generated column AND by the transition guard, so they cannot drift.
-- Per-branch enum casts, never a cast of the CASE result (V12). PostgreSQL 17.11 on the
-- target is identical to local (docs/supabase-target.md §1), so V12, V28 and V29 carry
-- over without re-derivation.
create function app.derive_decision_state(
  p_submitted timestamptz, p_challenged timestamptz, p_reflected timestamptz,
  p_action timestamptz, p_closed timestamptz
) returns app.decision_state language sql immutable set search_path = pg_catalog as $$
  select case
    when p_closed     is not null then 'reviewed_closed'::app.decision_state
    when p_action     is not null then 'action_recorded'::app.decision_state
    when p_reflected  is not null then 'reflected'::app.decision_state
    when p_challenged is not null then 'challenged'::app.decision_state
    when p_submitted  is not null then 'submitted'::app.decision_state
    else 'draft'::app.decision_state end
$$;

create function app.forbid_mutation() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  raise exception '% is append-only', TG_TABLE_NAME using errcode = 'ST001';
end $$;

-- ---------------------------------------------------------------------------
-- Grants. `authenticated` replaces `statesman_app`; `anon` gets NOTHING, here and
-- everywhere else in this set.
-- ---------------------------------------------------------------------------
-- STATED, because the task asks where a public read is genuinely wanted: for STATESMAN OS
-- it is NOWHERE. Every table holds either a user's own decision journal (FR-14 private
-- workspace) or the scenario content a signed-in user works through. There is no
-- anonymous read path, so `anon` ends every migration in this set holding no privilege on
-- any object — which posture rule 1 enforces rather than trusting.
grant usage on schema app to authenticated;

-- V2/V30: a new function is created with EXECUTE granted to PUBLIC and only an explicit
-- REVOKE after creation removes it. Repeated at the end of every migration in this set,
-- per canon §4.2 consequence 1 — "every migration", not "every migration that adds a
-- function".
--
-- THE GRANTEE LISTS DIFFER BY SCHEMA, AND THAT IS NOT AN OVERSIGHT.
--
-- Schema `app` is revoked from `public` and `anon` ONLY. `authenticated` must NOT appear
-- in a blanket `revoke ... on all functions in schema app`, because every migration in
-- this set ends with one and `ALL FUNCTIONS` means every function that exists by then —
-- including the ones an EARLIER migration deliberately granted. MEASURED: with
-- `authenticated` in this list, 20261021140300 silently revoked the grant on
-- `app.derive_decision_state` made right here, and the first `insert into public.decision`
-- as `authenticated` failed with "permission denied for function derive_decision_state",
-- because a generated column evaluates its expression as the INSERTING role. The failure
-- surfaced three migrations away from its cause. The original migrations/0001 revoked
-- from `public` alone for exactly this reason; widening the list to cover Supabase's
-- default ACL re-introduced the hazard the narrow list avoided.
--
-- Schema `public` names all four, because Supabase's default ACL grants EXECUTE on a new
-- function in `public` to anon/authenticated/service_role DIRECTLY, and revoking from
-- PUBLIC does not touch a direct grant. The wide list is safe there only because this
-- project creates no functions in `public` at all — every one lives in `app`. If that
-- ever changes, this list has the same hazard and must be narrowed the same way.
revoke execute on all functions in schema app    from public, anon;
revoke execute on all functions in schema public from public, anon, authenticated, service_role;

grant execute on function app.current_user_id() to authenticated;
grant execute on function app.require_user_id() to authenticated;
grant execute on function app.derive_decision_state(
  timestamptz,timestamptz,timestamptz,timestamptz,timestamptz) to authenticated;
