-- 20261021140500 The posture check, rewritten for Supabase.
-- Ported from migrations/0005_verify_security_posture.sql.
--
-- ===========================================================================
-- WHY THIS FILE IS NOW THE LOAD-BEARING ONE
-- ===========================================================================
-- Three layers used to stand between a mistake and the journal: the server boundary
-- (`withUser`, the eager probe, `DISCARD ALL`), the grant model, and RLS. ADR-0015
-- removes the first two. The publishable anon key is public by design and that is
-- correct, but it means this database is reachable from the internet with nothing behind
-- RLS, and a single policy error is a full breach.
--
-- ADR-0015 therefore says, in as many words, that the posture check and the mutation gate
-- "stop being good practice and become the only thing standing between a policy typo and
-- the journal. This is now a release gate, not a quality measure."
--
-- RULES THAT CHANGED IN THE PORT
--   1  REACHABILITY   `statesman_app` -> `authenticated`, PLUS a new clause: `anon` must
--                     hold no privilege on any public table at all. Needed because a
--                     stock Supabase project's default ACL grants ALL on new tables in
--                     `public` to anon (see 20261021140000), so the dangerous state is
--                     the DEFAULT here rather than an oversight.
--   3  OWNERSHIP      was "not owned by statesman_app". On the target `public` is owned by
--                     `pg_database_owner` and our relations by `postgres`, so the rule is
--                     restated as its actual intent: no relation may be owned by a role a
--                     browser client can become.
--   4  NO PUBLIC EXEC extended from PUBLIC to PUBLIC *and* `anon`, because the default ACL
--                     grants EXECUTE to anon directly and revoking from PUBLIC does not
--                     touch a direct grant.
--   6  VOLATILITY     now covers `auth.uid()` and `app.current_user_id()` as well.
--   7  NO TRUNCATE    generalised from one hardcoded table to every table carrying a
--                     BEFORE TRUNCATE trigger, so 0008's five are covered automatically.
--   8  POLICY SHAPE   must mention `auth.uid()` rather than `require_user_id`.
--   9  SENTINELS      split into 9a/9b so that NO protected table escapes the rule. See
--                     below: this is the rule the port makes indispensable.
--
-- RULES ADDED BY THE PORT
--  11  BYPASSRLS      no role that is, or can become, BYPASSRLS may exist outside a
--                     version-controlled allowlist. This is the port's single most
--                     dangerous fact turned into a gate.
--  12  BROAD GRANTS   the same for `pg_read_all_data` / `pg_write_all_data` membership,
--                     which V34 recorded slipping through an attribute-only predicate.
--
-- WHY RULE 9 IS NOW INDISPENSABLE RATHER THAN THOROUGH
-- `app.require_user_id()` raised 28000 when identity was missing; `auth.uid()` returns
-- NULL. A read with no claim now returns zero rows and raises nothing. V7 already said a
-- row count of 0 is never a success signal, and V18 said an empty table with RLS and an
-- empty table with NO RLS both return 0. Put together, on an EMPTY table a correct
-- policy, a broken policy and no policy at all are now three names for the same observed
-- result. A seeded sentinel is the only thing that turns "0 rows" back into evidence, so
-- rule 9 is what makes every denial test in the suite non-vacuous.
--
-- The old rule 9 skipped any table in posture_exempt_table, and 0008 used that to waive
-- its five reference tables because their sentinels are keyed by `id`, not `user_id`.
-- That left five protected tables with no enforced sentinel. Rule 9b closes it: a
-- protected table without a `user_id` column must be registered in
-- `public.posture_sentinel_row` with the column and value that identify its sentinel, and
-- that row is counted. There is no longer any way for a protected table to carry no
-- sentinel requirement.
-- ===========================================================================

set role postgres;

