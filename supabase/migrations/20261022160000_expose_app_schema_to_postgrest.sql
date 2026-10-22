-- 20261022160000 — make schema `app` reachable through PostgREST, and assert the four
-- properties that make doing so safe.
--
-- ===========================================================================
-- THE DEFECT THIS FIXES, MEASURED BEFORE IT WAS FIXED
-- ===========================================================================
-- src/lib/supabase/client.ts carried this, written during the port and marked UNVERIFIED
-- because that work was forbidden from contacting the project:
--
--   "`app` must be added to the project's exposed schemas … The symptom is PGRST106
--    (schema not exposed) or PGRST202 (function not found in the schema cache)."
--
-- It was not added. MEASURED against onpkspfxfmjkqpomcsse, anon key, POST
-- /rest/v1/rpc/stamp_milestone with `Content-Profile: app`:
--
--   HTTP 406  {"code":"PGRST106","message":"Invalid schema: app",
--              "hint":"Only the following schemas are exposed: public, graphql_public"}
--
-- With a CONTROL, because one failing request proves nothing about which thing failed:
-- the same call WITHOUT `Content-Profile` returned a DIFFERENT code, PGRST202 ("Searched
-- for the function public.stamp_milestone … no matches were found in the schema cache").
-- Two distinct codes for two distinct faults is what makes the first one believable as
-- "the schema is not exposed" rather than as a generic failure.
--
-- Consequence: `app.submit_decision`, `app.append_revision` and `app.stamp_milestone` —
-- the ENTIRE lifecycle write path, the only legal way `submitted_at` can ever be set
-- (canon §4.6b) — were unreachable from the browser. Every screen that submits a decision
-- would have failed at its first call. Nothing in the repository would have caught it:
-- the integration suite connects to Postgres directly and never crosses PostgREST.
--
-- ===========================================================================
-- WHY THE FIX IS HERE AND NOT IN THE DASHBOARD
-- ===========================================================================
-- The exposed-schema list is Supabase project configuration, normally set in the
-- dashboard (API settings → Exposed schemas). PostgREST also reads its configuration
-- from the database when `db-config` is enabled, where in-database settings take
-- precedence over the config file. MEASURED that this project has it enabled:
--
--   alter role authenticator set pgrst.db_schemas = 'public, graphql_public, app';
--   notify pgrst, 'reload config';
--
-- flipped the response from PGRST106 to PGRST202 — PostgREST now searched INSIDE `app`
-- instead of rejecting the schema name. So the setting is expressible as SQL, which means
-- it is expressible as a migration, which matters for one reason:
--
--   A dashboard toggle is unversioned state. No migration contains it, the local
--   emulation does not reproduce it, no test can assert it, and a project rebuilt from
--   this repository would come up with the write path dead and every gate green. This
--   project's entire doctrine is that a control nothing can observe has already failed.
--
-- ALTERNATIVES CONSIDERED, both rejected — recorded in full in ADR-0016:
--
--   (a) Move the three entry points into `public`, which PostgREST already exposes.
--       Rejected: 20261021140100 and 20261021140500 both end with
--       `revoke execute on all functions in schema public from public, anon,
--       authenticated, service_role`, and that line is repeated in EVERY migration by the
--       V2/V30 habit. "No function in `public` is callable by any client role" is a
--       deliberate invariant, and the next migration written after this one would silently
--       revoke the API's own grants. A grant destroyed by the project's own mandated habit
--       is a grant that will vanish without a diff.
--
--   (b) Thin SECURITY INVOKER wrappers in `public` delegating to `app`. Rejected for the
--       same revoke problem, and because the caller needs EXECUTE on the inner definer
--       function regardless, so the wrapper adds a hop and no privilege boundary.
--
-- ===========================================================================
-- WHY EXPOSING A SCHEMA IS SAFE HERE — MEASURED, NOT ARGUED
-- ===========================================================================
-- Exposing a schema to PostgREST exposes its RELATIONS as REST collections and its
-- FUNCTIONS as RPC endpoints. Measured on the live project at the time of writing:
--
--   relations (tables/views/matviews) in schema app .......... 0
--   functions in app executable by anon ..................... 0
--   has_schema_privilege('anon','app','USAGE') .............. false
--   has_schema_privilege('service_role','app','USAGE') ...... false
--   has_schema_privilege('authenticated','app','USAGE') ..... true
--
-- And the refusal was observed end to end. After `notify pgrst, 'reload schema'` the anon
-- request stopped returning PostgREST's PGRST202 and started returning PostgreSQL's
--
--   HTTP 401  {"code":"42501","message":"permission denied for schema app"}
--
-- i.e. the function is in the cache, PostgREST attempted the call, and the database
-- refused it at the schema boundary — before any policy, before any function body. That
-- is grant-absence, which canon §5.2 calls strictly stronger than RLS. `service_role` got
-- the same 42501 at HTTP 403, so even the bypassrls key cannot reach these RPCs over REST.
--
-- MEASURED, and it is why alternative (a) was never going to be cheap: `pg_default_acl`
-- on this project grants EXECUTE on every NEW FUNCTION in `public` to anon, authenticated
-- AND service_role (`public|f|… anon=X authenticated=X service_role=X`). Putting the entry
-- points there would have meant fighting a platform default on every migration, which is
-- what the blanket revoke in alternative (a) exists to do. Schema `app` has NO
-- pg_default_acl entry of any kind, so nothing in it is auto-granted to anyone: the six
-- grants `authenticated` holds are all deliberate, and rule E4 below guards against a
-- future deliberate grant rather than against a default that would create one by itself.
--
-- MEASURED AND WORTH KNOWING: `reload config` alone was NOT sufficient. It re-read
-- db_schemas but left the schema cache without `app`'s contents, so every call returned
-- PGRST202 — which is indistinguishable from "the function does not exist". Both NOTIFYs
-- are required and both are issued below.
--
-- ===========================================================================
-- THE RESIDUAL RISK, STATED PLAINLY
-- ===========================================================================
-- Rule E1 below reads `pg_roles.rolconfig`. That proves the INTENDED setting is recorded
-- in this database. It does NOT prove PostgREST is honouring it: if the platform's own
-- configuration were later to take precedence, rolconfig would still say `app` and rule E1
-- would still pass while the API answered 406. No statement executed inside Postgres can
-- close that gap, so it is not closed here — it is handed to an instrument that can see
-- it: scripts/verify-rest-exposure.sh issues the real HTTP request, and carries a positive
-- control (a schema that is genuinely not exposed must still produce PGRST106) so that a
-- probe which has stopped being able to detect the failure fails loudly instead of
-- reporting success. Rule E1 is a record-keeping check and says so in its own message.
--
-- Second residual: if the dashboard's "Exposed schemas" field is edited later, it and this
-- rolconfig value are two places describing one thing. The DO block below therefore reads
-- the existing value and APPENDS, rather than overwriting a list it did not author.
-- ===========================================================================

set role postgres;

-- ---------------------------------------------------------------------------
-- 1a. The list arithmetic, as two PURE functions.
-- ---------------------------------------------------------------------------
-- These exist as functions rather than as expressions inside the DO block because of a
-- privilege asymmetry measured below: the ALTER ROLE statement in 1b CANNOT run on the
-- local emulation, so any logic embedded in it would be exercised on the live project
-- only — i.e. never, in any test. Pulled out here, the parsing and the append are callable
-- and therefore have positive controls (tests/integration/rest-exposure.test.ts). What
-- remains environment-bound is one ALTER ROLE statement and nothing else.
--
-- IMMUTABLE and granted to nobody: pure text arithmetic over an argument the caller
-- supplies, reading no catalog and no setting.
create or replace function app.pgrst_schema_exposed(p_recorded text, p_schema text)
  returns boolean language sql immutable set search_path = pg_catalog as $$
  -- Trimmed EXACT match on comma-separated members, never a substring test: 'application'
  -- must not satisfy a query for 'app', and 'public_archive' must not satisfy 'public'.
  -- A NULL recorded list means no pgrst.db_schemas entry at all, which is not exposure.
  select coalesce(
    (select true
       from unnest(string_to_array(coalesce(p_recorded, ''), ',')) s
      where btrim(s) = btrim(p_schema)
      limit 1),
    false);
$$;

create or replace function app.pgrst_schema_list_with(p_current text, p_schema text)
  returns text language sql immutable set search_path = pg_catalog, app as $$
  -- Append, never overwrite. The dashboard's "Exposed schemas" field writes to the same
  -- place, so a list this migration did not author must survive it.
  select case
           when app.pgrst_schema_exposed(p_current, p_schema) then p_current
           else coalesce(nullif(btrim(coalesce(p_current, '')), ''), 'public, graphql_public')
                || ', ' || btrim(p_schema)
         end;
$$;

comment on function app.pgrst_schema_exposed(text, text) is
  'True when a PostgREST db_schemas list names the given schema as a trimmed exact member. Pure; the decision procedure behind posture rule E1.';
comment on function app.pgrst_schema_list_with(text, text) is
  'The db_schemas list extended with the given schema, appending rather than overwriting, with the MEASURED platform default public, graphql_public as the base when nothing is recorded. Pure.';

-- ---------------------------------------------------------------------------
-- 1b. The exposure itself.
-- ---------------------------------------------------------------------------
-- MEASURED PRIVILEGE ASYMMETRY, and it is the reason for the exception handler.
--
-- `pgrst.db_schemas` is a custom GUC with no extension defining it, i.e. a placeholder,
-- and PostgreSQL 17 normally restricts `ALTER ROLE … SET` on a placeholder to a superuser.
-- The live project's `postgres` is NOT a superuser (rolsuper=f, measured) and the
-- statement nonetheless SUCCEEDED there; `pg_auth_members` shows it holding
-- `supabase_privileged_role`, and `supautils` is in authenticator's
-- session_preload_libraries, which is the apparent mechanism. The emulated `postgres` has
-- neither, and the same statement fails there with
--
--   ERROR: permission denied to set parameter "pgrst.db_schemas"
--
-- This is a genuine limit of scripts/emulate-supabase.sh, in the same category as the four
-- platform BYPASSRLS roles of 20261022150000, and it is handled the same way: stated, not
-- smoothed over. The alternative — granting the local `postgres` SUPERUSER so the
-- statement succeeds — is exactly the V1/V34 mistake this project has made twice, where a
-- privileged test role made every isolation check pass vacuously. It is not taken.
--
-- So the emulation sets the value itself, as the cluster superuser, to the value this
-- migration intends (scripts/emulate-supabase.sh, "PostgREST exposed schemas"). On a local
-- run `app` is therefore already present, this block takes the no-op branch, and nothing
-- is attempted. On the live project the block does the work. The handler below exists for
-- the remaining case — a local database whose emulation predates that change — and it
-- re-raises anywhere `auth.is_emulation()` is absent, so a privilege failure on a REAL
-- project is never swallowed.
do $$
declare
  current_list text;
  target_list  text;
begin
  select substring(cfg from '^pgrst[.]db_schemas=(.*)$')
    into current_list
    from pg_roles r, unnest(coalesce(r.rolconfig, '{}'::text[])) cfg
   where r.rolname = 'authenticator'
     and cfg like 'pgrst.db_schemas=%'
   limit 1;

  target_list := app.pgrst_schema_list_with(current_list, 'app');

  if app.pgrst_schema_exposed(current_list, 'app') then
    raise notice 'pgrst.db_schemas already names app: %', current_list;
    return;
  end if;

  begin
    execute format('alter role authenticator set pgrst.db_schemas = %L', target_list);
    raise notice 'pgrst.db_schemas: % -> %', coalesce(current_list, '<unset>'), target_list;
  exception when insufficient_privilege then
    if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'auth' and p.proname = 'is_emulation') then
      -- Local only. Rule E1 will still fail if the emulation has not set the value, which
      -- is the correct outcome: the exposure is genuinely absent.
      raise notice
        'EMULATION: cannot set pgrst.db_schemas as a non-superuser; expected locally. %',
        'scripts/emulate-supabase.sh sets it. Rule E1 reports if it did not.';
    else
      -- A real project. Swallowing this would leave the write path dead and the gate green.
      raise;
    end if;
  end;
