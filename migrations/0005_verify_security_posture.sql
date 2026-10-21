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
declare
  r record;
  bad text := '';
  n bigint;
  prev_context text;
  -- The reserved sentinel owner of migration 0006. Spelled once, here, because rule 9
  -- has to both set the identity context and filter on the column.
  sentinel constant uuid := '00000000-0000-0000-0000-00000000dead';
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

  -- 9 SENTINELS (V18): exactly one row owned by the reserved sentinel uuid in every
  --   RLS-protected table. An empty table with RLS and an empty table with NO RLS both
  --   return 0 to statesman_app, so without a row that *would* come back if the policy
  --   were missing, every tenancy denial downstream is vacuous. Migration 0006 seeds
  --   them; this rule is what notices when one is gone.
  --
  --   WHY THE IDENTITY CONTEXT IS SWAPPED, and why a plain count would be a disaster:
  --   this function runs as statesman_owner, and FORCE subjects the owner to the tenancy
  --   policy too (V8/V9). MEASURED on this cluster, as statesman_owner with no context:
  --   `select count(*) from public.decision` RAISES 28000 — it does not return 0,
  --   because app.require_user_id() is evaluated once at scan start rather than per
  --   candidate row (which is also the measured departure from V6 recorded in
  --   tenancy.test.ts). A naive count here would therefore abort EVERY migration run in
  --   EVERY environment with 28000. So the context is set to the sentinel for the
  --   duration of the count and restored explicitly afterwards: a set_config(…, true)
  --   issued inside a function that carries a SET clause persists after the function
  --   returns (V17), so the restore is not optional.
  --
  --   A table in posture_exempt_table is skipped: that registry is the single
  --   version-controlled list of relations that are not user-scoped (app_user's owner
  --   column is `id`, not `user_id` — canon §4.8's warning about an attname selector).
  --   A protected table that is NOT exempt and has no user_id column is reported rather
  --   than skipped, so a new indirectly-scoped table fails closed and has to be either
  --   given a sentinel or registered.
  prev_context := current_setting('app.current_user_id', true);
  begin
    perform set_config('app.current_user_id', sentinel::text, true);
    for r in
      select c.relname,
             exists (select 1 from pg_attribute a
                      where a.attrelid = c.oid and a.attname = 'user_id'
                        and a.attnum > 0 and not a.attisdropped) as has_user_id
        from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = 'public' and c.relkind in ('r','p')
         and c.relrowsecurity and c.relforcerowsecurity
         and c.relname not in (select table_name from public.posture_exempt_table)
       order by c.relname
    loop
      if not r.has_user_id then
        bad := bad || format(
          E'\n  protected table has no user_id column, so rule 9 cannot be evaluated: %s',
          r.relname);
      else
        -- format('%I') on a catalog-sourced name; the value goes in as a parameter.
        execute format('select count(*) from public.%I where user_id = $1', r.relname)
          into n using sentinel;
        if n <> 1 then
          bad := bad || format(E'\n  sentinel rows in %s: %s, expected exactly 1',
                               r.relname, n);
        end if;
      end if;
    end loop;
    perform set_config('app.current_user_id', coalesce(prev_context, ''), true);
  exception when others then
    -- Restore first, then fail CLOSED with this function's own SQLSTATE rather than
    -- letting a foreign code (42501, 28000) escape and read as an unrelated fault.
    perform set_config('app.current_user_id', coalesce(prev_context, ''), true);
    bad := bad || format(E'\n  sentinel rule could not be evaluated: %s (%s)',
                         sqlerrm, sqlstate);
  end;

  -- 10 NOT NULL: a nullable user_id makes `user_id = app.require_user_id()` evaluate to
  --    NULL rather than false, so such a row is outside every policy in both directions
  --    — invisible to its owner and unprotected by the predicate that is supposed to
  --    scope it. Catalog-only, and deliberately NOT exempt-aware: the rule is canon
  --    §4.8's "every user_id column is attnotnull", including on grant-protected tables
  --    (user_session.user_id is measured NOT NULL today).
  for r in
    select c.relname
      from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid
     where ns.nspname = 'public' and c.relkind in ('r','p')
       and a.attname = 'user_id' and a.attnum > 0 and not a.attisdropped
       and not a.attnotnull
     order by c.relname
  loop bad := bad || format(E'\n  user_id column is nullable: %s', r.relname); end loop;

  if bad <> '' then
    raise exception 'SECURITY POSTURE FAILED:%', bad using errcode = 'ST099';
  end if;
end $$;

revoke execute on all functions in schema app    from public;
revoke execute on all functions in schema public from public;
