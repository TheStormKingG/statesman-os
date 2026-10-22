-- 20261021140600 Sentinels. Ported from migrations/0006_sentinels.sql.
--
-- ===========================================================================
-- WHY THIS EXISTS, AND WHY THE PORT PROMOTES IT FROM THOROUGH TO INDISPENSABLE
-- ===========================================================================
-- V18: an empty table with RLS and an empty table with NO RLS both return 0 rows to the
-- app role. Before the port there was still a second signal — `app.require_user_id()`
-- RAISED 28000 when identity was missing, so an uncontexted read announced itself.
--
-- `auth.uid()` returns NULL. Measured on a Supabase-shaped target with a paired control:
-- as `authenticated` with no claim, 0 rows and NO error. So on an EMPTY protected table
-- there are now three indistinguishable situations — a correct policy, a broken policy,
-- and no policy at all — all returning zero rows and raising nothing. Every tenancy
-- assertion in the suite would be unfailable, which means unproven.
--
-- One reserved-owner row per protected table turns "0 rows" from an ambiguous reading
-- back into evidence: the row WOULD come back if the policy were missing. Posture rule 9
-- is what notices when one is gone, and the port extended it (rule 9b) so that no
-- protected table can escape the requirement.
--
-- ===========================================================================
-- THE IDENTITY SENTINEL NOW NEEDS AN auth.users ROW
-- ===========================================================================
-- `public.profile.user_id` carries a real foreign key to `auth.users (id)`
-- (20261021140200), so the reserved owner has to exist there first. That is a deliberate
-- consequence of making the foreign key real rather than documentary: the live system
-- cannot have a profile without an auth user either, and a fixture that forgets fails
-- immediately instead of at the next posture run.
--
-- The insert is deliberately NARROW — `id`, `email`, `created_at`, `updated_at` and
-- nothing else:
--   * No password column is written at all. On the live project `encrypted_password` is
--     nullable and NULL can never verify against any credential, which is strictly
--     stronger than migrations/0006's trick of storing a deliberately malformed argon2
--     encoding. The sentinel cannot be signed in as.
--   * The email is at `.invalid`, which RFC 2606 reserves, so no magic link or recovery
--     mail can ever be delivered to it.
--   * Four columns, matching exactly what scripts/emulate-supabase.sh gives its minimal
--     `auth.users`, so the local insert exercises the same column list as the live one.
--
-- UNVERIFIED, and it must be declared rather than assumed: this insert has NOT been run
-- against project onpkspfxfmjkqpomcsse. The real `auth.users` is GoTrue's and carries
-- many more columns. All of them are nullable or defaulted as far as the published schema
-- goes, so the insert is expected to succeed — but "expected" is not "measured". If GoTrue
-- requires a column we do not supply, this migration ABORTS at the point of the insert,
-- which is the correct failure mode: loud, at migration time, before any real decision is
-- entered. See docs/supabase-port-notes.md finding P5.
--
-- ===========================================================================
-- THE NO FORCE / FORCE BRACKET IS KEPT, AND IT IS NOW BELT-AND-BRACES
-- ===========================================================================
-- V8: a write as the table owner under FORCE RLS is a silent no-op, so a backfill must
-- bracket NO FORCE / FORCE. On Supabase this migration runs as `postgres`, which is
-- BYPASSRLS — row security is not applied to it at all, FORCE or no FORCE, so the
-- inserts below would succeed without the bracket.
--
-- The bracket stays anyway, for one reason: it makes this file correct whichever role
-- applies it. `supabase db push` connects as `postgres` today; a migration replayed by
-- some other path, or by a role that is merely the owner, would otherwise insert zero
-- rows, raise nothing, and leave the sentinels missing — which the posture check would
-- then report as a failure whose cause is three files away. Depending on the migrator's
-- `rolbypassrls` for correctness is exactly the dependency ADR-0015 calls the single most
-- dangerous fact of the port.

set role postgres;