end $$;

-- Both channels. `reload config` makes PostgREST re-read db_schemas; `reload schema`
-- rebuilds the cache so the newly admitted schema's functions are actually resolvable.
-- Issuing only the first was measured to leave every call answering PGRST202.
notify pgrst, 'reload config';
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- 2. Registry: the exact set of `app` functions a client role may execute.
-- ---------------------------------------------------------------------------
-- WHY A REGISTRY AND NOT A COUNT. Before this migration, `authenticated` could execute
-- SIX functions in `app`, not the three entry points — `current_user_id()`,
-- `require_user_id()` and `derive_decision_state(...)` are granted to it explicitly by
-- 20261021140100 lines 147-149. Those three are deliberate and harmless: two return the
-- caller's own identity and the third is IMMUTABLE and touches no table. But nothing
-- asserted the set, so "six" was discovered by querying the live catalog rather than
-- stated anywhere. Once the schema is exposed, every one of those grants is an
-- internet-reachable endpoint, and a seventh added carelessly by a future migration would
-- become one silently. The signature is stored, not just the name, so an added overload is
-- a new row and not a match.
create table if not exists public.posture_rest_allow (
  signature text primary key,
  reason    text not null
);

insert into public.posture_rest_allow (signature, reason) values
  ('app.submit_decision(p_decision_id uuid, p_token uuid, p_content jsonb, p_confidence smallint, p_forecast text, p_horizon text, p_rationale text)',
   'ENTRY POINT. The lifecycle write path (canon 4.6b): the only legal writer of submitted_at. Must be callable by the browser or the product has no submit button.'),
  ('app.append_revision(p_decision_id uuid, p_token uuid, p_content jsonb, p_confidence smallint, p_forecast text, p_horizon text, p_rationale text)',
   'ENTRY POINT. FR-04 / FR-12 append-only correction. Carries the owner predicate added after the cross-tenant replay leak; see tests/integration/lifecycle.test.ts.'),
  ('app.stamp_milestone(p_decision_id uuid, p_milestone text)',
   'ENTRY POINT. Advances challenged_at / reflected_at / action_recorded_at / closed_at through the transition whitelist.'),
  ('app.require_user_id()',
   'Returns auth.uid() or raises. A caller learns only its own identity, which it supplied. STABLE, never IMMUTABLE (canon 4.3): the IMMUTABLE variant was proven to leak one user rows to another from a prepared statement second execution onward.'),
  ('app.current_user_id()',
   'Returns auth.uid() or NULL. Same reasoning as require_user_id(): self-referential, discloses nothing the caller did not already hold.'),
  ('app.derive_decision_state(p_submitted timestamp with time zone, p_challenged timestamp with time zone, p_reflected timestamp with time zone, p_action timestamp with time zone, p_closed timestamp with time zone)',
   'IMMUTABLE pure computation over five timestamps the caller passes in. Reads no table and holds no state, so exposure discloses the state machine rules and nothing else. Those rules are in this public repository already.')
