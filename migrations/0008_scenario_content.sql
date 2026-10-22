-- 0008 Scenario content: the reference tables of canon §5.
--
-- These five tables are REFERENCE data: readable by every authenticated user, written
-- only by migration/seed as statesman_owner. Canon §11 CUT the `app_editor` role, the
-- `scenario_version_draft` table and the `publish_scenario_version()` function, so there
-- is deliberately NO authoring path here. statesman_app gets SELECT and nothing else.
--
-- ===========================================================================
-- POSTURE DECISION (brief rule 1, canon §4.8) — STATED, not implied
-- ===========================================================================
-- Reference data readable by every authenticated user is NOT the tenancy shape, so the
-- `user_id = app.require_user_id()` policy of 0003 does not apply. The choice taken here
-- is BOTH halves of the brief's menu, because the posture checker's ten rules are not
-- interchangeable and only one combination satisfies all of them without weakening any:
--
--   * A POLICY, not an exemption, is what satisfies rule 1 (REACHABILITY). Rule 1 has no
--     exemption clause: any public table on which statesman_app holds SELECT must be
--     RLS-enabled AND FORCED with >= 1 policy. Requirement 3 grants SELECT, so forced RLS
--     plus a policy is MANDATORY for all five tables. An exemption row cannot buy its way
--     out of rule 1 and was never able to.
--
--   * The policy is `using (app.require_user_id() is not null)` — read permitted to any
--     authenticated identity, scoped by the raising accessor. It is not `using (true)`,
--     so rule 8 (POLICY SHAPE) passes on both of its tests: the qual is not the literal
--     `true`, and it mentions require_user_id(). The property this buys is the one the
--     brief names as worth keeping: an UNAUTHENTICATED read raises 28000 with no context
--     rather than returning rows. Asserted below by a paired control (CTRL-3/CTRL-4), not
--     assumed.
--
--   * An EXEMPTION ROW is additionally required, and ONLY for rule 9 (SENTINELS). Rule 9
--     enumerates every forced-RLS public table that is not exempt and requires exactly
--     one row owned by the reserved sentinel uuid, keyed on a `user_id` column. These
--     tables have no `user_id` column and never will — reference rows have no owner. An
--     unexempted reference table therefore trips rule 9's explicit
--     "protected table has no user_id column, so rule 9 cannot be evaluated" branch, and
--     every migration run in every environment would abort with ST099.
--
--     V18's reason for sentinels still has to be answered, not waived — and the first
--     draft of this migration answered it WRONGLY, which a control caught. See the next
--     block.
--
-- ===========================================================================
-- MEASURED HERE, AND IT CHANGED THE DESIGN: an empty forced-RLS table does not deny
-- ===========================================================================
-- The first draft of this file enabled RLS, forced it, created the read policies, and
-- shipped the five tables EMPTY, on the reasoning that the brief's property — "an
-- unauthenticated read raises 28000 with no context" — followed from the policy. CTRL-3
-- below was written to assert exactly that, and it FAILED, on all five tables at once:
--
--     CTRL-3 scenario returned instead of raising 28000 with no identity context
--     ... the same for scenario_version, source, scenario_claim, rubric_version
--
-- On an EMPTY table the qual is never evaluated: the scan finds no candidate row, so
-- app.require_user_id() is never called, and the read returns zero rows and raises
-- NOTHING. That is V6 ("the policy raises only when a candidate row actually reaches the
-- qual") applying to a case the project had not met before, and it is the measured
-- DEPARTURE from 0005's note that `select count(*) from public.decision` raises 28000 for
-- an uncontexted owner — public.decision is not empty, because 0006 seeds it a sentinel.
-- The raising behaviour was never a property of the policy alone. It was a property of
-- the policy AND a row being there.
--
-- So an empty reference table is indistinguishable, to an unauthenticated caller, from a
-- reference table with no policy at all: both return zero rows in silence. That is V18
-- verbatim, and it is why reference data needs a reserved row just as much as user data
-- does — for a different reason, with a different shape.
--
-- Hence the SENTINEL SEED below: one reserved row in each of the five tables, inserted by
-- this migration, so the qual is reachable and the denial is real from the moment the
-- schema exists rather than from whenever content is first seeded. The exemption from
-- rule 9 is only about rule 9's user_id-keyed MECHANISM; the evidence requirement behind
-- it is met, not waived, by that row plus CTRL-3/CTRL-4.
--
--   * Nothing is weakened. The exemption also makes rule 2 (ENUMERATION) skip these five
--     tables, but rule 2 is subsumed here: rule 1 already demands forced RLS plus a
--     policy because of the SELECT grant, and rule 1 is not exemption-aware. The one
--     check the exemption genuinely waives is rule 9. CTRL-1 below re-asserts the
--     catalog facts (enabled + forced + >= 1 policy on all five) from inside this
--     migration, so a later edit that drops the policy or the FORCE fails here as well as
--     at rule 1.
--
-- ===========================================================================
-- NEW SQLSTATES (brief rule 2 — UPPERCASE, V13)
-- ===========================================================================
--   ST020  published reference content is immutable: UPDATE or DELETE attempted on a
--          scenario_version or rubric_version row whose published_at is set.
--   ST021  a reference content table cannot be TRUNCATEd (V15: TRUNCATE bypasses
--          row-level BEFORE UPDATE/DELETE triggers entirely).
--
-- Both are new and unused elsewhere. In use before this file: ST001, ST002, ST003, ST005,
-- ST010, ST011, ST012, ST099. src/server/db/errors.ts does not yet map ST020/ST021 and
-- is not this migration's file; an unmapped custom code currently falls through to the
-- generic branch of fromDatabaseError(). Mapping them is an owed follow-up, recorded in
-- this slice's report rather than silently assumed.
--
-- ===========================================================================
-- content_hash — ONE property, measured, and what it is NOT
-- ===========================================================================
-- A GENERATED ALWAYS AS ... STORED column, derived by the database:
--
--     encode(sha256(pg_catalog.jsonb_send(content)), 'hex')
--
-- THE ONE PROPERTY BOUGHT: content_hash cannot be supplied, forged or allowed to drift
-- from `content`. There is no writer that can set it — not the app (no grants), not the
-- seed, not the owner — so a row's hash is always the hash of the row's stored content,
-- by construction rather than by agreement. That makes it a stable equality handle: an
-- export, an audit row or a model-prompt provenance record can cite a 64-hex value and a
-- later reader can tell whether it is looking at the same content without fetching and
-- diffing the jsonb.
--
-- WHAT IT IS EXPLICITLY NOT:
--   * NOT a verification of an application-computed canonicalisation. The design record
--     for this slice reports an earlier version in which a trigger recomputed the same
--     expression the only writer used, making the comparison a tautology. (That note is
--     carried in the slice brief, not in the canon's verified-facts register — grep for
--     `content_hash` there returns nothing, so it is cited here as design history rather
--     than as a V-row.) That trigger is not built here, and the reason it cannot be made
--     non-tautological was MEASURED on this cluster during this slice: jsonb normalises
--     key order, so `{"b":1,"a":2}` and `{"a":2,"b":1}` are
--     stored identically and hash identically
--     (fcbbaada9c08608ad78d2f17721c68c314dc169d97bd2b44d1aaa1bb6a07ca60 for both). An
--     outside serialisation is therefore not reproducible, and a trigger comparing an
--     app-supplied hash to the Postgres rendering would reject correct content.
--   * NOT tamper evidence against statesman_owner. An owner who rewrites `content` gets
--     a matching hash for free. The anti-tamper controls are the ST020 publish gate, the
--     ST021 truncate gate and the absent grants — not the hash.
--
-- WHY jsonb_send AND NOT convert_to: MEASURED on this cluster (PostgreSQL 17.11) during
-- this slice. `pg_proc.provolatile` is 's' (STABLE) for both `convert_to` and `textsend`,
-- and the canonical-looking expression
-- `encode(sha256(convert_to(content::text,'UTF8')),'hex')` is REJECTED outright with
-- "generation expression is not immutable". `pg_catalog.jsonb_send` is 'i' (IMMUTABLE)
-- and `sha256`/`encode` are 'i', so the form used above is accepted with no
-- volatility-mismarking: nothing here is declared IMMUTABLE that is not. The alternative
-- of wrapping convert_to in a hand-declared IMMUTABLE SQL function would have lied to
-- the planner about a function the posture checker's rule 6 exists to police, and
-- md5(text) was declined because the weakness is gratuitous when an immutable SHA-256
-- route exists.
--
-- ===========================================================================
-- SEEDING THIS SCHEMA LATER — READ THIS FIRST (V8)
-- ===========================================================================
-- FORCE ROW LEVEL SECURITY subjects statesman_owner to the policy too, and the policies
-- below are `for select` only. A seed migration that INSERTs here without bracketing will
-- NOT silently write zero rows — it will fail, because an INSERT with no applicable
-- policy is refused outright. Either way the rule is 0006's:
--
--     alter table public.scenario_version no force row level security;   -- bracket OFF
--     ...  insert, then COUNT while the bracket is still off ...
--     alter table public.scenario_version force    row level security;   -- bracket ON
--
-- and assert the affected row count, because 0 is never a success signal (V7).
--
-- ===========================================================================
-- DECLARED RESIDUAL — post-publication edits to `source` and `scenario_claim`
-- ===========================================================================
-- Requirement 1 is enforced where published_at exists: scenario_version and
-- rubric_version. `scenario`, `source` and `scenario_claim` have no published_at (canon
-- §5.1 does not give them one) and so carry the TRUNCATE gate and absent grants but no
-- row-level publish gate. The content a decision_revision pins is
-- `scenario_version.content`, and that IS frozen, so FR-04 is met. The residual is that
-- statesman_owner can still edit a `source` or `scenario_claim` row attached to an
-- already-published version.
--
-- It is declared rather than closed because the obvious closure is worse than the hole:
-- a trigger on those two tables would have to read the parent `scenario_version` to learn
-- whether it is published, and under FORCE RLS that read raises 28000 in exactly the
-- uncontexted owner-run migration that is its only caller. The two escapes — assuming
-- the sentinel identity inside the trigger, or special-casing the owner in the policy —
-- each add a standing bypass to buy a guard against the one role that can already remove
-- any guard. Closing mechanism for the seed slice instead: record each published
-- version's `(source, scenario_claim)` digest alongside the migration that publishes it
-- and assert it in CI, which costs nothing at runtime and detects the edit afterwards.
-- `on delete restrict` below already prevents the destructive half.
--
-- ===========================================================================
\set ON_ERROR_STOP on
set role statesman_owner;

-- ---------------------------------------------------------------------------
-- rubric_version. Created first: scenario_version references it.
-- ---------------------------------------------------------------------------
create table public.rubric_version (
  id           uuid primary key default gen_random_uuid(),
  version_no   integer not null,
  content      jsonb   not null,
  published_at timestamptz,
  constraint rubric_version_no_positive check (version_no > 0),
  constraint rubric_version_no_uq       unique (version_no)
);

comment on table public.rubric_version is
  'Reference data. PRD 8.1 "expected evaluation rubric". Immutable once published_at is set (ST020).';

-- ---------------------------------------------------------------------------
-- scenario. The case, independent of any one version of its content.
-- ---------------------------------------------------------------------------
-- `status` is the editorial pipeline of PRD 8.2 (Draft -> Source verification ->
-- Subject-matter/ethics review -> Approved -> Published -> Periodic refresh or archive).
-- It is the editorial RECORD that PRD 8.2 requires be kept. It is NOT the authoritative
-- "is this content live" signal — that is scenario_version.published_at, which is the
-- column the immutability gate reads and the column a decision pins through.
create table public.scenario (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null,
  status       text not null default 'draft',
  sector       text not null,
  jurisdiction text not null,
  created_at   timestamptz not null default now(),
  constraint scenario_slug_uq unique (slug),
  constraint scenario_slug_shape check (slug ~ '^[a-z0-9]([a-z0-9-]{0,78}[a-z0-9])?$'),
  constraint scenario_status_known check (status in (
    'draft', 'source_verification', 'ethics_review', 'approved', 'published', 'archived'))
);

comment on table public.scenario is
  'Reference data. The case identity and PRD 8.2 editorial status. Content lives in scenario_version.';

-- ---------------------------------------------------------------------------
-- scenario_version. The immutable-once-published unit a decision pins to.
-- ---------------------------------------------------------------------------
-- is_fiction and as_of_date are NOT NULL deliberately (brief requirement 2). FR-02
-- requires every factual scenario assertion to be traceable to a source or explicitly
-- flagged as invented scenario data, and PRD 8.2 requires content to be dated and never
-- described as current when freshness cannot be verified. A nullable fiction flag or a
-- nullable date would let an unlabelled, undated case ship and read as neither fictional
-- nor factual at the point of rendering, which is the worse of the two failures: the
-- editorial boundary in canon §1.2 is that Guyana-first context is not licence to present
-- invented statutes or health data as real.
create table public.scenario_version (
  id                uuid    primary key default gen_random_uuid(),
  scenario_id       uuid    not null references public.scenario (id) on delete restrict,
  version_no        integer not null,
  content           jsonb   not null,
  is_fiction        boolean not null,
  as_of_date        date    not null,
  rubric_version_id uuid references public.rubric_version (id) on delete restrict,
  published_at      timestamptz,
  created_at        timestamptz not null default now(),
  -- Derived by the database. No writer can set it; see the header for the one property
  -- this buys and the two it does not.
  content_hash text generated always as
    (encode(sha256(pg_catalog.jsonb_send(content)), 'hex')) stored,
  constraint scenario_version_no_positive check (version_no > 0),
  constraint scenario_version_no_uq       unique (scenario_id, version_no),
  -- PRD 8.1: every APPROVED case must store its expected evaluation rubric. Enforced at
  -- publication rather than at insert, so a draft version may exist before a rubric does.
  constraint scenario_version_published_has_rubric
    check (published_at is null or rubric_version_id is not null)
);
-- canon §5.1 also names `unique (id)`; the primary key on `id` alone provides it, and a
-- second redundant unique index is not created.
create index scenario_version_scenario_idx on public.scenario_version (scenario_id);

comment on table public.scenario_version is
  'Reference data. Immutable once published_at is set (ST020) — canon 4.4, FR-04: a published version must not change underneath a submitted decision.';
comment on column public.scenario_version.is_fiction is
  'FR-02 / canon 1.2 editorial boundary. NOT NULL so an unlabelled case cannot ship.';
comment on column public.scenario_version.as_of_date is
  'PRD 8.2: content is dated and must not be described as current when freshness cannot be verified. NOT NULL.';

-- ---------------------------------------------------------------------------
-- source. unique (id, scenario_version_id) is the composite-FK anchor (canon §4.5
-- applied to reference data): it is what lets scenario_claim prove its source belongs to
-- the SAME version, and what the citation tables of canon §7.3 will reference.
-- ---------------------------------------------------------------------------
create table public.source (
  id                  uuid primary key default gen_random_uuid(),
  scenario_version_id uuid not null references public.scenario_version (id) on delete restrict,
  title               text not null,
  publisher           text not null,
  uri                 text,
  published_date      date,
  retrieved_date      date,
  kind                text not null,
  constraint source_version_scope unique (id, scenario_version_id),
  constraint source_kind_known check (kind in (
    'statute', 'regulation', 'official_publication', 'dataset',
    'news_report', 'academic', 'institutional_statement', 'fictional_assumption')),
  -- FR-02 and PRD 8.1 ("source list and access dates"): anything that is not an openly
  -- declared invented assumption must be reachable and must carry the date it was read.
  constraint source_factual_is_traceable check (
    kind = 'fictional_assumption' or (uri is not null and retrieved_date is not null))
);
create index source_version_idx on public.source (scenario_version_id);

comment on table public.source is
  'Reference data. FR-02 provenance. A non-fictional source must carry a uri and a retrieved_date.';
comment on column public.source.published_date is
  'Nullable on purpose: a NULL here is the undated-source signal PRD 8.2 requires be visible, not a missing value to be backfilled.';

-- ---------------------------------------------------------------------------
-- scenario_claim. THE GROUNDING WHITELIST (ADR-0008, canon §5.1, §7.3).
-- ---------------------------------------------------------------------------
-- A model citation naming a (scenario_version_id, claim_id) absent from this table is
-- rejected server-side, and the citation tables of canon §7.3 carry a composite FK to
-- the triple below so a fabricated citation cannot be persisted at all. That is why both
-- keys exist:
--   * primary key (scenario_version_id, claim_id) — canon §5.1, the whitelist lookup.
--   * unique (scenario_version_id, source_id, claim_id) — the anchor canon §7.3 item 2
--     names, so the citation row can reference the whole triple rather than checking it
--     in application code.
-- claim_id is TEXT, not uuid, because the model emits it: a short editor-assigned handle
-- round-trips through a generated response far more reliably than a 36-character uuid,
-- and the shape check keeps anything prompt-injection-shaped out of a primary key. The
-- citation tables of a later slice must match this type.
create table public.scenario_claim (
  scenario_version_id uuid not null,
  claim_id            text not null,
  source_id           uuid not null,
  claim_text          text not null,
  confidence          text not null,
  constraint scenario_claim_pk primary key (scenario_version_id, claim_id),
  constraint scenario_claim_id_shape check (claim_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  constraint scenario_claim_text_present check (length(btrim(claim_text)) > 0),
  -- Same-version enforcement, relationally: a claim cannot cite a source attached to a
  -- different scenario_version.
  constraint scenario_claim_source_fk foreign key (source_id, scenario_version_id)
    references public.source (id, scenario_version_id) on delete restrict,
  constraint scenario_claim_citation_anchor
    unique (scenario_version_id, source_id, claim_id),
  -- An ORDINAL evidence band, and deliberately NOT the 0-100 smallint that
  -- decision_revision.confidence uses. The two measure different things: that column is
  -- the USER's forecast confidence, which is elicited as a percentage (FR-05); this one
  -- is the editor's confidence in a sourced claim, for which a percentage would imply a
  -- calibration no editorial process produces. The domain is copied from
  -- dimension_assessment.evidence_quality in canon §5.1 rather than invented.
  constraint scenario_claim_confidence_known
    check (confidence in ('high', 'medium', 'low', 'insufficient'))
);
create index scenario_claim_source_idx on public.scenario_claim (source_id);

comment on table public.scenario_claim is
  'Reference data. THE GROUNDING WHITELIST (ADR-0008): a citation naming an absent (scenario_version_id, claim_id) is rejected server-side and cannot be persisted.';

-- ---------------------------------------------------------------------------
-- RLS. Forced, policies omit the TO clause (V9), raising accessor in the qual (V5/V7).
-- See the POSTURE DECISION block in the header for why this exact shape.
-- ---------------------------------------------------------------------------
alter table public.scenario         enable row level security;
alter table public.scenario         force  row level security;
alter table public.scenario_version enable row level security;
alter table public.scenario_version force  row level security;
alter table public.source           enable row level security;
alter table public.source           force  row level security;
alter table public.scenario_claim   enable row level security;
alter table public.scenario_claim   force  row level security;
alter table public.rubric_version   enable row level security;
alter table public.rubric_version   force  row level security;

create policy scenario_read on public.scenario
  for select using (app.require_user_id() is not null);
create policy scenario_version_read on public.scenario_version
  for select using (app.require_user_id() is not null);
create policy source_read on public.source
  for select using (app.require_user_id() is not null);
create policy scenario_claim_read on public.scenario_claim
  for select using (app.require_user_id() is not null);
create policy rubric_version_read on public.rubric_version
  for select using (app.require_user_id() is not null);

-- ---------------------------------------------------------------------------
-- Immutability (brief requirement 1, canon §4.4, FR-04).
--
-- INVARIANT CHECK FIRST (V31). This body has no early return, no common-case
-- short-circuit and no branch of any kind in front of the published_at test. V31 was
-- reproduced in this project on app.guard_decision_transition(), where an early
-- `return NEW` sat above the frozen-draft check and made it unreachable for exactly the
-- tampering case it guarded. The ordering here is not stylistic.
--
-- NEW is never read. V28: NEW.<col> is NULL in BEFORE UPDATE when the column is
-- GENERATED, and scenario_version.content_hash is generated — a guard that compared
-- OLD.content_hash to NEW.content_hash would compare against NULL on every update and
-- therefore fire on all of them or none. The gate asks only whether the row was already
-- published, which is a fact about OLD alone.
--
-- Role-independent: this fires for statesman_owner too (V32), so a migration that needs
-- to correct a published row has to disable the trigger explicitly and visibly.
-- ---------------------------------------------------------------------------
create function app.guard_published_reference() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  if OLD.published_at is not null then
    raise exception '% row % is published and cannot be changed by %',
      TG_TABLE_NAME, OLD.id, lower(TG_OP)
      using errcode = 'ST020';
  end if;
  if TG_OP = 'DELETE' then
    return OLD;
  end if;
  return NEW;
end $$;

-- V15: TRUNCATE bypasses row-level BEFORE UPDATE/DELETE triggers entirely, so the gate
-- above is blind to it. A statement-level BEFORE TRUNCATE trigger is the only row-trigger
-- route, and it is paired with the absent TRUNCATE grant below — two controls, because
-- V15 is precisely the case where one of them looks sufficient and is not. Unconditional:
-- there is no legitimate TRUNCATE of reference content, published or not, since a truncate
-- of an unpublished table still destroys every published row beside it.
create function app.forbid_reference_truncate() returns trigger
  language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'reference content table % cannot be truncated', TG_TABLE_NAME
    using errcode = 'ST021';
end $$;

create trigger scenario_version_published_immutable
  before update or delete on public.scenario_version
  for each row execute function app.guard_published_reference();
create trigger rubric_version_published_immutable
  before update or delete on public.rubric_version
  for each row execute function app.guard_published_reference();

create trigger scenario_no_truncate         before truncate on public.scenario
  for each statement execute function app.forbid_reference_truncate();
create trigger scenario_version_no_truncate before truncate on public.scenario_version
  for each statement execute function app.forbid_reference_truncate();
create trigger source_no_truncate           before truncate on public.source
  for each statement execute function app.forbid_reference_truncate();
create trigger scenario_claim_no_truncate   before truncate on public.scenario_claim
  for each statement execute function app.forbid_reference_truncate();
create trigger rubric_version_no_truncate   before truncate on public.rubric_version
  for each statement execute function app.forbid_reference_truncate();

-- ---------------------------------------------------------------------------
-- Grants (brief requirement 3). SELECT only. No INSERT, UPDATE, DELETE or TRUNCATE on
-- any of the five, for any role but the owner. Asserted by CTRL-2 below.
-- ---------------------------------------------------------------------------
grant select on public.scenario         to statesman_app;
grant select on public.scenario_version to statesman_app;
grant select on public.source           to statesman_app;
grant select on public.scenario_claim   to statesman_app;
grant select on public.rubric_version   to statesman_app;

-- ---------------------------------------------------------------------------
-- Posture exemptions — rule 9 only. See the POSTURE DECISION block in the header.
-- ---------------------------------------------------------------------------
insert into public.posture_exempt_table (table_name, reason) values
  ('scenario',
   'reference data, no owner column: rule 9 sentinels are user_id-keyed and these rows have no user. Rule 1 still forces RLS + policy because statesman_app holds SELECT; evidence is CTRL-3/CTRL-4 (uncontexted read raises 28000, contexted read does not).'),
  ('scenario_version',
   'reference data, no owner column: as scenario. Immutability is enforced by the ST020 publish gate, the ST021 truncate gate and absent grants, not by a tenancy policy.'),
  ('source',
   'reference data, no owner column: as scenario.'),
  ('scenario_claim',
   'reference data, no owner column: as scenario. This table is the grounding whitelist; it is read by every authenticated user and written only by migration/seed.'),
  ('rubric_version',
   'reference data, no owner column: as scenario.')
on conflict (table_name) do nothing;

-- ---------------------------------------------------------------------------
-- SENTINEL SEED — one reserved row per reference table.
--
-- WHY (measured, see the header): an empty forced-RLS table returns zero rows to an
-- uncontexted reader and raises nothing, because the qual is never reached. Without a row
-- that WOULD come back if the policy were missing, CTRL-3's denial is vacuous and so is
-- every reference-read test downstream. This is V18's argument, arrived at here by
-- failing CTRL-3 rather than by reasoning about it.
--
-- Reserved ids are the all-zero prefix block tagged with this migration's number:
-- ...000000080001 through ...000000080004. V33: z.guid() accepts these and z.uuid() would
-- reject them, like every other identifier in this project. The id block is distinct from
-- 0006's reserved user (...00000000dead) so a cross-table mix-up is visible on sight.
--
-- PRODUCT SAFETY — this row must never render as a case a user can pick up:
--   * scenario.status = 'archived', which is outside PRD 8.2's live states;
--   * scenario_version.published_at IS NULL, so it is not published content and the
--     authoritative "is this live" predicate excludes it;
--   * is_fiction = true and the slug, title and claim text all say so in words;
--   * the source is kind 'fictional_assumption' with no uri, so nothing here can be
--     mistaken for a citation to a real document — which is canon §1.2's editorial
--     boundary and FR-02, applied to the project's own fixture data.
--
-- Fixed ids and fixed timestamps, so a diff of the template is byte-stable.
--
-- Bracketed NO FORCE / FORCE (V8/V9): the policies above are `for select` only, so an
-- owner INSERT under FORCE has no applicable policy and is refused. Rows are COUNTED
-- while the bracket is still off, because once FORCE is back on the owner cannot read
-- them at all — the same ordering 0006 is written in, for the same reason.
-- ---------------------------------------------------------------------------
alter table public.scenario         no force row level security;
alter table public.scenario_version no force row level security;
alter table public.source           no force row level security;
alter table public.scenario_claim   no force row level security;
alter table public.rubric_version   no force row level security;

insert into public.rubric_version (id, version_no, content, published_at)
values ('00000000-0000-0000-0000-000000080001',
        2147483647,                    -- reserved: the top of the integer domain, so the
                                       -- sentinel can never collide with a real rubric
        '{"sentinel": true, "note": "reserved row — not an evaluation rubric"}'::jsonb,
        null)                          -- unpublished, so the ST020 gate leaves it mutable
on conflict (id) do nothing;

insert into public.scenario (id, slug, status, sector, jurisdiction, created_at)
values ('00000000-0000-0000-0000-000000080002',
        'sentinel-reserved-not-a-case',
        'archived',                    -- outside every live state in PRD 8.2
        'sentinel',
        'sentinel',
        '2026-01-01T00:00:00Z'::timestamptz)
on conflict (id) do nothing;

insert into public.scenario_version
  (id, scenario_id, version_no, content, is_fiction, as_of_date,
   rubric_version_id, published_at, created_at)
values ('00000000-0000-0000-0000-000000080003',
        '00000000-0000-0000-0000-000000080002',
        1,
        '{"sentinel": true, "note": "reserved row — not scenario content"}'::jsonb,
        true,                          -- FR-02: labelled invented, because it is
        '2026-01-01'::date,            -- PRD 8.2: dated, and not claimed to be current
        '00000000-0000-0000-0000-000000080001',
        null,                          -- never published
        '2026-01-01T00:00:00Z'::timestamptz)
on conflict (id) do nothing;

insert into public.source
  (id, scenario_version_id, title, publisher, uri, published_date, retrieved_date, kind)
values ('00000000-0000-0000-0000-000000080004',
        '00000000-0000-0000-0000-000000080003',
        'Reserved sentinel row — not a real source',
        'STATESMAN OS (fixture)',
        null, null, null,              -- permitted only because kind is fictional
        'fictional_assumption')
on conflict (id) do nothing;

insert into public.scenario_claim
  (scenario_version_id, claim_id, source_id, claim_text, confidence)
values ('00000000-0000-0000-0000-000000080003',
        'SENTINEL',
        '00000000-0000-0000-0000-000000080004',
        'Reserved sentinel row. Not a claim about anything, and not citable.',
        'insufficient')
on conflict (scenario_version_id, claim_id) do nothing;

-- Count while the bracket is still off, scoped to the reserved ids rather than to the
-- tables, so this says nothing about rows a later seed legitimately adds (V35's rule
-- applied to a migration). V7: 0 is never a success signal, so this asserts 1 each.
do $$
declare bad text := ''; n integer;
begin
  select count(*) into n from public.rubric_version
    where id = '00000000-0000-0000-0000-000000080001';
  if n <> 1 then bad := bad || format(E'\n  rubric_version sentinel: %s, expected 1', n); end if;

  select count(*) into n from public.scenario
    where id = '00000000-0000-0000-0000-000000080002';
  if n <> 1 then bad := bad || format(E'\n  scenario sentinel: %s, expected 1', n); end if;

  select count(*) into n from public.scenario_version
    where id = '00000000-0000-0000-0000-000000080003';
  if n <> 1 then bad := bad || format(E'\n  scenario_version sentinel: %s, expected 1', n); end if;

  select count(*) into n from public.source
    where id = '00000000-0000-0000-0000-000000080004';
  if n <> 1 then bad := bad || format(E'\n  source sentinel: %s, expected 1', n); end if;

  select count(*) into n from public.scenario_claim
    where scenario_version_id = '00000000-0000-0000-0000-000000080003'
      and claim_id = 'SENTINEL';
  if n <> 1 then bad := bad || format(E'\n  scenario_claim sentinel: %s, expected 1', n); end if;

  if bad <> '' then
    raise exception 'reference sentinel seed is not exactly one per table:%', bad
      using errcode = 'ST099';
  end if;
end $$;

alter table public.scenario         force row level security;
alter table public.scenario_version force row level security;
alter table public.source           force row level security;
alter table public.scenario_claim   force row level security;
alter table public.rubric_version   force row level security;

-- ---------------------------------------------------------------------------
-- CTRL-1 — the catalog facts the exemption rows must not be allowed to hide.
-- Rule 2 now skips these five tables, so this migration re-asserts from pg_catalog that
-- all five are RLS-enabled AND forced AND carry at least one policy. Catalog reads are
-- unaffected by RLS. A later edit that drops a policy or leaves FORCE off fails HERE as
-- well as at posture rule 1, which is the point: 0006 records that leaving FORCE off
-- fails nothing obvious and quietly makes every downstream denial test vacuous.
-- ---------------------------------------------------------------------------
do $$
declare n integer; missing text := '';
begin
  select count(*) into n
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public'
     and c.relname in ('scenario','scenario_version','source','scenario_claim','rubric_version')
     and c.relrowsecurity and c.relforcerowsecurity
     and (select count(*) from pg_policy where polrelid = c.oid) > 0;
  if n <> 5 then
    raise exception
      'CTRL-1: only % of 5 reference tables are RLS-enabled, forced and carry a policy', n
      using errcode = 'ST099';
  end if;

  -- And the exemptions themselves are present, so rule 9 cannot start failing because a
  -- row was lost rather than because a table was added.
  select count(*) into n from public.posture_exempt_table
   where table_name in ('scenario','scenario_version','source','scenario_claim','rubric_version');
  if n <> 5 then
    raise exception 'CTRL-1: % of 5 posture exemption rows present', n
      using errcode = 'ST099';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- CTRL-2 — requirement 3, measured rather than assumed. statesman_app holds SELECT and
-- holds none of INSERT, UPDATE, DELETE, TRUNCATE on any of the five. A `grant select`
-- that was written as `grant all` by a later edit fails here.
-- ---------------------------------------------------------------------------
do $$
declare r record; bad text := '';
begin
  for r in
    select c.oid, c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public'
       and c.relname in ('scenario','scenario_version','source','scenario_claim','rubric_version')
  loop
    if not has_table_privilege('statesman_app', r.oid, 'SELECT') then
      bad := bad || format(E'\n  statesman_app lacks SELECT on %s', r.relname);
    end if;
    if has_table_privilege('statesman_app', r.oid, 'INSERT')
       or has_table_privilege('statesman_app', r.oid, 'UPDATE')
       or has_table_privilege('statesman_app', r.oid, 'DELETE')
       or has_table_privilege('statesman_app', r.oid, 'TRUNCATE') then
      bad := bad || format(
        E'\n  statesman_app holds a write privilege on reference table %s', r.relname);
    end if;
  end loop;
  if bad <> '' then
    raise exception 'CTRL-2: reference-table grants are wrong:%', bad using errcode = 'ST099';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- CTRL-3 / CTRL-4 — the paired control for the posture decision, and the evidence that
-- replaces rule 9's sentinel for these tables.
--
-- CTRL-3 (the denial): with NO identity context, a read of every one of the five raises
-- 28000. This is the property the brief names as worth keeping, and it is what proves
-- app.require_user_id() is actually in the qual. Note why a denial test ALONE would be
-- worthless here: `using (false)` would also deny, by returning zero rows and raising
-- nothing (V7) — and V18 records that zero rows is indistinguishable from an empty
-- table. So the 28000 is the signal, not the absence of rows.
--
-- CTRL-4 (the positive control): with context set, the same read does NOT raise. Without
-- it, a policy of `using (app.require_user_id() is not null and false)` would pass CTRL-3
-- and ship five tables no authenticated user can read — a denial test passing for the
-- wrong reason, which is canon §8's whole subject.
--
-- Runs as statesman_owner under FORCE, which subjects the owner to the policy too
-- (V8/V9) — so these reads go through the qual rather than around it by ownership. The
-- context is restored explicitly: set_config(..., true) is transaction-local, but V17
-- records it persisting in cases where it looked scoped, so the restore is written out.
-- ---------------------------------------------------------------------------
do $$
declare
  sentinel  constant uuid := '00000000-0000-0000-0000-00000000dead';
  tables    constant text[] := array[
    'scenario','scenario_version','source','scenario_claim','rubric_version'];
  t         text;
  raised    boolean;
  prev_ctx  text := current_setting('app.current_user_id', true);
  bad       text := '';
begin
  -- CTRL-3: no context -> 28000 from every table.
  perform set_config('app.current_user_id', '', true);
  foreach t in array tables loop
    raised := false;
    begin
      execute format('select 1 from public.%I limit 1', t);
    exception
      when sqlstate '28000' then raised := true;
      when others then
        bad := bad || format(E'\n  CTRL-3 %s raised %s (%s), expected 28000',
                             t, sqlerrm, sqlstate);
        raised := true;
    end;
    if not raised then
      bad := bad || format(
        E'\n  CTRL-3 %s returned instead of raising 28000 with no identity context', t);
    end if;
  end loop;

  -- CTRL-4: context set -> the same read must NOT raise.
  perform set_config('app.current_user_id', sentinel::text, true);
  foreach t in array tables loop
    begin
      execute format('select 1 from public.%I limit 1', t);
    exception when others then
      bad := bad || format(E'\n  CTRL-4 %s raised %s (%s) for an authenticated identity',
                           t, sqlerrm, sqlstate);
    end;
  end loop;

  perform set_config('app.current_user_id', coalesce(prev_ctx, ''), true);

  if bad <> '' then
    raise exception 'reference-table read policy is not the shape 0008 claims:%', bad
      using errcode = 'ST099';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- CTRL-5 — the ST020 publish gate and the ST021 truncate gate, exercised. A gate that
-- has never been made to fire has not been shown to work (canon §8). Each leg carries
-- its paired positive control: an UNPUBLISHED row must still be editable and deletable,
-- or the gate would be indistinguishable from an append-only table.
--
-- MEASURED HERE, AND IT MOVED THE TRUNCATE PROBE: the first draft of this control aimed
-- `truncate table public.rubric_version` at the gate and got
--
--     0A000  cannot truncate a table referenced in a foreign key constraint
--     DETAIL: Table "scenario_version" references "rubric_version".
--
-- The inbound foreign key refuses the statement BEFORE the BEFORE TRUNCATE trigger is
-- ever reached, so ST021 never fired and the control was asserting the wrong barrier. The
-- 0A000 is a real second barrier and it covers a bare TRUNCATE of `scenario`,
-- `scenario_version`, `source` and `rubric_version` — but it is NOT the gate, and it does
-- not cover the two cases that matter:
--   * `scenario_claim` has no inbound FK at all, so nothing but the trigger stops it. It
--     is also the grounding whitelist, which makes it the worst table to lose.
--   * `TRUNCATE ... CASCADE` is explicitly the FK barrier's escape hatch — Postgres even
--     prints it as the HINT — and it reaches every descendant table at once.
-- So the two truncate legs below are `scenario_claim` bare and `rubric_version CASCADE`,
-- which are the paths where the trigger is the only thing in the way.
--
-- Bracketed NO FORCE / FORCE (V8/V9) across all five tables, not just the one being
-- written: this block INSERTs as the owner and the policies above are `for select` only,
-- so without the bracket the inserts are refused — and the after-state reads that prove
-- each sentinel survived would raise 28000 under FORCE with no identity context, which is
-- CTRL-3's whole subject. One bracket, one restore, and CTRL-6 re-reads the catalog to
-- prove the restore happened.
--
-- The truncate legs are genuinely destructive if the gate is absent: a CASCADE that got
-- through would empty scenario_version, source and scenario_claim along with
-- rubric_version. That is what makes them controls rather than gestures, and it is why
-- every sentinel is counted afterwards instead of only the one table named in the probe.
-- ---------------------------------------------------------------------------
alter table public.scenario         no force row level security;
alter table public.scenario_version no force row level security;
alter table public.source           no force row level security;
alter table public.scenario_claim   no force row level security;
alter table public.rubric_version   no force row level security;

do $$
declare
  probe_unpub constant uuid := 'aaaaaaaa-0008-0008-0008-00000000c001';
  probe_pub   constant uuid := 'aaaaaaaa-0008-0008-0008-00000000c002';
  n           integer;
  caught      text;
  bad         text := '';
begin
  insert into public.rubric_version (id, version_no, content, published_at)
  values (probe_unpub, 900800001, '{"ctrl5":"unpublished"}'::jsonb, null),
         (probe_pub,   900800002, '{"ctrl5":"published"}'::jsonb,
          '2026-01-01T00:00:00Z'::timestamptz);
  get diagnostics n = row_count;
  if n <> 2 then                                     -- V7: 0 is never a success signal
    raise exception 'CTRL-5 seed inserted % rows, expected 2', n using errcode = 'ST099';
  end if;

  -- POSITIVE CONTROL: the unpublished row is editable.
  update public.rubric_version set content = '{"ctrl5":"edited"}'::jsonb
   where id = probe_unpub;
  get diagnostics n = row_count;
  if n <> 1 then
    bad := bad || format(E'\n  CTRL-5 positive: update of an UNPUBLISHED row affected % rows, expected 1', n);
  end if;

  -- GATE: the published row refuses UPDATE with ST020.
  caught := null;
  begin
    update public.rubric_version set content = '{"ctrl5":"tampered"}'::jsonb
     where id = probe_pub;
  exception when others then caught := sqlstate;
  end;
  if caught is distinct from 'ST020' then
    bad := bad || format(E'\n  CTRL-5 update of a PUBLISHED row gave %s, expected ST020',
                         coalesce(caught, 'no error'));
  end if;

  -- GATE: the published row refuses DELETE with ST020.
  caught := null;
  begin
    delete from public.rubric_version where id = probe_pub;
  exception when others then caught := sqlstate;
  end;
  if caught is distinct from 'ST020' then
    bad := bad || format(E'\n  CTRL-5 delete of a PUBLISHED row gave %s, expected ST020',
                         coalesce(caught, 'no error'));
  end if;

  -- GATE: TRUNCATE refuses with ST021 even though the row-level gate cannot see it (V15).
  -- Leg 1 — scenario_claim, which has NO inbound foreign key, so the 0A000 barrier does
  -- not apply and the trigger is the only control between this statement and an empty
  -- grounding whitelist.
  caught := null;
  begin
    execute 'truncate table public.scenario_claim';
  exception when others then caught := sqlstate;
  end;
  if caught is distinct from 'ST021' then
    bad := bad || format(E'\n  CTRL-5 truncate of scenario_claim gave %s, expected ST021',
                         coalesce(caught, 'no error'));
  end if;

  -- Leg 2 — CASCADE, the FK barrier's documented escape hatch. Without the trigger this
  -- statement empties rubric_version, scenario_version, source and scenario_claim.
  caught := null;
  begin
    execute 'truncate table public.rubric_version cascade';
  exception when others then caught := sqlstate;
  end;
  if caught is distinct from 'ST021' then
    bad := bad || format(E'\n  CTRL-5 truncate ... cascade gave %s, expected ST021',
                         coalesce(caught, 'no error'));
  end if;

  -- Teardown. The unpublished probe deletes (its own positive control for the DELETE
  -- leg); the published probe cannot, so the trigger is disabled for exactly that one
  -- statement and re-enabled immediately (V32's documented, bracketed escape).
  delete from public.rubric_version where id = probe_unpub;
  get diagnostics n = row_count;
  if n <> 1 then
    bad := bad || format(E'\n  CTRL-5 positive: delete of an UNPUBLISHED row affected % rows, expected 1', n);
  end if;

  alter table public.rubric_version disable trigger rubric_version_published_immutable;
  delete from public.rubric_version where id = probe_pub;
  get diagnostics n = row_count;
  alter table public.rubric_version enable  trigger rubric_version_published_immutable;
  if n <> 1 then
    bad := bad || format(E'\n  CTRL-5 teardown removed % published probe rows, expected 1', n);
  end if;

  -- Both row checks happen HERE, inside the bracket, and not after it. Once FORCE is back
  -- on, an owner read of this table goes through the qual and raises 28000 with no
  -- identity context — which is the whole point of CTRL-3 and would turn an after-state
  -- assertion into an unrelated error. Scoped to the ids this block owns, never to the
  -- table (V35's rule applied to a migration).
  select count(*) into n from public.rubric_version
   where id in (probe_unpub, probe_pub);
  if n <> 0 then
    bad := bad || format(E'\n  CTRL-5: % probe rows survived teardown', n);
  end if;

  -- EVERY sentinel survived — not only the table named in the probe. The CASCADE leg
  -- reaches four tables, so a check scoped to rubric_version would report success while
  -- scenario_version, source and the grounding whitelist sat empty. If the ST021
  -- assertion were ever weakened to accept any error, or the gate removed, this is what
  -- notices, and CTRL-3's denial would otherwise have gone vacuous in silence.
  select count(*) into n from public.scenario
    where id = '00000000-0000-0000-0000-000000080002';
  if n <> 1 then bad := bad || format(
    E'\n  CTRL-5: scenario sentinel count is %, expected 1 — a truncate got through', n); end if;

  select count(*) into n from public.scenario_version
    where id = '00000000-0000-0000-0000-000000080003';
  if n <> 1 then bad := bad || format(
    E'\n  CTRL-5: scenario_version sentinel count is %, expected 1 — a truncate got through', n); end if;

  select count(*) into n from public.source
    where id = '00000000-0000-0000-0000-000000080004';
  if n <> 1 then bad := bad || format(
    E'\n  CTRL-5: source sentinel count is %, expected 1 — a truncate got through', n); end if;

  select count(*) into n from public.scenario_claim
    where scenario_version_id = '00000000-0000-0000-0000-000000080003'
      and claim_id = 'SENTINEL';
  if n <> 1 then bad := bad || format(
    E'\n  CTRL-5: scenario_claim sentinel count is %, expected 1 — a truncate got through', n); end if;

  select count(*) into n from public.rubric_version
    where id = '00000000-0000-0000-0000-000000080001';
  if n <> 1 then bad := bad || format(
    E'\n  CTRL-5: rubric_version sentinel count is %, expected 1 — a truncate got through', n); end if;

  if bad <> '' then
    raise exception 'the ST020/ST021 gates are not the shape 0008 claims:%', bad
      using errcode = 'ST099';
  end if;
end $$;

alter table public.scenario         force row level security;
alter table public.scenario_version force row level security;
alter table public.source           force row level security;
alter table public.scenario_claim   force row level security;
alter table public.rubric_version   force row level security;

-- ---------------------------------------------------------------------------
-- CTRL-6 — the seed bracket and CTRL-5's bracket are both closed, and every trigger
-- CTRL-5 disabled is back on. Catalog reads only, because they are the only reads that
-- work either side of a FORCE boundary. A NO FORCE left open would make the owner's
-- bypass permanent, which is exactly the failure 0006 records as invisible: it fails no
-- migration, passes posture rule 1's "enabled and forced" only by accident of ordering,
-- and quietly makes every denial test downstream vacuous. A DISABLE TRIGGER left open is
-- the same hazard for the ST020 gate. This file opens the bracket twice, so it checks
-- once at the end rather than trusting either restore.
-- ---------------------------------------------------------------------------
do $$
declare r record; bad text := ''; tg_enabled text;
begin
  for r in
    select c.relname, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
      from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public'
       and c.relname in ('scenario','scenario_version','source','scenario_claim','rubric_version')
     order by c.relname
  loop
    if not (r.enabled and r.forced) then
      bad := bad || format(E'\n  %s left with rls_enabled=%s, rls_forced=%s',
                           r.relname, r.enabled, r.forced);
    end if;
  end loop;

  -- 'O' is "enabled, origin". CTRL-5 disables this one trigger for a single DELETE.
  select t.tgenabled::text into tg_enabled from pg_trigger t
    where t.tgrelid = 'public.rubric_version'::regclass
      and t.tgname = 'rubric_version_published_immutable';
  if tg_enabled is distinct from 'O' then
    bad := bad || format(E'\n  rubric_version_published_immutable left tgenabled=%s, expected O',
                         coalesce(tg_enabled, 'missing'));
  end if;

  if bad <> '' then
    raise exception 'CTRL-6: 0008 left a bracket or a trigger open:%', bad
      using errcode = 'ST099';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- V2 / V30: EXECUTE is granted to PUBLIC on every new function by default, and
-- ALTER DEFAULT PRIVILEGES cannot remove it. The explicit REVOKE after creation is the
-- only working control, and posture rule 4 is the gate on it. Two functions are created
-- above; neither needs an app grant, because a trigger function is not privilege-checked
-- against the invoking role when the trigger fires — the same reason 0001's
-- app.forbid_mutation() has no grant.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema app    from public;
revoke execute on all functions in schema public from public;
