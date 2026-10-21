-- 0000 BOOTSTRAP. Run ONCE by a superuser, outside the ordered migration sequence.
-- Cluster-level roles plus database-level hardening. Not idempotent by design:
-- re-running it should fail loudly rather than silently re-grant.
--
-- Usage:  psql -v db=statesman -v app_pw="'...'" -v mig_pw="'...'" -f 0000_bootstrap_roles.sql
\set ON_ERROR_STOP on

create role statesman_owner noinherit nologin;
create role statesman_app      login noinherit nobypassrls nosuperuser nocreatedb nocreaterole
  password :app_pw;
create role statesman_migrator login noinherit nobypassrls nosuperuser
  password :mig_pw;
grant statesman_owner to statesman_migrator;

-- statesman_app must never own a table: table ownership bypasses RLS (V4).
-- It must never reach a privileged role, even by membership (V3).

\connect :db
alter schema public owner to statesman_owner;
grant create on database :db to statesman_owner;
revoke create    on schema   public from public;
revoke temporary on database :db    from public;   -- temp tables shadow unqualified refs (V22)
alter role statesman_app set search_path = 'public';