on conflict (signature) do update set reason = excluded.reason;

-- Mirrors the three existing registries: no user data, reachable by nobody, and therefore
-- exempt from the sentinel and tenancy rules that apply to user-owned tables.
insert into public.posture_exempt_table (table_name, reason) values
  ('posture_rest_allow',
   'the REST exposure allowlist registry: no user data, no grants to anon or authenticated')
on conflict (table_name) do nothing;

-- ---------------------------------------------------------------------------
-- 3. app.verify_rest_exposure() — four rules, its own SQLSTATE.
-- ---------------------------------------------------------------------------
-- A SEPARATE function from app.verify_security_posture(), for two reasons that are not
-- about convenience. First, remediation differs: ST097 means "the REST surface is wrong",
-- which is fixed by a setting or a grant, where ST099 means "the schema is wrong", which
-- is fixed by SQL. Collapsing them would make the error message name the wrong fix.
-- Second, adding these rules to the existing 280-line function would mean reproducing all
-- twelve of its rules in this file, and a diff in which everything changed is a diff
-- nobody can review.
--
-- SECURITY INVOKER and granted to NOBODY, exactly as verify_security_posture() is: it
-- reads a registry that `authenticated` deliberately cannot see, and making the thing that
-- looks for holes reachable by a client role would be one.
create or replace function app.verify_rest_exposure() returns void
  language plpgsql set search_path = pg_catalog, app, public as $$