-- ---------------------------------------------------------------------------
-- Registry 1: rule 2's exemption list.
-- ---------------------------------------------------------------------------
-- Far shorter than it was. `app_user`, `user_session` and `auth_attempt` were exempt as
-- "grant-protected: no app grants, definer functions only"; all three are gone
-- (20261021140200) and `public.profile` which replaces them is a normal forced-RLS table
-- with a tenancy policy and a sentinel, needing no waiver. What remains is the three
-- registries themselves, which hold no user data and are reachable by nobody.
create table if not exists public.posture_exempt_table (
  table_name text primary key,
  reason     text not null
);
insert into public.posture_exempt_table (table_name, reason) values
  ('posture_exempt_table',
   'the rule-2 exemption registry itself: no user data, no grants to anon or authenticated'),
  ('posture_bypassrls_allow',
   'the rule-11 allowlist registry: no user data, no grants to anon or authenticated'),
  ('posture_sentinel_row',
   'the rule-9b sentinel registry: no user data, no grants to anon or authenticated')
on conflict (table_name) do nothing;

-- ---------------------------------------------------------------------------
-- Registry 2: rule 11's BYPASSRLS allowlist.
-- ---------------------------------------------------------------------------
-- Every row is a role that may ignore every policy. Each carries a reason, because an
-- allowlist without reasons becomes a place to put whatever is currently failing.
create table if not exists public.posture_bypassrls_allow (
  rolname text primary key,
  reason  text not null
);
insert into public.posture_bypassrls_allow (rolname, reason) values
  ('postgres',
   'MANDATED BY SUPABASE. rolsuper=false but rolbypassrls=true (docs/supabase-target.md 2), measured. It is the role the CLI and the dashboard SQL editor use by default, so any probe that connects as it enforces NOTHING while passing. Migrations run as this role; tests must NEVER connect as it, and the harness guard must ABORT rather than warn.'),
  ('service_role',
   'MANDATED BY SUPABASE. Created NOLOGIN BYPASSRLS. Reached with the service key, which must never appear in the repository, the static bundle, or CI logs (docs/supabase-target.md 5).'),
  ('supabase_admin',
   'MANDATED BY SUPABASE. Platform-owned. Present on the target per docs/supabase-target.md 1; its role attributes were NOT measured there, so this row is a declared assumption to confirm against the live project rather than a verified fact.'),
  ('authenticator',
   'MANDATED BY SUPABASE. Not bypassrls itself, but holds service_role by membership and is NOINHERIT, so `set role service_role` is available to it — V3 exactly: an attribute check passes it while SET ROLE succeeds. It is what PostgREST connects as. Flagged by rule 11 for the right reason and admitted because the platform requires it.')
on conflict (rolname) do nothing;

-- The local-emulation concession, and the reason it cannot leak to the live project.
-- On this machine the login role is rolsuper=t, rolbypassrls=t with `trust` auth (V1), so
-- rule 11 would fire on every local run. "Ignore superusers" is NOT an option: that is
-- precisely the V1/V34 mistake in which a privilege predicate reading role attributes
-- passed a privileged role. Instead the concession is gated on `auth.is_emulation()`,
-- which scripts/emulate-supabase.sh creates and nothing else does. On project
-- onpkspfxfmjkqpomcsse the function does not exist, the WHERE clause is false, no
-- superuser is admitted, and a stray bypassrls role there is reported.
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'auth' and p.proname = 'is_emulation') then
    insert into public.posture_bypassrls_allow (rolname, reason)
    select r.rolname,
           'LOCAL EMULATION ONLY. Cluster superuser with pg_hba trust (V1); no such role '
           'exists on a Supabase project, where postgres is NOSUPERUSER. Admitted only '
           'because auth.is_emulation() is present, which is true on no Supabase project.'
      from pg_roles r
     where r.rolsuper
    on conflict (rolname) do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Registry 3: rule 9b's sentinel locator, for protected tables with no user_id column.
-- ---------------------------------------------------------------------------
-- `id_column` and `sentinel_id` are catalog-checked and passed through format('%I') and a
-- bind parameter respectively; no free-form SQL is ever stored or executed. The rows for
-- 0008's five reference tables are inserted by that migration, beside the sentinels they
-- describe, so the locator and the row it locates cannot be added separately.
create table if not exists public.posture_sentinel_row (
  table_name  text primary key,
  id_column   text not null,
  sentinel_id text not null,
  reason      text not null
);