-- ---------------------------------------------------------------------------
-- The reserved identity, in Supabase Auth's table.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000dead',
        'sentinel@statesman.invalid',          -- .invalid is reserved (RFC 2606)
        '2026-01-01T00:00:00Z'::timestamptz,
        '2026-01-01T00:00:00Z'::timestamptz)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Bracket OFF. Everything between here and the re-FORCE below runs without the tenancy
-- policy being consulted.
-- ---------------------------------------------------------------------------
alter table public.profile           no force row level security;
alter table public.decision          no force row level security;
alter table public.decision_revision no force row level security;

insert into public.profile (user_id, display_name, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000dead',
        'reserved sentinel — not a user',
        '2026-01-01T00:00:00Z'::timestamptz,
        '2026-01-01T00:00:00Z'::timestamptz)
on conflict (user_id) do nothing;

-- Exactly one sentinel row per RLS-protected table. Fixed ids and fixed timestamps, so a
-- diff of the template is byte-stable and a test can assert on the sentinel without
-- reading it first.
insert into public.decision
  (id, user_id, draft_payload, draft_updated_at, submitted_at, created_at)
values ('00000000-0000-0000-0000-00000000dec1',
        '00000000-0000-0000-0000-00000000dead',
        '{"sentinel": true}'::jsonb,
        '2026-01-01T00:00:00Z'::timestamptz,
        '2026-01-01T00:00:00Z'::timestamptz,   -- state derives to 'submitted'
        '2026-01-01T00:00:00Z'::timestamptz)
on conflict (id) do nothing;

insert into public.decision_revision
  (id, decision_id, user_id, revision_no, content, confidence,
   forecast, horizon, rationale, idempotency_token, created_at)
values ('00000000-0000-0000-0000-00000000dec2',
        '00000000-0000-0000-0000-00000000dec1',
        '00000000-0000-0000-0000-00000000dead',
        1,
        '{"sentinel": true}'::jsonb,
        50,
        'sentinel forecast — fictional, not a prediction',
        'sentinel horizon',
        'sentinel rationale',
        '00000000-0000-0000-0000-00000000dec3',
        '2026-01-01T00:00:00Z'::timestamptz)
on conflict (id) do nothing;

-- Count while the bracket is still off. The original counted here because once FORCE was
-- back on, the owner could not read these rows at all (V8). As `postgres` that is no
-- longer true, but the ordering is kept so the file does not silently depend on the
-- migrator being bypassrls.
do $$
declare n_auth integer; n_prof integer; n_dec integer; n_rev integer;
begin
  select count(*) into n_auth from auth.users
    where id = '00000000-0000-0000-0000-00000000dead';
  select count(*) into n_prof from public.profile
    where user_id = '00000000-0000-0000-0000-00000000dead';
  select count(*) into n_dec  from public.decision
    where user_id = '00000000-0000-0000-0000-00000000dead';
  select count(*) into n_rev  from public.decision_revision
    where user_id = '00000000-0000-0000-0000-00000000dead';
  if (n_auth, n_prof, n_dec, n_rev) <> (1, 1, 1, 1) then
    raise exception 'sentinel seed is not exactly one per table: auth.users=%, profile=%, decision=%, decision_revision=%',
      n_auth, n_prof, n_dec, n_rev using errcode = 'ST099';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Bracket ON again.
-- ---------------------------------------------------------------------------
alter table public.profile           force row level security;
alter table public.decision          force row level security;
alter table public.decision_revision force row level security;

-- The seed's own positive control. Leaving FORCE off here would fail no migration and
-- would not obviously fail posture rule 1 either — it would simply make the owner's
-- bypass permanent and every tenancy test downstream meaningless. Assert the catalog,
-- which is readable regardless of RLS.
do $$
declare n integer;
begin
  select count(*) into n
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public'
     and c.relname in ('profile','decision','decision_revision')
     and c.relrowsecurity and c.relforcerowsecurity;
  if n <> 3 then
    raise exception 'sentinel seed left RLS unforced on % of 3 protected tables', 3 - n
      using errcode = 'ST099';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- THE PAIRED CONTROL ON THE SENTINEL'S WHOLE POINT, run as `authenticated`.