declare
  r   record;
  bad text := '';
  recorded text;
begin
  -- E1 THE EXPOSURE IS RECORDED. Read-keeping only, and the message says so: this proves
  --    the intended value is in rolconfig, NOT that PostgREST is honouring it. The HTTP
  --    probe in scripts/verify-rest-exposure.sh is the only instrument that can prove the
  --    latter, and it has its own positive control.
  select substring(cfg from '^pgrst[.]db_schemas=(.*)$')
    into recorded
    from pg_roles ro, unnest(coalesce(ro.rolconfig, '{}'::text[])) cfg
   where ro.rolname = 'authenticator' and cfg like 'pgrst.db_schemas=%'
   limit 1;

  -- Calls app.pgrst_schema_exposed() rather than restating its test. A second copy of
  -- "does this list name app" would be a second definition of the rule, free to drift from
  -- the one the migration itself used in 1b — the same argument canon 4.4 makes for the
  -- state machine having ONE derivation function serving both the column and the trigger.
  -- It is also what gives E1 a positive control: the predicate is pure and callable, so
  -- its substring traps are tested directly.
  if not app.pgrst_schema_exposed(recorded, 'app') then
    bad := bad || format(
      E'\n  rule E1: authenticator has no pgrst.db_schemas naming schema app (recorded: %s).'
      '\n           The lifecycle RPCs are then unreachable over REST and every submit'
      '\n           fails with PGRST106. NOTE: this rule reads rolconfig and therefore'
      '\n           proves only what is RECORDED; scripts/verify-rest-exposure.sh issues'
      '\n           the real request.',
      coalesce(recorded, '<unset>'));
  end if;

  -- E2 NEITHER anon NOR service_role MAY HOLD USAGE ON app. This is the measured reason
  --    exposing the schema is safe: an anonymous request is refused at the schema
  --    boundary with 42501 before any policy or function body runs. A
  --    `grant usage on schema app to anon` would move the refusal from grant-absence to
  --    whatever each function happens to check.
  for r in
    select ro.rolname
      from unnest(array['anon','service_role']) ro(rolname)
     where has_schema_privilege(ro.rolname, 'app', 'USAGE')
  loop
    bad := bad || format(
      E'\n  rule E2: %s holds USAGE on schema app. Schema app is exposed to PostgREST, so'
      '\n           this makes every function granted to that role anonymously callable'
      '\n           over HTTP.', r.rolname);
  end loop;

  -- E3 THE EXECUTABLE SET EQUALS THE REGISTRY, both directions. A function granted but not
  --    registered is an unreviewed public endpoint. A function registered but not granted
  --    is a stale row, and a registry allowed to carry stale rows becomes a place to put
  --    whatever is currently failing — the same reasoning registry 2 states for its own
  --    rows.
  for r in
    select n.nspname || '.' || p.proname || '(' ||
           pg_get_function_identity_arguments(p.oid) || ')' as sig,
           g.rolname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join unnest(array['anon','authenticated','service_role']) g(rolname)
     where n.nspname = 'app'
       and has_function_privilege(g.rolname, p.oid, 'EXECUTE')
       and not exists (select 1 from public.posture_rest_allow a where a.signature =
             n.nspname || '.' || p.proname || '(' ||
             pg_get_function_identity_arguments(p.oid) || ')')
     order by 1, 2
  loop
    bad := bad || format(
      E'\n  rule E3: %s may EXECUTE %s, which is not in public.posture_rest_allow.'
      '\n           Schema app is exposed, so this is a live HTTP endpoint nobody'
      '\n           reviewed. Register it with a reason, or revoke it.', r.rolname, r.sig);
  end loop;

  for r in
    select a.signature
      from public.posture_rest_allow a
     where not exists (
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app'
          and n.nspname || '.' || p.proname || '(' ||
              pg_get_function_identity_arguments(p.oid) || ')' = a.signature
          and (has_function_privilege('anon', p.oid, 'EXECUTE')
            or has_function_privilege('authenticated', p.oid, 'EXECUTE')
            or has_function_privilege('service_role', p.oid, 'EXECUTE')))
     order by 1
  loop
    bad := bad || format(
      E'\n  rule E3b: public.posture_rest_allow registers %s, which no client role can'
      '\n            execute. Either the grant was lost — in which case the application is'
      '\n            broken — or the row is stale. Both need a decision, not a default.',
      r.signature);
  end loop;

  -- E4 NO RELATION IN app IS REACHABLE BY A CLIENT ROLE. Exposing a schema exposes its
  --    tables and views as REST collections, and app.verify_security_posture() rule 1 scans
  --    `public` ONLY — so a table added to `app` would be served with no RLS requirement
  --    and no rule would object. Today there are zero relations in app; this rule is what
  --    makes that a guarantee rather than a coincidence. It permits an owner-only internal
  --    table, which PostgREST hides from a role that cannot read it.
  for r in
    select c.relname, g.rolname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join unnest(array['anon','authenticated','service_role']) g(rolname)
     where n.nspname = 'app' and c.relkind in ('r','p','v','m','f')
       and (has_table_privilege(g.rolname, c.oid, 'SELECT')
         or has_table_privilege(g.rolname, c.oid, 'INSERT')
         or has_table_privilege(g.rolname, c.oid, 'UPDATE')
         or has_table_privilege(g.rolname, c.oid, 'DELETE'))
     order by 1, 2
  loop
    bad := bad || format(
      E'\n  rule E4: %s can reach relation app.%s. Schema app is exposed to PostgREST, so'
      '\n           this is a REST collection; posture rule 1 scans public only and will'
      '\n           not require RLS on it.', r.rolname, r.relname);
  end loop;

  if bad <> '' then
    raise exception 'REST EXPOSURE POSTURE FAILED:%', bad using errcode = 'ST097';
  end if;