-- ---------------------------------------------------------------------------
create or replace function app.verify_security_posture() returns void
  language plpgsql set search_path = pg_catalog, app, public as $$
declare
  r record;
  bad text := '';
  n bigint;
  prev_sub text;
  prev_claims text;
  -- The reserved sentinel owner of 20261021140600. Spelled once, here, because rule 9a
  -- has to both set the identity claim and filter on the column.
  sentinel constant uuid := '00000000-0000-0000-0000-00000000dead';
begin
  -- 1 REACHABILITY.
  --   1a: any table `authenticated` can touch must be RLS-enabled AND forced AND carry at
  --   least one policy. Column-name independent on purpose: an attname='user_id' selector
  --   misses every indirectly scoped table, which canon §4.8 records.
  for r in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p')
      and (has_table_privilege('authenticated', c.oid, 'SELECT')
        or has_table_privilege('authenticated', c.oid, 'INSERT')
        or has_table_privilege('authenticated', c.oid, 'UPDATE')
        or has_table_privilege('authenticated', c.oid, 'DELETE'))
      and not (c.relrowsecurity and c.relforcerowsecurity
               and (select count(*) from pg_policy where polrelid = c.oid) > 0)
  loop bad := bad || format(E'\n  reachable by authenticated without forced RLS + policy: %s',
                            r.relname); end loop;

  --   1b: `anon` must hold NOTHING. There is no anonymous read path in this product: every
  --   table is either a user's private journal (FR-14) or content for a signed-in user. On
  --   a stock Supabase project the default ACL grants ALL on a new table in `public` to
  --   anon, so this is the normal failure here, not an exotic one, and forced RLS would
  --   not save it — an `anon` request with no claim is exactly the case where auth.uid()
  --   is NULL and the policy denies silently, which is survivable, but an anon role
  --   holding INSERT or DELETE on an identity table is not something to leave to a
  --   predicate.
  for r in
    select c.relname, p.priv from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as p(priv)
    where n.nspname = 'public' and c.relkind in ('r','p')
      and has_table_privilege('anon', c.oid, p.priv)
  loop bad := bad || format(E'\n  anon holds %s on %s (there is no anonymous path in this product)',
                            r.priv, r.relname); end loop;

  -- 2 ENUMERATION: every public table is forced-RLS or explicitly exempt, so a new table
  --   fails by default rather than passing unnoticed.
  for r in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p')
      and c.relname not in (select table_name from public.posture_exempt_table)
      and not (c.relrowsecurity and c.relforcerowsecurity)
  loop bad := bad || format(E'\n  not forced-RLS and not exempt: %s', r.relname); end loop;

  -- 3 OWNERSHIP: ownership bypasses RLS independently of rolsuper/rolbypassrls (V4), and
  --   under ENABLE-without-FORCE it is the owner's ordinary bypass. On Supabase our
  --   relations are owned by `postgres` and `public` by `pg_database_owner`, so the old
  --   rule ("not owned by statesman_app") cannot be ported literally. Its intent is kept:
  --   no relation may be owned by a role a browser client can resolve to, because such a
  --   role would read every row regardless of policy.
  for r in
    select c.relname, pg_get_userbyid(c.relowner) as owner
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r','p','v','m')
      and pg_get_userbyid(c.relowner) in ('anon','authenticated','service_role')
  loop bad := bad || format(E'\n  owned by a client-reachable role (%s): %s',
                            r.owner, r.relname); end loop;

  -- 4 NO PUBLIC EXECUTE (V2, V30). PRIMARY control, not a backstop: nothing prevents the
  --   next function from being PUBLIC-executable, and ALTER DEFAULT PRIVILEGES REVOKE is a
  --   silent no-op. `anon` is checked alongside PUBLIC because Supabase's default ACL
  --   grants it EXECUTE directly and a REVOKE from PUBLIC does not touch a direct grant.
  for r in
    select p.oid::regprocedure::text as f, g.grantee
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join unnest(array['public','anon']) as g(grantee)
    where n.nspname in ('app','public') and has_function_privilege(g.grantee, p.oid, 'EXECUTE')
  loop bad := bad || format(E'\n  EXECUTE granted to %s: %s', r.grantee, r.f); end loop;

  -- 5 VIEWS over user data must use security_invoker (V11)
  for r in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
      and not coalesce('security_invoker=true' = any(c.reloptions), false)
  loop bad := bad || format(E'\n  view without security_invoker=true: %s', r.relname); end loop;

  -- 6 VOLATILITY: an IMMUTABLE identity shim leaks across prepared statements. All three
  --   accessors are checked, including the platform's own `auth.uid()` —
  --   docs/supabase-target.md §1 measured it at provolatile='s', and
  --   scripts/emulate-supabase.sh must not create a shim that diverges.
  for r in
    select x.nsp, x.fn from (values ('app','require_user_id'), ('app','current_user_id'),
                                    ('auth','uid')) as x(nsp, fn)
    where coalesce((select p.provolatile from pg_proc p
                      join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = x.nsp and p.proname = x.fn), 'x') <> 's'
  loop bad := bad || format(E'\n  %s.%s() is missing or not STABLE', r.nsp, r.fn); end loop;

  -- 7 NO TRUNCATE on append-only tables (V15). Generalised from the single hardcoded
  --   table of migrations/0005: every table carrying a statement-level BEFORE TRUNCATE
  --   trigger is append-only or immutable by intent, and the trigger plus the absent grant
  --   are two controls because V15 is precisely the case where one looks sufficient.
  for r in
    select distinct c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_trigger t on t.tgrelid = c.oid
    where n.nspname = 'public' and c.relkind in ('r','p')
      and (t.tgtype & 32) <> 0                                 -- TRUNCATE
      and not t.tgisinternal
      and has_table_privilege('authenticated', c.oid, 'TRUNCATE')
  loop bad := bad || format(E'\n  authenticated holds TRUNCATE on a truncate-guarded table: %s',
                            r.relname); end loop;

  -- 8 POLICY SHAPE: read BOTH qual and with_check; qual IS NULL for INSERT policies (V20).
  --   The accessor named is now `auth.uid`, not `require_user_id` — a policy still written
  --   against the retired GUC accessor would be scoped by a value nothing sets any more,
  --   so this clause catches an incompletely ported policy as well as an unscoped one.
  for r in
    select schemaname||'.'||tablename||'.'||policyname as p
    from pg_policies
    where schemaname = 'public'
      and (coalesce(qual,'') = 'true' or coalesce(with_check,'') = 'true'
        or coalesce(qual,'') || ' ' || coalesce(with_check,'') not like '%auth.uid()%')
  loop bad := bad || format(E'\n  policy not scoped by auth.uid(): %s', r.p); end loop;

  -- 9 SENTINELS (V18). THE rule the port makes indispensable: with auth.uid() returning
  --   NULL instead of raising, an empty forced table and an unprotected one return the
  --   same zero rows and raise the same nothing, so a denial test over an empty table
  --   cannot be made to fail and has therefore not been shown to work.
  --
  --   WHY THE IDENTITY CLAIM IS SWAPPED: under FORCE the owner is subject to the tenancy
  --   policy too (V8/V9). This function runs as `postgres`, which is BYPASSRLS, so today
  --   the counts below are unfiltered — but that is a property of the caller, not of the
  --   function, and a caller that is NOT bypassrls would otherwise see 0 everywhere and
  --   report every sentinel missing. Setting the claim to the sentinel makes the rule
  --   correct for both callers. The claim is restored explicitly afterwards, because V17
  --   measured set_config(…, true) persisting after a function with a SET clause returns.
  --   Both GUC forms are saved and restored, since auth.uid() coalesces them.
  prev_sub    := current_setting('request.jwt.claim.sub', true);
  prev_claims := current_setting('request.jwt.claims', true);
  begin
    perform set_config('request.jwt.claim.sub', sentinel::text, true);
    perform set_config('request.jwt.claims', '', true);

    for r in
      select c.relname,
             exists (select 1 from pg_attribute a
                      where a.attrelid = c.oid and a.attname = 'user_id'
                        and a.attnum > 0 and not a.attisdropped) as has_user_id,
             (select s.id_column   from public.posture_sentinel_row s
               where s.table_name = c.relname) as reg_col,
             (select s.sentinel_id from public.posture_sentinel_row s
               where s.table_name = c.relname) as reg_val
        from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = 'public' and c.relkind in ('r','p')
         and c.relrowsecurity and c.relforcerowsecurity
       order by c.relname
    loop
      if r.has_user_id then
        -- 9a: the ordinary case. format('%I') on a catalog-sourced name; the value is a
        -- bind parameter.
        execute format('select count(*) from public.%I where user_id = $1', r.relname)
          into n using sentinel;
        if n <> 1 then
          bad := bad || format(E'\n  rule 9a: sentinel rows in %s: %s, expected exactly 1',
                               r.relname, n);
        end if;
      elsif r.reg_col is null then
        -- 9b, unregistered. NOT skipped, and NOT waivable through posture_exempt_table
        -- any more: that is the gap the old rule left, and it left five protected
        -- reference tables with no enforced sentinel at all.
        bad := bad || format(
          E'\n  rule 9b: protected table %s has no user_id column and no '
           'public.posture_sentinel_row entry, so it carries no enforced sentinel. An '
           'empty forced table does not deny (V18), so a denial test over it is vacuous.',
          r.relname);
      elsif not exists (select 1 from pg_attribute a
                         where a.attrelid = format('public.%I', r.relname)::regclass
                           and a.attname = r.reg_col
                           and a.attnum > 0 and not a.attisdropped) then
        bad := bad || format(
          E'\n  rule 9b: %s registers sentinel column %s, which does not exist',
          r.relname, r.reg_col);
      else
        -- 9b, registered. Both identifiers come from the catalog or are checked against
        -- it; the value is a bind parameter, compared as text so one registry serves uuid,
        -- text and integer keys alike.
        execute format('select count(*) from public.%I where %I::text = $1',
                       r.relname, r.reg_col)
          into n using r.reg_val;
        if n <> 1 then
          bad := bad || format(
            E'\n  rule 9b: sentinel rows in %s where %s = %s: %s, expected exactly 1',
            r.relname, r.reg_col, r.reg_val, n);
        end if;
      end if;
    end loop;

    perform set_config('request.jwt.claim.sub', coalesce(prev_sub, ''), true);
    perform set_config('request.jwt.claims',    coalesce(prev_claims, ''), true);
  exception when others then
    -- Restore FIRST, then fail CLOSED with this function's own SQLSTATE rather than
    -- letting a foreign code (42501, 22P02) escape and read as an unrelated fault.
    perform set_config('request.jwt.claim.sub', coalesce(prev_sub, ''), true);
    perform set_config('request.jwt.claims',    coalesce(prev_claims, ''), true);
    bad := bad || format(E'\n  sentinel rule could not be evaluated: %s (%s)',
                         sqlerrm, sqlstate);
  end;

  -- 10 NOT NULL: a nullable user_id makes `user_id = auth.uid()` evaluate to NULL rather
  --    than false, so such a row is outside every policy in BOTH directions — invisible
  --    to its owner and unprotected by the predicate meant to scope it. Catalog-only, and
  --    deliberately NOT exempt-aware.
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

  -- 11 BYPASSRLS (NEW, and the reason ADR-0015 calls this a release gate).
  --    "Supabase's `postgres` role has rolbypassrls = true while rolsuper is false, so it
  --    reads as restricted." A role that is — or can BECOME — bypassrls enforces nothing:
  --    tenancy, cross-user denial and forgery all pass for it. So the rule is not "which
  --    tables can it reach", it is "does such a role exist outside the allowlist at all",
  --    because a bypassrls role reaches everything by definition and a table-level
  --    reachability test would report the symptom rather than the cause.
  --
  --    pg_has_role(…, 'MEMBER') and not 'USAGE': V3 measured a role with
  --    rolbypassrls=false that was a MEMBER of a BYPASSRLS role passing an attribute
  --    check while `SET ROLE` to it succeeded. MEMBER includes the role itself, so one
  --    predicate covers the attribute case and the membership case together.
  for r in
    select g.rolname,
           (select string_agg(b.rolname, ', ' order by b.rolname) from pg_roles b
             where b.rolbypassrls and pg_has_role(g.oid, b.oid, 'MEMBER')) as via,
           (select count(*) from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
             where ns.nspname = 'public' and c.relkind in ('r','p')
               and has_table_privilege(g.oid, c.oid, 'SELECT')) as direct_reach
      from pg_roles g
     where exists (select 1 from pg_roles b
                    where b.rolbypassrls and pg_has_role(g.oid, b.oid, 'MEMBER'))
       and g.rolname not in (select rolname from public.posture_bypassrls_allow)
     order by g.rolname
  loop
    bad := bad || format(
      E'\n  rule 11: role %s is or can become BYPASSRLS (via %s) and is not in '
       'public.posture_bypassrls_allow. It reaches every row of every table regardless of '
       'policy; it holds direct SELECT on %s public tables. Tests must never connect as '
       'it, and the harness must ABORT rather than warn.',
      r.rolname, r.via, r.direct_reach);
  end loop;

  -- 12 BROAD GRANTS. V34 recorded pg_read_all_data and pg_write_all_data each slipping
  --    through a privilege predicate separately. They do not carry BYPASSRLS, so rule 11
  --    misses them and RLS does still apply — but they confer table access on everything
  --    that exists and everything added later, which defeats the per-table reasoning
  --    rules 1 and 2 are built on. Same allowlist, so an intended holder is recorded by
  --    name with a reason.
  for r in
    select g.rolname,
           (select string_agg(b.rolname, ', ' order by b.rolname) from pg_roles b
             where b.rolname in ('pg_read_all_data','pg_write_all_data')
               and pg_has_role(g.oid, b.oid, 'MEMBER')) as via
      from pg_roles g
     where g.rolname not in ('pg_read_all_data','pg_write_all_data')
       and exists (select 1 from pg_roles b
                    where b.rolname in ('pg_read_all_data','pg_write_all_data')
                      and pg_has_role(g.oid, b.oid, 'MEMBER'))
       and g.rolname not in (select rolname from public.posture_bypassrls_allow)
     order by g.rolname
  loop
    bad := bad || format(
      E'\n  rule 12: role %s holds %s by membership and is not allowlisted', r.rolname, r.via);
  end loop;

  if bad <> '' then
    raise exception 'SECURITY POSTURE FAILED:%', bad using errcode = 'ST099';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The registries hold no user data and are reachable by nobody. REVOKE first: on a stock
-- project the default ACL would have handed anon and authenticated full rights on all
-- three at create time, which would then fail rule 1b and rule 2 together — correctly,
-- but it is better not to create the state at all.
revoke all on table public.posture_exempt_table    from anon, authenticated, service_role;
revoke all on table public.posture_bypassrls_allow from anon, authenticated, service_role;
revoke all on table public.posture_sentinel_row    from anon, authenticated, service_role;

-- app.verify_security_posture() is SECURITY INVOKER and is granted to NOBODY. It reads the
-- three registries, which `authenticated` cannot see, so it is callable only by
-- `postgres`: scripts/migrate.sh runs it as that role at the end of every run. It must NOT
-- be made SECURITY DEFINER and granted to `authenticated` for the convenience of running
-- it as the first integration test — a definer function owned by a bypassrls role, exposed
-- to the browser role, is the hole this whole file exists to prevent.
revoke execute on all functions in schema app    from public, anon;
revoke execute on all functions in schema public from public, anon, authenticated, service_role;