-- ---------------------------------------------------------------------------
-- Everything above proves the rows exist. It does not prove they are INVISIBLE to another
-- identity, which is the property that makes a zero-row denial result mean something —
-- and it cannot be proven as `postgres`, because `postgres` is BYPASSRLS and would see
-- all three rows while enforcing nothing. ADR-0015: "Any test or probe connecting as it
-- passes while enforcing NOTHING."
--
-- So this block SET ROLEs to `authenticated` and measures, in the silent-denial semantics
-- the port actually has:
--   * with a foreign identity's claim -> 0 rows, AND NO ERROR (not 28000; that is the
--     whole change)
--   * with the sentinel's own claim    -> 1 row  (the positive control, without which the
--     zero above could mean "table empty" or "grant missing")
--   * inserting a row owned by the sentinel while holding a foreign claim -> refused with
--     42501 (new row violates row-level security policy)
--
-- `set role` / `reset role` are issued through EXECUTE because plpgsql will not accept
-- SET ROLE as a plain statement. The reset is written out rather than relying on the
-- statement's implicit transaction ending, because the Supabase CLI wraps each migration
-- file in a transaction and the role would otherwise persist into the next statement.
do $$
declare
  sentinel  constant uuid := '00000000-0000-0000-0000-00000000dead';
  stranger  constant uuid := 'aaaaaaaa-0000-0000-0000-00000000beef';
  bad       text := '';
  n         bigint;
  sqlst     text;
begin
  execute 'set role authenticated';

  -- Leg 1: a foreign claim sees nothing, and raises nothing.
  perform set_config('request.jwt.claim.sub', stranger::text, true);
  perform set_config('request.jwt.claims', '', true);
  begin
    select count(*) into n from public.decision;
    if n <> 0 then
      bad := bad || format(E'\n  leg 1: a stranger saw %s decision rows, expected 0', n);
    end if;
  exception when others then
    bad := bad || format(
      E'\n  leg 1: a stranger''s read RAISED %s (%s). The live target returns 0 rows with '
       'no error; something here is reproducing the retired 28000 semantics.',
      sqlerrm, sqlstate);
  end;

  -- Leg 2: THE POSITIVE CONTROL. Without this, leg 1 is satisfied by an empty table, a
  -- missing grant, or a policy that denies everyone — which is V18 exactly.
  perform set_config('request.jwt.claim.sub', sentinel::text, true);
  begin
    select count(*) into n from public.decision;
    if n <> 1 then
      bad := bad || format(
        E'\n  leg 2: the sentinel''s own claim saw %s decision rows, expected 1. Leg 1''s '
         'zero therefore proves nothing.', n);
    end if;
  exception when others then
    bad := bad || format(E'\n  leg 2: the sentinel''s own read raised %s (%s)',
                         sqlerrm, sqlstate);
  end;

  -- Leg 3: forgery. A stranger inserting a row owned by the sentinel must be refused by
  -- the policy's WITH CHECK, not merely affect zero rows.
  perform set_config('request.jwt.claim.sub', stranger::text, true);
  sqlst := null;
  begin
    insert into public.decision (user_id, draft_payload) values (sentinel, '{}'::jsonb);
    bad := bad || E'\n  leg 3: a stranger INSERTED a row owned by the sentinel';
  exception when others then
    sqlst := sqlstate;
  end;
  if sqlst is not null and sqlst <> '42501' then
    bad := bad || format(
      E'\n  leg 3: forged insert was refused with %s, expected 42501 (row-level security)',
      sqlst);
  end if;

  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',    '', true);
  execute 'reset role';

  if bad <> '' then
    raise exception 'SENTINEL PAIRED CONTROL FAILED:%', bad using errcode = 'ST099';
  end if;
end $$;

-- `set role` inside the DO block above is reset there, but a failure path could leave it
-- set; restoring it here makes the file's end state unconditional.
set role postgres;

-- No new tables and no new functions, so app.verify_security_posture() is unaffected. The
-- REVOKEs are repeated anyway, per canon §4.2: V30 proved there is no structural default,
-- and the rule is "at the end of every migration", not "every migration that adds one".
revoke execute on all functions in schema app    from public, anon;
revoke execute on all functions in schema public from public, anon, authenticated, service_role;