end $$;

comment on function app.verify_rest_exposure() is
  'Asserts the four properties that make exposing schema app to PostgREST safe: the exposure is recorded, anon and service_role hold no USAGE on app, the set of app functions executable by a client role equals public.posture_rest_allow exactly in both directions, and no relation in app is client-reachable. Raises ST097. Granted to nobody.';

revoke all on table public.posture_rest_allow from anon, authenticated, service_role;

-- V2/V30: every migration ends with the explicit revokes. ALTER DEFAULT PRIVILEGES …
-- REVOKE EXECUTE … FROM PUBLIC is a silent no-op, so this is the only form that works, and
-- it is repeated per migration rather than assumed from the last one.
revoke execute on all functions in schema app    from public, anon;
revoke execute on all functions in schema public from public, anon, authenticated, service_role;

-- Re-assert the entry points. NOT a recovery from the revoke above: `REVOKE … FROM PUBLIC`
-- removes only PUBLIC's grant entry, and 20261021140400 granted these to `authenticated`
-- explicitly, so they survive it. They are restated because rule E3b now fails if any
-- registered signature is unreachable, and a file that declares its own surface is a file
-- whose surface can be read without opening three others. Idempotent.
grant execute on function app.submit_decision(uuid,uuid,jsonb,smallint,text,text,text) to authenticated;
grant execute on function app.append_revision(uuid,uuid,jsonb,smallint,text,text,text) to authenticated;
grant execute on function app.stamp_milestone(uuid,text) to authenticated;
grant execute on function app.current_user_id() to authenticated;
grant execute on function app.require_user_id() to authenticated;
grant execute on function app.derive_decision_state(timestamptz,timestamptz,timestamptz,timestamptz,timestamptz) to authenticated;
