-- 0005 The posture check. Runs at the END of every migration run in EVERY environment.
-- Rule 4 is the PRIMARY control for the PUBLIC-EXECUTE hazard, because V30 proved there
-- is no structural default that protects a function added later.
\set ON_ERROR_STOP on
set role statesman_owner;

create table if not exists public.posture_exempt_table (
  table_name text primary key,
  reason     text not null
);
insert into public.posture_exempt_table (table_name, reason) values
  ('app_user',             'grant-protected: no app grants, definer functions only'),
  ('user_session',         'grant-protected'),
  ('auth_attempt',         'grant-protected'),
  ('posture_exempt_table', 'the exemption registry itself')
on conflict (table_name) do nothing;

create or replace function app.verify_security_posture() returns void
  language plpgsql set search_path = pg_catalog, app, public as $$
declare r record; bad text := '';
begin
  -- 1 REACHABILITY: any table statesman_app can touch must be RLS-enabled AND forced
  --   AND carry at least one policy. Column-name independent on purpose: an
  --   attname='user_id' selector misses app_user (whose column is id) and every
  --   indirectly scoped table.
  for r in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p')
      and (has_table_privilege('statesman_app', c.oid, 'SELECT')
        or has_table_privilege('statesman_app', c.oid, 'INSERT')
        or has_table_privilege('statesman_app', c.oid, 'UPDATE')
        or has_table_privilege('statesman_app', c.oid, 'DELETE'))
      and not (c.relrowsecurity and c.relforcerowsecurity
               and (select count(*) from pg_policy where polrelid = c.oid) > 0)
  loop bad := bad || format(E'\n  reachable without forced RLS + policy: %s', r.relname); end loop;

  -- 2 ENUMERATION: every public table is forced-RLS or explicitly exempt, so a new
  --   table fails by default rather than passing unnoticed.
  for r in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p')
      and c.relname not in (select table_name from public.posture_exempt_table)
      and not (c.relrowsecurity and c.relforcerowsecurity)
  loop bad := bad || format(E'\n  not forced-RLS and not exempt: %s', r.relname); end loop;

  -- 3 OWNERSHIP: ownership bypasses RLS independently of rolsuper/rolbypassrls (V4)
  for r in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p')
      and pg_get_userbyid(c.relowner) = 'statesman_app'
  loop bad := bad || format(E'\n  owned by statesman_app: %s', r.relname); end loop;

  -- 4 NO PUBLIC EXECUTE (V2, V30). PRIMARY control, not a backstop.
  for r in
    select p.oid::regprocedure::text as f
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('app','public') and has_function_privilege('public', p.oid, 'EXECUTE')
  loop bad := bad || format(E'\n  EXECUTE granted to PUBLIC: %s', r.f); end loop;

  -- 5 VIEWS over user data must use security_invoker (V11)
  for r in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
      and not coalesce('security_invoker=true' = any(c.reloptions), false)
  loop bad := bad || format(E'\n  view without security_invoker=true: %s', r.relname); end loop;

  -- 6 VOLATILITY: an IMMUTABLE identity shim leaks across prepared statements
  if (select p.provolatile from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='app' and p.proname='require_user_id') <> 's' then
    bad := bad || E'\n  app.require_user_id() is not STABLE';
  end if;

  -- 7 NO TRUNCATE on append-only tables (V15)
  if has_table_privilege('statesman_app','public.decision_revision','TRUNCATE') then
    bad := bad || E'\n  statesman_app holds TRUNCATE on decision_revision';
  end if;

  -- 8 POLICY SHAPE: read BOTH qual and with_check; qual IS NULL for INSERT policies (V20)
  for r in
    select schemaname||'.'||tablename||'.'||policyname as p
    from pg_policies
    where schemaname = 'public'
      and (coalesce(qual,'') = 'true' or coalesce(with_check,'') = 'true'
        or coalesce(qual,'') || ' ' || coalesce(with_check,'') not like '%require_user_id%')
  loop bad := bad || format(E'\n  policy not scoped by require_user_id(): %s', r.p); end loop;

  if bad <> '' then
    raise exception 'SECURITY POSTURE FAILED:%', bad using errcode = 'ST099';
  end if;
end $$;

revoke execute on all functions in schema app    from public;
revoke execute on all functions in schema public from public;
