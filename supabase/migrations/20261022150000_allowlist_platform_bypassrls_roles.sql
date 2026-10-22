-- 20261022150000 — allowlist the Supabase platform roles that posture rule 11 and 12
-- correctly flagged on the LIVE project, and record what allowlisting them actually costs.
--
-- WHY THIS MIGRATION EXISTS
--
-- The migration set was developed against scripts/emulate-supabase.sh, which creates the
-- four roles the set itself needs (anon, authenticated, service_role, authenticator). The
-- real project carries more, and on the first push `app.verify_security_posture()` failed
-- with six violations naming four of them. That is the posture check WORKING: these are
-- real roles with real reach over real tables, and the emulation could not have told us
-- about them. It is also the limit of the emulation, stated plainly rather than discovered
-- later.
--
-- MEASURED ON THE LIVE PROJECT (onpkspfxfmjkqpomcsse), not assumed:
--
--   role                     rolbypassrls  rolcanlogin  pg_read_all_data
--   supabase_etl_admin           true         true          true
--   supabase_read_only_user      true         true          true
--   supabase_storage_admin       false        true          false
--   supabase_realtime_admin      false        false         false
--
-- And where the reach comes from. `public.decision`'s ACL is
-- `{postgres=arwdDxtm/postgres, authenticated=ar/postgres}` — there is NO explicit grant
-- to any of these four. Their SELECT on all 11 public tables is inherent to
-- `pg_read_all_data` membership, and the other two reach BYPASSRLS only by membership of
-- `service_role`.
--
-- THEREFORE IT IS NOT REVOCABLE BY US. A `revoke` would have nothing to act on, and
-- stripping these roles' memberships would break the platform features they exist for
-- (read replicas, ETL, realtime, storage). Allowlisting is the only available action, so
-- the allowlist entry has to carry the cost rather than imply there isn't one.
--
-- THE COST, STATED WITHOUT SOFTENING IT:
--
-- `supabase_etl_admin` and `supabase_read_only_user` are LOGIN roles that BYPASS RLS and
-- hold pg_read_all_data. Anyone able to authenticate as either reads every row of the
-- private decision journal, and no policy in this schema can prevent it. PRD §10.2 makes
-- the account owner "the only default reader of private development records"; on managed
-- infrastructure that is true of the application's own access paths and NOT true of the
-- platform operator's. ADR-0015 already recorded that moving to Supabase trades defence in
-- depth for a public URL. This is the concrete shape of that trade, and it is the one
-- consequence a reader of this repo should not be able to miss.
--
-- Allowlisting them does NOT make them safe. It records that the posture check has seen
-- them, that their reach was measured, and that it cannot be reduced from inside the
-- database. The residual is carried in docs/threat-model.md and docs/supabase-target.md.
--
-- `supabase_realtime_admin` cannot log in at all (rolcanlogin=false), so its reach is
-- latent; it is allowlisted for completeness rather than because it is reachable.

set role postgres;

insert into public.posture_bypassrls_allow (rolname, reason) values
  ('supabase_etl_admin',
   'Supabase platform role for ETL and analytics replication. MEASURED on the live '
   || 'project: rolbypassrls=true, rolcanlogin=true, member of pg_read_all_data, and it '
   || 'holds SELECT on all 11 public tables through that membership rather than through '
   || 'any grant we made. NOT REVOCABLE from inside the database. RESIDUAL RISK: anyone '
   || 'authenticating as this role reads the entire private journal and no policy can '
   || 'stop it.'),
  ('supabase_read_only_user',
   'Supabase platform role backing read replicas. MEASURED: rolbypassrls=true, '
   || 'rolcanlogin=true, member of pg_read_all_data, SELECT on all 11 public tables by '
   || 'membership. NOT REVOCABLE from inside the database. Same residual risk as '
   || 'supabase_etl_admin: full read of the private journal, bypassing RLS.'),
  ('supabase_storage_admin',
   'Supabase Storage. MEASURED: rolbypassrls=false and NOT a member of pg_read_all_data; '
   || 'it reaches BYPASSRLS only by membership of service_role, whose key must never be '
   || 'published (ADR-0015). Holds direct SELECT on 0 of our tables. Lower risk than the '
   || 'two above, and allowlisted for the membership path alone.'),
  ('supabase_realtime_admin',
   'Supabase Realtime. MEASURED: rolbypassrls=false, ROLCANLOGIN=FALSE, so it cannot '
   || 'connect; it reaches BYPASSRLS only by membership of service_role. Holds direct '
   || 'SELECT on 0 of our tables. Latent rather than reachable, allowlisted for '
   || 'completeness so rule 11 does not fail on a role nobody can use.')
on conflict (rolname) do update set reason = excluded.reason;

-- CONTROL. An allowlist that silently accepted a role name which is not actually
-- bypassrls-reachable would be a pre-approved slot for a future privileged role, so assert
-- that every row we just added corresponds to a role that genuinely exists and genuinely
-- has the reach the reason claims. On a database where these platform roles are absent
-- (the local emulation) the rows are inert and this control must not fail, so absence is
-- explicitly tolerated while a PRESENT-but-not-privileged role is not.
do $$
declare bad text := '';
        r record;
begin
  for r in
    select a.rolname
      from public.posture_bypassrls_allow a
      join pg_roles g on g.rolname = a.rolname
     where a.rolname like 'supabase_%'
       and not (
         g.rolbypassrls
         or exists (select 1 from pg_roles p
                     where (p.rolsuper or p.rolbypassrls)
                       and p.rolname <> g.rolname
                       and pg_has_role(g.rolname, p.oid, 'MEMBER'))
       )
  loop
    bad := bad || format(E'\n  allowlisted but not bypassrls-reachable: %s', r.rolname);
  end loop;

  if bad <> '' then
    raise exception 'ALLOWLIST CONTROL FAILED — a row admits a role that does not need '
      'admitting, which is a pre-approved slot for a future privileged role:%', bad
      using errcode = 'ST098';
  end if;
end $$;

-- V2/V30: a migration that creates no function still ends with the revokes, because the
-- rule is "every migration", and an exception for the easy cases is how the habit dies.
revoke execute on all functions in schema app    from public, anon;
revoke execute on all functions in schema public from public, anon;
