-- 0006 Sentinels.
--
-- WHY THIS EXISTS (V18): an empty table with RLS and an empty table with NO RLS both
-- return 0 rows to statesman_app. Without a row that *would* be returned if the policy
-- were missing, every tenancy assertion in the suite is vacuous — it cannot be made to
-- fail, so it has not been shown to work. One reserved-owner row per protected table
-- turns "0 rows" from an ambiguous reading into evidence.
--
-- Seeded as statesman_owner with FORCE bracketed off and back on (V8/V9): under FORCE
-- the owner is subject to the tenancy policy too, and `with check (user_id =
-- app.require_user_id())` raises 28000 during a migration, where no user context exists.
\set ON_ERROR_STOP on
set role statesman_owner;

-- ---------------------------------------------------------------------------
-- Bracket OFF. Everything between here and the re-FORCE below runs with the owner's
-- ordinary ownership bypass (V4) rather than through the policy.
-- ---------------------------------------------------------------------------
alter table public.decision          no force row level security;
alter table public.decision_revision no force row level security;

-- The sentinel user. password_hash is deliberately NOT a valid argon2 encoding, so no
-- credential can ever verify against it and the sentinel cannot be signed in as.
insert into public.app_user (id, email, password_hash, algo_ver, created_at, updated_at)
values ('00000000-0000-0000-0000-00000000dead',
        'sentinel@statesman.invalid',          -- .invalid is reserved (RFC 2606)
        '!not-a-hash:sentinel-account-cannot-authenticate',
        1,
        '2026-01-01T00:00:00Z'::timestamptz,
        '2026-01-01T00:00:00Z'::timestamptz)
on conflict (id) do nothing;

-- Exactly one sentinel row per RLS-protected table: public.decision and
-- public.decision_revision. Fixed ids and fixed timestamps, so a diff of the template is
-- byte-stable and a test can assert on the sentinel without reading it first.
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

-- Count while the bracket is still off: once FORCE is back on, the owner cannot read
-- these rows at all (V8), so the check has to happen here.
do $$
declare n_user integer; n_dec integer; n_rev integer;
begin
  select count(*) into n_user from public.app_user
    where id = '00000000-0000-0000-0000-00000000dead';
  select count(*) into n_dec  from public.decision
    where user_id = '00000000-0000-0000-0000-00000000dead';
  select count(*) into n_rev  from public.decision_revision
    where user_id = '00000000-0000-0000-0000-00000000dead';
  if (n_user, n_dec, n_rev) <> (1, 1, 1) then
    raise exception 'sentinel seed is not exactly one per table: app_user=%, decision=%, decision_revision=%',
      n_user, n_dec, n_rev using errcode = 'ST099';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Bracket ON again.
-- ---------------------------------------------------------------------------
alter table public.decision          force row level security;
alter table public.decision_revision force row level security;

-- The seed's own positive control. Leaving FORCE off here would not fail any migration
-- and would not fail the posture check's reachability rule either in an obvious place —
-- it would simply make the owner's bypass permanent and every tenancy test downstream
-- meaningless. Assert the catalog, which is readable regardless of RLS.
do $$
declare n integer;
begin
  select count(*) into n
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public'
     and c.relname in ('decision','decision_revision')
     and c.relrowsecurity and c.relforcerowsecurity;
  if n <> 2 then
    raise exception 'sentinel seed left RLS unforced on % of 2 protected tables', 2 - n
      using errcode = 'ST099';
  end if;
end $$;

-- No new tables and no new functions, so app.verify_security_posture() is unaffected:
-- rules 1-3 and 5-8 enumerate relations and policies, which this migration does not
-- touch, and rule 4 enumerates functions, which this migration does not create. The
-- REVOKEs are repeated anyway, per §4.2: V30 proved there is no structural default, and
-- the rule is "at the end of every migration", not "every migration that adds one".
revoke execute on all functions in schema app    from public;
revoke execute on all functions in schema public from public;
