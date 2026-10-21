-- 0001 Identity context and the single state derivation.
\set ON_ERROR_STOP on
set role statesman_owner;

create schema if not exists app authorization statesman_owner;

create type app.decision_state as enum
  ('draft','submitted','challenged','reflected','action_recorded','reviewed_closed');

-- Raises 28000 when context is missing. A non-raising accessor would return '' and the
-- policy would compare ''::uuid, which errors confusingly, or silently match nothing (V5).
create function app.require_user_id() returns uuid
  language plpgsql stable set search_path = pg_catalog as $$
declare v text := current_setting('app.current_user_id', true);
begin
  if v is null or v = '' then
    raise exception 'no user context' using errcode = '28000';
  end if;
  return v::uuid;
end $$;

-- The Supabase port seam, and nothing else uses it.
create function app.current_user_id() returns uuid
  language sql stable set search_path = pg_catalog as $$
  select nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

-- ONE definition of what the state is. Used by the generated column AND the
-- transition guard, so they cannot drift (V29). Per-branch enum casts (V12).
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

grant usage on schema app to statesman_app;

-- V30: ALTER DEFAULT PRIVILEGES cannot remove the built-in PUBLIC EXECUTE default.
-- Only an explicit REVOKE after creation works, and it must be repeated in every
-- migration that adds a function.
revoke execute on all functions in schema app    from public;
revoke execute on all functions in schema public from public;
grant execute on function app.require_user_id() to statesman_app;
grant execute on function app.derive_decision_state(
  timestamptz,timestamptz,timestamptz,timestamptz,timestamptz) to statesman_app;
