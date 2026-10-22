-- 0009 Seed the P0 training case: DEMO-PH-001, "A Regional Dengue Response Under
-- Uncertainty" (PRD Appendix A).
--
-- This file creates no table, no function, no policy and no trigger. It seeds reference
-- rows into the five tables 0008 built, and it asserts — from the database, after the
-- write — the properties the case is claimed to have. Nothing here is a new security
-- control, so canon 8.6b's standing rule ("a new security guard ships with a mutation
-- proving its control bites") has nothing to attach to: no guard is added, no guard is
-- weakened, and the mutation registry is untouched and un-owed. The assertions below are
-- build-time integrity controls over CONTENT, which is a different kind of thing from a
-- runtime access control.
--
-- ===========================================================================
-- POSTURE — inherited, and WHICH OPTION WAS CHOSEN (brief rule 1)
-- ===========================================================================
-- The slice brief offers two ways to make reference content satisfy
-- app.verify_security_posture(): a policy permitting read to any authenticated identity
-- while still mentioning app.require_user_id(), or an exemption row with a stated reason.
-- 0008 took BOTH, for reasons it records at length, and this file ADDS NO TABLE, so it
-- inherits that decision rather than making a new one. For the avoidance of doubt, the
-- shape this content is now protected by is:
--
--   * THE POLICY, which is the operative control: `for select using
--     (app.require_user_id() is not null)` on all five tables. Read is permitted to any
--     authenticated identity and an UNAUTHENTICATED read raises 28000 rather than
--     returning rows. Not `using (true)`, so posture rule 8 passes on both of its tests.
--   * THE EXEMPTION ROWS, which waive posture rule 9 ONLY — rule 9's sentinel mechanism
--     is keyed on a `user_id` column and reference rows have no owner. Rule 1 is not
--     exemption-aware and still forces RLS plus a policy on all five, because
--     statesman_app holds SELECT.
--
-- No posture rule is weakened here, and none is relied on implicitly: SEED-CTRL-A and
-- SEED-CTRL-B below re-measure the denial and its positive control against THIS case's
-- rows, which is a stronger instrument than 0008 had available. 0008 measured those
-- controls against a deliberately reserved sentinel row; from this file onward the same
-- qual is also exercised over 47 real claim rows, so a policy that stopped raising would
-- now be caught over content a user actually reads.
--
-- ===========================================================================
-- THE EDITORIAL BOUNDARY, AND HOW IT IS ENFORCED RATHER THAN PROMISED
-- ===========================================================================
-- Canon 1.2 and PRD 9.4: Guyana-first is editorial CONTEXT, not licence to invent
-- Guyanese legal provisions, current incidents, prices, budgets, institutional positions
-- or health facts. FR-08 and PRD 9.4 prohibit fabricated citations, statutes and
-- institutional positions outright.
--
-- The honest default this case takes, and the one content/README.md asks case 2 to take:
-- EVERY source in the register is an explicitly fictional in-scenario document. There is
-- no citation to a real publication, agency, statute, official or dataset anywhere in the
-- case — no invented DOI, no invented URL, no invented circular number, not even a
-- fictional statute, because a fictional statute still teaches that a provision exists to
-- be relied on. Legal authority appears in this case ONLY as a question the user must
-- verify, which is exactly the PRD Appendix A legal challenge ("Which legal power
-- authorizes the proposed restriction, and what must be verified before using it?").
--
-- That is a claim about content, so it is MEASURED here rather than asserted in prose.
-- SEED-4 below reads the rows back and fails the migration unless:
--   * every source row for this version has kind = 'fictional_assumption' AND uri IS NULL
--     — so no row in the register can masquerade as a reachable real document;
--   * every source title contains the literal string '(fictional scenario document)' and
--     every publisher contains 'fictional' — so the label travels with the row into any
--     renderer, export or prompt, rather than living in a header comment;
--   * no source title, publisher or claim_text contains 'http', 'www.' or 'doi.org' — the
--     cheap, specific control against a later editor pasting a link into content that has
--     no uri column to put it in;
--   * scenario_version.is_fiction is true AND agrees with the body's own fiction notice,
--     so the column and the prose cannot drift apart;
--   * as_of_date is set (the column is NOT NULL, so this is a restatement, labelled as
--     one rather than counted as an independent control).
--
-- The jurisdiction is invented: the Republic of Mereva and Kerrin Region, their three
-- districts, four settlements, five facilities and six bodies exist nowhere. No real
-- Guyanese region, town, hospital, body or official is named. Every person in the case
-- appears by ROLE only, so PRD 9.3's no-impersonation rule cannot be breached by a
-- renderer that prints a name. All money is in an invented "in-scenario currency unit
-- (ISU)" with no exchange rate, so no figure can be read as a real budget or price. No
-- clinical, epidemiological or vector-biology claim about dengue as a disease appears
-- anywhere: stating one would need either a real citation (prohibited here) or an
-- invented health fact (worse), and clinical management is out of the coordinating
-- executive's scope in this case by design.
--
-- WHAT IS NOT CLAIMED: no real-world grounding is asserted for the DESIGN of the case
-- either. content/README.md records that this case was written entirely from fictional
-- in-scenario documents, with no real reference cited for how dengue response is
-- generally structured, because a reference nobody has verified is the failure mode the
-- brief names — and a plausible-looking citation to a real organisation is worse than an
-- obviously fictional one, since a learner may act on it.
--
-- ===========================================================================
-- THE CLAIM REGISTER IS DERIVED FROM THE CASE BODY, NOT TRANSCRIBED BESIDE IT
-- ===========================================================================
-- public.scenario_claim is the grounding whitelist (canon 5.1, 7.3): a citation naming a
-- (scenario_version_id, claim_id) absent from it is rejected server-side and, once the
-- citation tables of a later slice exist, cannot be persisted at all. So a claim the case
-- body asserts but does not register is a claim nothing downstream can ever cite.
--
-- Transcribing 47 claims twice — once into the jsonb body and once into INSERT values —
-- would make that failure a typo away. Instead the source and claim rows are DERIVED from
-- `scenario_version.content` by jsonb_to_recordset, so the register and the body cannot
-- disagree by construction, and SEED-6 additionally resolves every claim id referenced
-- anywhere else in the body (the ten conflict sets, the seven stakeholder position lists,
-- the three constraint blocks and the five lens grounding lists) against the registered
-- rows. A case that cites an unregistered claim fails the build here.
--
-- content/demo-ph-001.json holds the same bytes that are spliced into the literal below,
-- and content/README.md records the exact command that re-checks file-against-database
-- equality. 0008's header explains why an outside hash of the jsonb is NOT reproducible
-- (jsonb normalises key order, so `jsonb_send` has no byte-stable external twin), which
-- is why the drift check is a key-sorted jq comparison rather than a hash.
--
-- ===========================================================================
-- FIVE LENSES OR THE BUILD FAILS (SEED-3)
-- ===========================================================================
-- The AI layer is Slice 4 and is not built here, but PRD 5.3 requires all five lenses —
-- legal authority, public finance, ethics and equity, execution, community impact — and
-- FR-07 requires each to reference decision text, a constraint or an identified
-- information gap. A case that cannot ground five lenses in registered claims makes that
-- slice impossible, and the failure would surface as an abstaining model rather than as a
-- content defect. SEED-3 therefore fails this migration unless every one of the five
-- lenses is carried by at least one registered claim AND every claim id named in the
-- body's lens grounding lists resolves. Measured at seed time: 9 to 28 claims per lens.
--
-- ===========================================================================
-- CONFLICT IS THE POINT (PRD 5.2)
-- ===========================================================================
-- PRD 5.2 requires data gaps and competing legitimate interests. Ten conflict sets are
-- registered, each naming the claims that collide, including two counting instruments
-- that cannot both be right about the same village, a testing capacity that reads
-- sufficient by stock and insufficient by turnaround, an authority asserted from practice
-- and denied in writing, one river boat committed twice, and a contingency line whose
-- arithmetic (60 per cent of 18,400,000 ISU is 11,040,000; the two operational asks are
-- 9,600,000 and the protected roof commitment is a further 4,100,000) will not stretch
-- over all three asks. The case does not resolve any of them, and nine data gaps are
-- registered as gaps rather than quietly left out.
--
-- ===========================================================================
-- NEW SQLSTATE (brief rule 2 — UPPERCASE, V13)
-- ===========================================================================
--   ST022  seeded scenario content integrity: a seed assertion in this file failed.
--
-- In use before this file: ST001, ST002, ST003, ST005, ST010, ST011, ST012, ST020,
-- ST021, ST099. ST022 is new and deliberately NOT ST099: ST099 is the posture checker's
-- code and this is a content-integrity failure, not a security-posture failure, and
-- overloading it would make a posture alert mean two different things.
--
-- ST022 is raised only while a migration is running, as statesman_owner, never by the
-- application path — nothing the app can call reaches this file — so no mapping in
-- src/server/db/errors.ts is owed for it. (ST020/ST021 are different: they are reachable
-- at runtime and 0008 records their mapping as an owed follow-up. This file neither
-- discharges nor worsens that debt.)
--
-- ===========================================================================
-- V8 / V9 — THE SEED BRACKET
-- ===========================================================================
-- The 0008 policies are `for select` only, so an owner INSERT under FORCE ROW LEVEL
-- SECURITY has no applicable policy and is refused outright, and an owner SELECT raises
-- 28000 with no identity context. Both halves matter here, because this file writes AND
-- reads back. So: NO FORCE on all five tables, insert, derive, assert, restore FORCE —
-- one bracket, closed in this file, re-measured from pg_catalog by SEED-CTRL-C.
--
-- V7 — every count is asserted and no count is allowed to pass vacuously. Each row count
-- is checked BOTH against the case body's own register length (so the rows and the body
-- cannot disagree) AND against a hard floor (so an empty register could not satisfy the
-- equality 0 = 0 and report success). An equality test alone would have been exactly the
-- "gate that passes while exercising nothing" of canon 8.
--
-- V35's rule applied to a migration: every count below is scoped to this case's
-- scenario_version_id or to the specific reserved ids, never to a table, so nothing here
-- asserts anything about rows another seed legitimately adds.
--
-- ===========================================================================
-- RESERVED IDS
-- ===========================================================================
-- The all-zero prefix block tagged with this migration's number, which is the convention
-- 0006 and 0008 follow:
--   ...000000090001  rubric_version 1          (published)
--   ...000000090002  scenario DEMO-PH-001
--   ...000000090003  scenario_version 1        (published — immutable from here on)
--   ...000000090101 .. ...000000090110  the ten fictional in-scenario sources
-- This block is REAL PUBLISHED CONTENT, not a sentinel. 0008's ...00000008xxxx block
-- remains the reserved reference sentinel and 0006's ...00000000dead remains the reserved
-- user, so the three blocks are distinguishable on sight. V33: z.guid() accepts all of
-- these and z.uuid() would reject them, like every other identifier in this project.
--
-- Fixed ids, fixed published_at, fixed in-world dates, so a diff of the template is
-- byte-stable.
--
-- ===========================================================================
-- DECLARED DECISIONS (things the canon did not settle, recorded rather than assumed)
-- ===========================================================================
-- 1. rubric_version 1 is authored HERE. scenario_version's
--    `scenario_version_published_has_rubric` CHECK makes a published version without a
--    rubric impossible, and the only rubric row 0008 leaves behind is its reserved
--    sentinel. So seeding the case requires seeding a rubric, which is why a rubric this
--    file was not asked for exists in it. Its content is PRD 7.1-7.3 restated as data:
--    five dimensions, five maturity levels, the AI ceiling of level 2, the four evidence
--    bands, the six formative criteria, and the prohibitions of canon 1.2.
--
-- 2. scenario.status = 'published' and scenario_version.published_at is set, while the
--    case body records subject-matter/ethics review as PENDING with a named evidence
--    record (docs/reviews/demo-ph-001-content-review.md) and NO reviewer name or date.
--    Canon 12.3 forbids inventing a sign-off, and PRD 8.2 puts review before publication,
--    so the two pull against each other for a case that P0 needs live in the build. The
--    choice: publish the content, and record the undischarged leg in the content itself
--    where any renderer or export carries it, rather than invent a reviewer to make the
--    pipeline look complete. The source-verification stage of PRD 8.2 is recorded as
--    NOT APPLICABLE with its reason stated: that stage exists to verify external sources
--    and this case cites none. Treat the ethics leg as a pilot release-gate item.
--
-- 3. source.published_date and source.retrieved_date carry IN-WORLD dates for these
--    fictional documents. PRD 8.1 requires a source list with access dates, and 0008's
--    `source_factual_is_traceable` CHECK deliberately exempts kind
--    'fictional_assumption' from needing either. DECLARED RESIDUAL: no column
--    distinguishes an in-world date from a real retrieval date, so a renderer could print
--    "retrieved 2026-03-06" next to a fictional document. What carries the distinction is
--    the row's own kind, its title ('(fictional scenario document)'), its publisher
--    ('(fictional in-scenario body)'), scenario_version.is_fiction, and the case body's
--    `in_world_published_date` / `in_world_retrieved_date` keys, which name the semantics
--    explicitly for an editor. A renderer that prints the date MUST print the title.
--
-- 4. scenario_claim.confidence for a wholly fictional case is the DESIGNED in-world
--    evidential strength of the document the claim comes from — a handwritten tally is
--    'low', a laboratory stock count is 'high' — and never a truth claim about the world,
--    which would be meaningless for invented material. That reading is what makes the
--    band teachable: the learner is being asked to notice that the instrument disagreeing
--    with the official figures is also the weaker instrument, without being told which is
--    right. Recorded here and in content/README.md so case 2 uses the band the same way.
-- ===========================================================================
\set ON_ERROR_STOP on
set role statesman_owner;

-- ---------------------------------------------------------------------------
-- The seed bracket opens. All five tables, because this file reads back what it writes
-- and an owner SELECT under FORCE raises 28000 with no identity context (V8/V9).
-- ---------------------------------------------------------------------------
alter table public.scenario         no force row level security;
alter table public.scenario_version no force row level security;
alter table public.source           no force row level security;
alter table public.scenario_claim   no force row level security;
alter table public.rubric_version   no force row level security;

-- ---------------------------------------------------------------------------
-- rubric_version 1. Published, therefore immutable from here (ST020), therefore inserted
-- complete in one statement: there is no later UPDATE available to fix it.
-- ---------------------------------------------------------------------------
insert into public.rubric_version (id, version_no, content, published_at)
values ('00000000-0000-0000-0000-000000090001', 1,
$rubric$
{
  "rubric_id": "RUBRIC-P0-001",
  "version_no": 1,
  "reference": "PRD 7.1 five assessment dimensions, 7.2 maturity levels per dimension, 7.3 formative decision-quality rubric, 7.4 decision calibration.",
  "dimensions": [
    { "key": "knowledge", "label": "Knowledge", "good_evidence_demonstrates": "Accurate understanding of institutions, context, evidence and relevant uncertainty" },
    { "key": "judgment", "label": "Judgment", "good_evidence_demonstrates": "Prioritization under constraints; alternatives, trade-offs and second-order effects" },
    { "key": "execution", "label": "Execution", "good_evidence_demonstrates": "Practical sequencing, roles, resources, indicators and implementation controls" },
    { "key": "ethics", "label": "Ethics", "good_evidence_demonstrates": "Legality, fairness, affected populations, transparency and accountability" },
    { "key": "learning", "label": "Learning", "good_evidence_demonstrates": "Honest error recognition, adaptation, corrective actions and later reassessment" }
  ],
  "maturity_levels": [
    { "level": 0, "label": "Unassessed", "definition": "Insufficient evidence" },
    { "level": 1, "label": "Understood", "definition": "Explains relevant concepts correctly" },
    { "level": 2, "label": "Applied in exercises", "definition": "Demonstrates relevant application in structured scenarios" },
    { "level": 3, "label": "Demonstrated in practice", "definition": "Documents relevant real-world performance and outcomes" },
    { "level": 4, "label": "Independently validated", "definition": "A qualified external reviewer confirms adequate, repeatable evidence" }
  ],
  "ai_assessor_max_observed_level": 2,
  "ai_ceiling_rationale": "A simulation alone cannot establish level 3 or level 4 (PRD 7.2). The full 0-4 domain stays in the database and the AI is constrained, not the product. To be enforced by the ai_never_awards_practice_levels CHECK on dimension_assessment (canon 5.1), which does not exist yet: dimension_assessment arrives with the reflection slice. Until then this ceiling is a stated rule with no database control behind it, and nothing stops a level above 2 being written.",
  "evidence_quality_bands": ["high", "medium", "low", "insufficient"],
  "formative_criteria": [
    "clarity of problem definition",
    "use of evidence",
    "feasibility and trade-offs",
    "recognition of legal and ethical constraints",
    "contingency planning",
    "monitoring and learning"
  ],
  "display_rule": "Display observed level PLUS evidence quality, source, assessor kind and review date (PRD 7.2). AI output is labeled AI-generated formative analysis (PRD 9.3).",
  "calibration_rule": "Capture forecast, confidence, deadline and later observation separately. Do not mark a case right merely because a favourable result occurred. Where no reliable observation is available, record Not yet observable (PRD 7.4).",
  "prohibited": [
    "Any composite readiness, character or viability score (canon 1.2).",
    "Any statement about the user's character or eligibility for office (PRD 7.3).",
    "Any AI-awarded maturity level 3 or 4 (canon 1.2, PRD 7.2).",
    "Any level progression occurring solely because an AI says performance has improved (PRD 7.2).",
    "Presenting a simulated consequence as a forecast (PRD 8.3)."
  ]
}
$rubric$::jsonb,
        '2026-10-21T00:00:00Z'::timestamptz)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- The case identity. PRD 8.2's editorial status lives here; the authoritative "is this
-- live" signal is scenario_version.published_at below.
-- ---------------------------------------------------------------------------
insert into public.scenario (id, slug, status, sector, jurisdiction, created_at)
values ('00000000-0000-0000-0000-000000090002',
        'demo-ph-001',
        'published',
        'Public health emergency coordination',
        'Kerrin Region, Republic of Mereva (invented jurisdiction)',
        '2026-10-21T00:00:00Z'::timestamptz)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- scenario_version 1 — the unit a decision_revision pins to, and the single source of
-- truth for this case's body, source register and claim register. Published here, so the
-- ST020 gate makes it immutable from the next statement onward.
--
-- The literal below is byte-identical to content/demo-ph-001.json. It is spliced, not
-- retyped: see content/README.md for the command that re-verifies that, and why the check
-- is a key-sorted jq comparison rather than a hash (0008's header, jsonb_send).
-- ---------------------------------------------------------------------------
insert into public.scenario_version
  (id, scenario_id, version_no, content, is_fiction, as_of_date,
   rubric_version_id, published_at, created_at)
values ('00000000-0000-0000-0000-000000090003',
        '00000000-0000-0000-0000-000000090002',
        1,
$json$
{
  "case_id": "DEMO-PH-001",
  "case_version": 1,
  "title": "A Regional Dengue Response Under Uncertainty",
  "ids": {
    "scenario_id": "00000000-0000-0000-0000-000000090002",
    "scenario_version_id": "00000000-0000-0000-0000-000000090003",
    "rubric_version_id": "00000000-0000-0000-0000-000000090001"
  },
  "fiction_notice": {
    "is_fiction": true,
    "statement": "This case is entirely invented training material. The Republic of Mereva, Kerrin Region, every settlement, facility, body, office, document, figure and currency unit named here does not exist and resembles no actual jurisdiction, institution, dataset or event. No real outbreak, no real statute, no real circular, no real official and no real price appears anywhere in this case or in its source register.",
    "every_source_is_fictional": true,
    "as_of_date": "2026-03-06",
    "as_of_date_meaning": "The in-world date on which the briefing reaches the user. It is not a real-world currency claim about anything.",
    "not_a_forecast": "Anything the exercise narrates as a consequence is a teaching device and never an empirical forecast (PRD 8.3)."
  },
  "editorial_boundary": {
    "rule": "Guyana-first is editorial context, not license to invent Guyanese legal provisions, institutional positions, budgets, prices or health data (canon 1.2, PRD 9.4, FR-08).",
    "how_this_case_complies": [
      "The jurisdiction is invented. No real region, town, hospital, body or official is named.",
      "No statute, regulation, circular, instrument number or legal provision is named, invented or cited - not even a fictional one. Legal authority appears only as a question the user must verify and as two in-scenario officials disagreeing about it.",
      "No epidemiological or clinical fact about dengue as a disease appears in the register. Stating one would require either a real citation, which is prohibited here, or an invented health fact, which is worse. Clinical management is out of scope for the role this case asks the user to play.",
      "Every money figure is denominated in an invented in-scenario currency unit (ISU) so that no number can be read as a real budget or price.",
      "Every source is an in-scenario document authored with the case, labeled as such in its own title and publisher, and carrying kind 'fictional_assumption' in the database."
    ]
  },
  "learning_objective": "Set first-72-hour priorities when two surveillance instruments disagree, the authority to restrict movement is believed but unverified, and every resource that could be moved is already committed to something else; identify explicitly what must be verified before acting; allocate finite testing and transport capacity with the trade-off stated; and communicate uncertainty without either minimizing risk or causing alarm.",
  "sector": "Public health emergency coordination",
  "jurisdiction": {
    "name": "Kerrin Region, Republic of Mereva",
    "status": "invented",
    "description": "A low-lying coastal and riverine region of an invented tropical state, with three districts: Kerrin East (coastal, containing the regional town of Pellon), Kerrin West (agricultural), and Kerrin Interior (riverine and forested, reachable mainly by boat).",
    "settlements": [
      "Pellon - regional town, Kerrin East, in-world population estimate 41,000 (2019 in-world estimate)",
      "Dray Hill - farming village, Kerrin West",
      "Sabaka Landing - riverine village cluster, Kerrin Interior",
      "Three Creeks - interior settlement, Kerrin Interior"
    ],
    "facilities": [
      "Kerrin Regional Hospital, Pellon - 18 inpatient beds, 7 clinical staff",
      "Kerrin Regional Laboratory, Pellon - 3 technicians",
      "Sabaka Landing Health Post - staffed until 14:00, no overnight cover",
      "Three Creeks Health Post - roof repair deferred",
      "Dray Hill Clinic"
    ],
    "bodies": [
      "Office of the National Coordinating Executive - the user's office",
      "Kerrin Regional Health Authority (KRHA)",
      "National Health Coordination Office (NHCO)",
      "National Disaster Coordination Unit (NDCU)",
      "National Laboratory Service (NLS)",
      "Regional Transport Pool (RTP)"
    ],
    "people": "Every person in this case appears by role only. No name, real or invented, is attached to any position, so no one can be impersonated and no invented official can be mistaken for a real one."
  },
  "issue_statement": "Kerrin Region has reported a rising number of suspected dengue cases over two weeks. Two counting instruments disagree and the regional surveillance desk has not reconciled them. Laboratory confirmation exists for a small minority of suspected cases and the only confirmatory route runs through the national laboratory with a five-to-seven-day turnaround. The regional health authority has asked for an immediate movement restriction on one riverine village; the coordinating office's own legal adviser has asked for written confirmation of the power to issue such an order and reports that none has been located. The two river boats that could carry testing and staff into the interior are already committed, one of them to a school-feeding run the affected community was told would continue. A regional radio station has asked for a statement by midday tomorrow, a public statement issued four days ago described testing capacity as adequate, and a claim that the rapid tests cause the illness is circulating in two of the three districts. An interagency call reconvenes in-world 8 March at 18:00 and expects an interim 72-hour plan.",
  "user_role": {
    "title": "National coordinating executive for a simulated interagency response",
    "authority_in_scenario": "Chairs the interagency response, directs the coordinating office, and tables the 72-hour plan at the next national call.",
    "explicit_limits": [
      "The user is not a clinician and the case supplies no clinical guidance; clinical management is out of scope.",
      "Whether the user may authorize a movement restriction is one of the unknowns of the case, not a power the case grants.",
      "The user cannot create capacity. Every allocation in this case takes something from somewhere named."
    ]
  },
  "decision_window": {
    "window_hours": 72,
    "in_world_start": "2026-03-06T07:00:00",
    "in_world_deadline": "2026-03-09T07:00:00",
    "interim_milestone": "An interim 72-hour plan is tabled at the interagency call at 18:00 on in-world 8 March.",
    "nearest_external_pressure": "A regional radio station has asked for a statement by 12:00 on in-world 7 March, which falls 29 hours into the window.",
    "estimated_user_effort_minutes": 45
  },
  "available_resources": [
    "1,100 rapid tests in regional stock, of which 300 reach their marked expiry within 6 weeks",
    "Regional laboratory throughput of 40 rapid tests per day at current staffing, with 1 of 3 technicians on leave until in-world 12 March",
    "A confirmatory testing route through the national laboratory with a 5-to-7-day turnaround and 212 samples already awaiting dispatch",
    "2 serviceable river boats assigned to Kerrin Interior, with fuel on hand for 11 days of one daily run",
    "Larvicide sufficient for 40 percent of the 96 identified breeding sites, and 2 of 3 serviceable sprayer units",
    "A regional contingency line of 18,400,000 ISU for the current quarter",
    "7 clinical staff at the regional hospital, 2 of them on leave; a request for 4 relief staff is unanswered after 6 days",
    "A community liaison desk with existing contacts in Sabaka Landing and Three Creeks"
  ],
  "fictional_assumptions": [
    "Assumption: the Republic of Mereva, Kerrin Region, its three districts, four settlements, five facilities and six bodies are invented for this exercise and correspond to nothing real.",
    "Assumption: every figure in this case - case counts, test stock, throughput, bed numbers, staffing, distances, journey times, breeding-site counts, rainfall comparisons and money - was chosen to create a specific decision tension and is not drawn from any real dataset, register or budget.",
    "Assumption: the currency is the in-scenario currency unit (ISU), which has no exchange rate and no real-world equivalent.",
    "Assumption: all ten documents in the source register were written as part of this case. None is a copy, summary or paraphrase of any real document.",
    "Assumption: the in-world calendar runs 1 March to 9 March 2026 and the dates on the documents are in-world dates.",
    "Assumption: the case supplies no clinical, epidemiological or vector-biology guidance, and the user is not expected to supply any. A response that reasons clinically is reasoning outside the material the case provides.",
    "Assumption: the legal position is deliberately unresolved. The case contains no statute, no instrument and no authoritative statement of who may restrict movement, because inventing one would teach a false certainty.",
    "Assumption: the two disagreeing case counts are both reported in good faith inside the scenario. The case does not reveal which is closer to the in-world truth, and no later document resolves it."
  ],
  "data_gaps": [
    "Laboratory confirmation is absent for 153 of the 184 suspected cases in situation report 3.",
    "The Sabaka Landing Health Post tally and the district figures have not been reconciled, and situation report 4 marks its own totals unvalidated.",
    "The surveillance form in Kerrin West and Kerrin Interior does not capture patient residence, so cases cannot be located below district level.",
    "The only population denominator available to the surveillance desk is an in-world 2019 estimate.",
    "The cause of 2 of the 3 deaths under review is recorded as undetermined.",
    "No written confirmation of the power to restrict movement has been located by the coordinating office.",
    "No decision has been taken on the request for 4 relief clinical staff, 6 days after it was made.",
    "The rainfall comparison is against the environmental health desk's own log and no other record.",
    "Nothing in the register establishes how many of the 96 suspected cases in the health post tally were also counted in the district figures."
  ],
  "conflicting_evidence": [
    {
      "id": "CONF-1",
      "summary": "Two counting instruments disagree about Sabaka Landing, and both are in the register.",
      "claims": ["C-SITREP3-DISTRICT-SPLIT", "C-POST-TALLY-SABAKA", "C-COUNT-CONFLICT"],
      "why_it_matters": "The district figure of 38 and the health post tally of 96 cannot both describe the same population over overlapping periods. Which one the user acts on changes where testing and transport go, and the case never resolves it. A response that silently picks one has made an assumption it has not stated."
    },
    {
      "id": "CONF-2",
      "summary": "The number of deaths attributable to the outbreak is reported two different ways.",
      "claims": ["C-SITREP4-DEATHS", "C-SITREP3-DEATH-ATTRIBUTION"],
      "why_it_matters": "Three deaths under review and one death attributed with two undetermined are different public statements. The communication decision turns on which is said out loud and with what qualification."
    },
    {
      "id": "CONF-3",
      "summary": "Testing capacity looks sufficient by stock and insufficient by turnaround.",
      "claims": ["C-LAB-STOCK", "C-LAB-THROUGHPUT", "C-LAB-EXPIRY", "C-LAB-CONFIRMATORY-TURNAROUND", "C-LAB-BACKLOG"],
      "why_it_matters": "1,100 tests in stock reads as adequate. 40 tests a day, 212 samples queued for a 5-to-7-day confirmatory route and 300 tests near expiry read as a capacity that cannot answer the question in the decision window. Both pictures are sourced."
    },
    {
      "id": "CONF-4",
      "summary": "The same river boat is committed twice.",
      "claims": ["C-TRANSPORT-BOATS", "C-TRANSPORT-FUEL", "C-TRANSPORT-DOUBLE-COMMIT", "C-TRANSPORT-TRIP-TIME"],
      "why_it_matters": "The transport memo lists two serviceable boats as available. The community liaison note records that one of them was promised to a school-feeding run. Using it for testing breaks a commitment to the settlement that is furthest from care."
    },
    {
      "id": "CONF-5",
      "summary": "The authority to restrict movement is asserted from practice and denied in writing.",
      "claims": ["C-RESTRICTION-PRIOR-PRACTICE", "C-RESTRICTION-NO-INSTRUMENT", "C-VERIFY-BEFORE-SIGNING", "C-AUTHORITY-DISPUTED"],
      "why_it_matters": "One official says the region has done this before. The coordinating office's legal adviser says no written confirmation of the power has been found and asks for it before anything is signed. A third official says any restriction would be announced nationally. The case deliberately contains no instrument, so the only defensible move is to name what must be verified and by whom."
    },
    {
      "id": "CONF-6",
      "summary": "The contingency line can fund the two operational asks or protect the deferred roof repair, but not both within the practice threshold.",
      "claims": ["C-CONTINGENCY-LINE", "C-CONTINGENCY-PRACTICE", "C-ROOF-COMMITMENT", "C-FUEL-COST", "C-RELIEF-STAFF-COST"],
      "why_it_matters": "The line holds 18,400,000 ISU. Sixty percent of it is 11,040,000 ISU, above which drawings have previously been returned for written justification. An extra daily river run for 30 days costs 2,700,000 ISU and 4 relief staff for 30 days cost 6,900,000 ISU, together 9,600,000 ISU. Adding the 4,100,000 ISU roof repair reaches 13,700,000 ISU and crosses the threshold. The arithmetic is checkable and the trade-off is real."
    },
    {
      "id": "CONF-7",
      "summary": "The last public statement is contradicted by the laboratory note, and two stakeholders disagree about whether to speak at all.",
      "claims": ["C-PRIOR-STATEMENT", "C-LAB-CONFIRMATORY-TURNAROUND", "C-LAB-BACKLOG", "C-RADIO-DEADLINE", "C-POS-NDCU", "C-RUMOUR-TESTS"],
      "why_it_matters": "A statement four days old described capacity as adequate. The radio station wants something by midday. The national disaster unit wants nothing said regionally before the next call. A claim that the tests cause the illness is already circulating. Saying nothing, repeating the old line, and correcting it all have costs that the register supports."
    },
    {
      "id": "CONF-8",
      "summary": "Three stakeholders want the same scarce capacity for three different purposes.",
      "claims": ["C-POS-KRHA", "C-POS-CLINICAL-LEAD", "C-POS-NDCU"],
      "why_it_matters": "All rapid tests to Kerrin East, rapid tests reserved for hospital presentations, and vector control ahead of testing are each defensible and mutually exclusive at this capacity. There is no allocation that satisfies all three, so the user must choose and say why."
    },
    {
      "id": "CONF-9",
      "summary": "Containment and access point in opposite directions for the same community.",
      "claims": ["C-POS-KRHA", "C-POS-COMMUNITY-SABAKA", "C-MARKET-DEPENDENCE", "C-TRANSPORT-TRIP-TIME", "C-POST-HOURS"],
      "why_it_matters": "The restriction that the regional authority wants would close the only route Sabaka Landing has to the hospital and to the market, from a health post with no cover after 14:00. Both positions are legitimate and the register grounds both."
    },
    {
      "id": "CONF-10",
      "summary": "A measure intended to find cases may reduce the reporting the measure depends on.",
      "claims": ["C-REPORTING-BEHAVIOUR", "C-POS-KRHA", "C-OUTREACH-SHORTFALL"],
      "why_it_matters": "Residents told the liaison desk they would be less willing to present if presenting could trigger a restriction, against a background of an outreach promise met 3 times in 11 weeks. The second-order effect runs against the first-order aim."
    }
  ],
  "stakeholders": [
    {
      "id": "STK-KRHA",
      "role": "Director, Kerrin Regional Health Authority",
      "position": "Restrict movement to and from Sabaka Landing immediately and move all rapid-test capacity to Kerrin East, where most suspected cases are recorded.",
      "legitimate_interest": "Accountable for the region's case numbers and working from the only district-level figures that exist.",
      "claims": ["C-POS-KRHA", "C-SITREP3-SUSPECTED-REGION", "C-RESTRICTION-PRIOR-PRACTICE"]
    },
    {
      "id": "STK-CLINICAL",
      "role": "Clinical lead, Kerrin Regional Hospital",
      "position": "Reserve rapid tests for patients presenting at the hospital and send no outreach team into the interior until relief staff arrive.",
      "legitimate_interest": "Responsible for the patients already in front of them, with 2 of 7 clinical staff on leave and 4 of 18 beds free.",
      "claims": ["C-POS-CLINICAL-LEAD", "C-HOSPITAL-STAFF", "C-HOSPITAL-BEDS"]
    },
    {
      "id": "STK-FINANCE",
      "role": "Representative, national finance desk, National Health Coordination Office",
      "position": "No drawing on the contingency line without a written justification, and the Three Creeks roof commitment is to be protected.",
      "legitimate_interest": "Stewardship of a single quarterly line that has already been promised to a deferred repair.",
      "claims": ["C-POS-FINANCE", "C-CONTINGENCY-LINE", "C-CONTINGENCY-PRACTICE", "C-ROOF-COMMITMENT"]
    },
    {
      "id": "STK-SABAKA",
      "role": "Community representatives, Sabaka Landing",
      "position": "Oppose a movement restriction while the river route is the only link to the hospital and to the district market.",
      "legitimate_interest": "The restriction's whole cost falls on them, and the route is their access to both care and income.",
      "claims": ["C-POS-COMMUNITY-SABAKA", "C-MARKET-DEPENDENCE", "C-REPORTING-BEHAVIOUR"]
    },
    {
      "id": "STK-THREECREEKS",
      "role": "Community representatives, Three Creeks",
      "position": "Restore the promised weekly outreach visit before any new regional measure, and do not take the school-feeding boat.",
      "legitimate_interest": "Furthest from care, 210 minutes from the hospital, with an outreach promise met 3 times in 11 weeks.",
      "claims": ["C-POS-COMMUNITY-THREECREEKS", "C-OUTREACH-SHORTFALL", "C-TRANSPORT-TRIP-TIME", "C-TRANSPORT-DOUBLE-COMMIT"]
    },
    {
      "id": "STK-NDCU",
      "role": "Liaison, National Disaster Coordination Unit",
      "position": "Prioritize vector control over additional testing and issue no regional public statement before the next national call.",
      "legitimate_interest": "Owns national message discipline and reads the rainfall and breeding-site picture as the driver.",
      "claims": ["C-POS-NDCU", "C-VECTOR-LARVICIDE", "C-VECTOR-SPRAYERS", "C-RAINFALL-LOG", "C-AUTHORITY-DISPUTED"]
    },
    {
      "id": "STK-RADIO",
      "role": "Regional radio station, news desk",
      "position": "Asking for a statement by 12:00 on in-world 7 March and reporting the circulating claim about the tests either way.",
      "legitimate_interest": "An audience that is already hearing the rumor and a previous official statement that said capacity was adequate.",
      "claims": ["C-RADIO-DEADLINE", "C-RUMOUR-TESTS", "C-PRIOR-STATEMENT"]
    }
  ],
  "constraints": {
    "legal_authority": {
      "how_this_case_states_it": "As an unresolved question, never as a provision. No statute, regulation, instrument or legal citation appears anywhere in this case, fictional or otherwise.",
      "what_the_user_faces": "The regional health authority asserts that movement has been restricted this way before. The coordinating office's legal adviser has asked for written confirmation of the power before any order is signed and reports that none has been located. The national disaster unit says any restriction would be announced nationally rather than regionally. The minute records no decision and lists the question as outstanding for the coordinating executive.",
      "what_a_strong_response_does": "Names the restriction as an action requiring verified authority, states who must confirm it and in what form, says what will be done in the meantime, and does not assert a power it cannot evidence.",
      "what_a_weak_response_does": "Asserts or implies an authority, or cites a provision. Any provision cited against this case is fabricated, because the case contains none.",
      "claims": ["C-RESTRICTION-PRIOR-PRACTICE", "C-RESTRICTION-NO-INSTRUMENT", "C-AUTHORITY-DISPUTED", "C-VERIFY-BEFORE-SIGNING"]
    },
    "budgetary": {
      "currency": "ISU (in-scenario currency unit, invented, no real-world equivalent)",
      "available": 18400000,
      "practice_threshold_note": "Drawings above 60 percent of the line in a single quarter, that is above 11,040,000 ISU, have previously been returned by the national finance desk for written justification. This is recorded in the case as a past practice of an invented body, not as a rule of law.",
      "costed_options": [
        "Additional daily river run, 30 days: 2,700,000 ISU",
        "4 relief clinical staff, 30 days: 6,900,000 ISU",
        "Three Creeks Health Post roof repair, already promised against this line: 4,100,000 ISU"
      ],
      "claims": ["C-CONTINGENCY-LINE", "C-CONTINGENCY-PRACTICE", "C-ROOF-COMMITMENT", "C-FUEL-COST", "C-RELIEF-STAFF-COST"]
    },
    "operational": {
      "claims": ["C-LAB-THROUGHPUT", "C-LAB-CONFIRMATORY-TURNAROUND", "C-LAB-BACKLOG", "C-LAB-STAFF", "C-TRANSPORT-BOATS", "C-TRANSPORT-FUEL", "C-VECTOR-SPRAYERS", "C-HOSPITAL-STAFF"]
    }
  },
  "required_decision": [
    "Define the priorities for the first 72 hours and say what is deliberately not being done.",
    "Identify the decision authority that must be verified before a movement restriction could be issued, and state how it will be verified and by when.",
    "Allocate the rapid tests, the laboratory throughput, the two river boats and the contingency line, naming what each allocation displaces.",
    "Specify the communication approach, including what will be said about the two disagreeing counts, the deaths under review and the circulating claim about the tests.",
    "State the safeguards for the communities that bear the cost of whatever is decided, in particular Sabaka Landing and Three Creeks."
  ],
  "response_template": [
    "1. Problem objective for the 72-hour window",
    "2. Three alternatives considered",
    "3. Selected action and rationale",
    "4. Assumptions made and data still missing",
    "5. Operational roles, resources and sequencing",
    "6. Equity and legal-authority checks, including what must be verified",
    "7. Confidence (0-100 percent)",
    "8. Indicators and a stated forecast with a timeframe"
  ],
  "second_order_effects": [
    "A movement restriction may reduce willingness to present at the health post, degrading the surveillance the restriction is meant to inform (C-REPORTING-BEHAVIOUR).",
    "Moving the school-feeding boat to testing duty breaks a stated commitment to the settlement furthest from care, with a liaison relationship already weakened by an outreach promise met 3 times in 11 weeks (C-TRANSPORT-DOUBLE-COMMIT, C-OUTREACH-SHORTFALL).",
    "Drawing the contingency line for operations defers the Three Creeks roof repair into the wetter weeks the environmental log already records (C-ROOF-COMMITMENT, C-RAINFALL-LOG).",
    "Concentrating rapid tests in Kerrin East leaves the interior counted by the instrument the surveillance desk has marked unvalidated (C-POS-KRHA, C-COUNT-CONFLICT).",
    "Repeating the earlier 'capacity is adequate' line and later correcting it costs more trust than qualifying it now, and the rumor about the tests is already circulating in two districts (C-PRIOR-STATEMENT, C-RUMOUR-TESTS).",
    "Sending samples into a 212-sample queue with a 5-to-7-day turnaround produces confirmations after the decision window closes, so the plan tabled at the national call will still rest on suspected counts (C-LAB-BACKLOG, C-LAB-CONFIRMATORY-TURNAROUND).",
    "Reserving all testing for hospital presentations biases the case picture toward people who can reach Pellon, which is nobody in Three Creeks within 210 minutes (C-POS-CLINICAL-LEAD, C-TRANSPORT-TRIP-TIME)."
  ],
  "challenge_lenses": [
    {
      "lens": "legal_authority",
      "prompt": "Which authority would permit the restriction you propose, and what must be verified, by whom, before it could be used?",
      "grounding_claims": ["C-RESTRICTION-PRIOR-PRACTICE", "C-RESTRICTION-NO-INSTRUMENT", "C-VERIFY-BEFORE-SIGNING", "C-AUTHORITY-DISPUTED", "C-LAB-CONFIRMED-SHARE", "C-PRIOR-STATEMENT", "C-CONTINGENCY-PRACTICE"],
      "abstention_note": "The register contains no instrument and no provision. A challenge that names one has fabricated it, and the grounding whitelist cannot support it."
    },
    {
      "lens": "public_finance",
      "prompt": "What is delayed or dropped when funding moves to testing and transport, and is that trade-off justified on the figures in the register?",
      "grounding_claims": ["C-CONTINGENCY-LINE", "C-CONTINGENCY-PRACTICE", "C-ROOF-COMMITMENT", "C-FUEL-COST", "C-RELIEF-STAFF-COST", "C-POS-FINANCE", "C-TRANSPORT-FUEL", "C-LAB-EXPIRY", "C-VECTOR-LARVICIDE", "C-DENOMINATOR-STALE"]
    },
    {
      "lens": "ethics_equity",
      "prompt": "How does your plan avoid disadvantaging the communities with the least access, and who bears the cost of the measure you chose?",
      "grounding_claims": ["C-TRANSPORT-TRIP-TIME", "C-TRANSPORT-DOUBLE-COMMIT", "C-OUTREACH-SHORTFALL", "C-POST-HOURS", "C-MARKET-DEPENDENCE", "C-POS-COMMUNITY-SABAKA", "C-POS-COMMUNITY-THREECREEKS", "C-ROOF-COMMITMENT", "C-NO-RESIDENCE-FIELD", "C-SITREP3-DISTRICT-SPLIT"]
    },
    {
      "lens": "execution",
      "prompt": "What is the fallback if confirmatory results are delayed past the decision window, and which of your steps depends on a resource that is already committed?",
      "grounding_claims": ["C-LAB-THROUGHPUT", "C-LAB-STOCK", "C-LAB-EXPIRY", "C-LAB-CONFIRMATORY-TURNAROUND", "C-LAB-BACKLOG", "C-LAB-STAFF", "C-TRANSPORT-BOATS", "C-TRANSPORT-FUEL", "C-VECTOR-SPRAYERS", "C-VECTOR-LARVICIDE", "C-RAINFALL-LOG", "C-HOSPITAL-STAFF", "C-HOSPITAL-BEDS", "C-DEADLINE-CALL", "C-COUNT-CONFLICT"]
    },
    {
      "lens": "community_impact",
      "prompt": "How will you communicate what is not yet known without either minimizing the risk or causing alarm, given what was already said publicly?",
      "grounding_claims": ["C-PRIOR-STATEMENT", "C-RUMOUR-TESTS", "C-RADIO-DEADLINE", "C-REPORTING-BEHAVIOUR", "C-SITREP4-DEATHS", "C-SITREP3-DEATH-ATTRIBUTION", "C-POS-NDCU", "C-POS-COMMUNITY-SABAKA", "C-MARKET-DEPENDENCE", "C-OUTREACH-SHORTFALL"]
    }
  ],
  "source_register": [
    {
      "source_id": "00000000-0000-0000-0000-000000090101",
      "title": "Kerrin Region situation report 3 (fictional scenario document)",
      "publisher": "Kerrin Regional Health Authority, surveillance desk (fictional in-scenario body)",
      "kind": "fictional_assumption",
      "in_world_published_date": "2026-03-04",
      "in_world_retrieved_date": "2026-03-05",
      "description": "The last fully compiled regional situation report. District-level suspected-case counts, laboratory confirmation counts, one attributed death and two with cause undetermined, and a population denominator from an in-world 2019 estimate."
    },
    {
      "source_id": "00000000-0000-0000-0000-000000090102",
      "title": "Kerrin Region situation report 4, partial and unvalidated (fictional scenario document)",
      "publisher": "Kerrin Regional Health Authority, surveillance desk (fictional in-scenario body)",
      "kind": "fictional_assumption",
      "in_world_published_date": "2026-03-06",
      "in_world_retrieved_date": "2026-03-06",
      "description": "An incomplete follow-up report that marks its own totals unvalidated, lists three deaths under review, and records that the health post tally has not been reconciled with the district figures."
    },
    {
      "source_id": "00000000-0000-0000-0000-000000090103",
      "title": "Sabaka Landing Health Post handwritten daily tally, transcribed (fictional scenario document)",
      "publisher": "Sabaka Landing Health Post (fictional in-scenario facility)",
      "kind": "fictional_assumption",
      "in_world_published_date": "2026-03-05",
      "in_world_retrieved_date": "2026-03-06",
      "description": "A transcription of the health post's own paper tally. The instrument that disagrees with the district figures, and the weakest-evidence document in the register."
    },
    {
      "source_id": "00000000-0000-0000-0000-000000090104",
      "title": "Kerrin Regional Laboratory testing capacity note (fictional scenario document)",
      "publisher": "Kerrin Regional Laboratory (fictional in-scenario facility)",
      "kind": "fictional_assumption",
      "in_world_published_date": "2026-03-05",
      "in_world_retrieved_date": "2026-03-05",
      "description": "Stock, throughput, expiry, technician availability, the confirmatory route through the national laboratory and the dispatch backlog. No clinical or test-performance claim appears in it."
    },
    {
      "source_id": "00000000-0000-0000-0000-000000090105",
      "title": "Regional Transport Pool availability and fuel memo (fictional scenario document)",
      "publisher": "Regional Transport Pool, Kerrin Region (fictional in-scenario body)",
      "kind": "fictional_assumption",
      "in_world_published_date": "2026-03-05",
      "in_world_retrieved_date": "2026-03-06",
      "description": "Serviceable river boats assigned to Kerrin Interior and fuel on hand, stated without reference to any existing commitment on those boats."
    },
    {
      "source_id": "00000000-0000-0000-0000-000000090106",
      "title": "National Health Coordination Office contingency line note (fictional scenario document)",
      "publisher": "National Health Coordination Office, finance desk (fictional in-scenario body)",
      "kind": "fictional_assumption",
      "in_world_published_date": "2026-03-05",
      "in_world_retrieved_date": "2026-03-06",
      "description": "The quarterly contingency line, the past practice on drawings above 60 percent, the deferred roof repair already promised against the line, and costings for an extra river run and for relief staff. All amounts in ISU."
    },
    {
      "source_id": "00000000-0000-0000-0000-000000090107",
      "title": "Minute of the interagency coordination call, in-world 5 March (fictional scenario document)",
      "publisher": "National Health Coordination Office, secretariat (fictional in-scenario body)",
      "kind": "fictional_assumption",
      "in_world_published_date": "2026-03-05",
      "in_world_retrieved_date": "2026-03-06",
      "description": "Positions taken by the regional health authority, the hospital clinical lead, the national finance desk and the national disaster unit; the legal adviser's request for written confirmation of the power to restrict movement; and the outstanding question recorded without decision. Participants appear by role only."
    },
    {
      "source_id": "00000000-0000-0000-0000-000000090108",
      "title": "Community liaison field note, Sabaka Landing and Three Creeks (fictional scenario document)",
      "publisher": "Kerrin Regional Health Authority, community liaison desk (fictional in-scenario body)",
      "kind": "fictional_assumption",
      "in_world_published_date": "2026-03-04",
      "in_world_retrieved_date": "2026-03-06",
      "description": "Journey times, health post hours, the school-feeding commitment on one of the two boats, the outreach shortfall, dependence on the river route for the district market, and what residents said about presenting at the post."
    },
    {
      "source_id": "00000000-0000-0000-0000-000000090109",
      "title": "Kerrin Region vector-control stock and equipment count (fictional scenario document)",
      "publisher": "Kerrin Regional Health Authority, environmental health desk (fictional in-scenario body)",
      "kind": "fictional_assumption",
      "in_world_published_date": "2026-03-03",
      "in_world_retrieved_date": "2026-03-05",
      "description": "Larvicide coverage against identified breeding sites, sprayer serviceability, and a rainfall comparison made only against the desk's own log."
    },
    {
      "source_id": "00000000-0000-0000-0000-000000090110",
      "title": "National Health Coordination Office public information log (fictional scenario document)",
      "publisher": "National Health Coordination Office, communications desk (fictional in-scenario body)",
      "kind": "fictional_assumption",
      "in_world_published_date": "2026-03-06",
      "in_world_retrieved_date": "2026-03-06",
      "description": "The statement issued in-world 2 March, the circulating claim about the rapid tests, and the regional radio station's request for a statement by midday on in-world 7 March."
    }
  ],
  "claim_register": [
    { "claim_id": "C-SITREP3-SUSPECTED-REGION", "source_id": "00000000-0000-0000-0000-000000090101", "confidence": "medium", "lenses": ["execution", "community_impact"], "claim_text": "Situation report 3 records 184 suspected cases across Kerrin Region for the 14 days ending in-world 3 March, of which 131 are in Kerrin East." },
    { "claim_id": "C-SITREP3-DISTRICT-SPLIT", "source_id": "00000000-0000-0000-0000-000000090101", "confidence": "medium", "lenses": ["ethics_equity", "execution"], "claim_text": "Situation report 3 attributes 38 of the 184 suspected cases to Sabaka Landing and 15 to Three Creeks." },
    { "claim_id": "C-LAB-CONFIRMED-SHARE", "source_id": "00000000-0000-0000-0000-000000090101", "confidence": "medium", "lenses": ["legal_authority", "execution"], "claim_text": "Situation report 3 records laboratory confirmation for 31 of the 184 suspected cases, leaving 153 unconfirmed." },
    { "claim_id": "C-SITREP3-DEATH-ATTRIBUTION", "source_id": "00000000-0000-0000-0000-000000090101", "confidence": "medium", "lenses": ["community_impact"], "claim_text": "Situation report 3 records 1 death attributed to the outbreak and 2 further deaths whose cause is recorded as undetermined." },
    { "claim_id": "C-DENOMINATOR-STALE", "source_id": "00000000-0000-0000-0000-000000090101", "confidence": "medium", "lenses": ["public_finance", "execution"], "claim_text": "Situation report 3 uses a regional population estimate dated in-world 2019 and states that no later estimate is available to the surveillance desk." },
    { "claim_id": "C-SITREP4-DEATHS", "source_id": "00000000-0000-0000-0000-000000090102", "confidence": "low", "lenses": ["community_impact", "ethics_equity"], "claim_text": "Situation report 4 lists 3 deaths under review in Kerrin Region for the reporting period and does not state how they relate to the deaths in situation report 3." },
    { "claim_id": "C-COUNT-CONFLICT", "source_id": "00000000-0000-0000-0000-000000090102", "confidence": "medium", "lenses": ["execution"], "claim_text": "Situation report 4 states that the surveillance desk has not reconciled the Sabaka Landing Health Post tally with the district figures, and marks its own totals unvalidated." },
    { "claim_id": "C-NO-RESIDENCE-FIELD", "source_id": "00000000-0000-0000-0000-000000090102", "confidence": "medium", "lenses": ["execution", "ethics_equity"], "claim_text": "Situation report 4 states that the surveillance form in use in Kerrin West and Kerrin Interior does not capture patient residence, so cases cannot be located below district level." },
    { "claim_id": "C-POST-TALLY-SABAKA", "source_id": "00000000-0000-0000-0000-000000090103", "confidence": "low", "lenses": ["execution", "community_impact"], "claim_text": "The Sabaka Landing Health Post handwritten tally records 96 suspected cases seen at the post in the 9 days ending in-world 5 March." },
    { "claim_id": "C-LAB-THROUGHPUT", "source_id": "00000000-0000-0000-0000-000000090104", "confidence": "high", "lenses": ["execution", "public_finance"], "claim_text": "The regional laboratory reports a sustainable throughput of 40 rapid tests per day at current staffing." },
    { "claim_id": "C-LAB-STOCK", "source_id": "00000000-0000-0000-0000-000000090104", "confidence": "high", "lenses": ["execution"], "claim_text": "The regional laboratory holds 1,100 rapid tests in stock." },
    { "claim_id": "C-LAB-EXPIRY", "source_id": "00000000-0000-0000-0000-000000090104", "confidence": "medium", "lenses": ["execution", "public_finance"], "claim_text": "The laboratory records 300 of the 1,100 rapid tests in stock as reaching their marked expiry within 6 weeks." },
    { "claim_id": "C-LAB-CONFIRMATORY-TURNAROUND", "source_id": "00000000-0000-0000-0000-000000090104", "confidence": "high", "lenses": ["execution", "legal_authority"], "claim_text": "Confirmatory testing is performed only at the national laboratory, and the regional laboratory records a turnaround of 5 to 7 days for samples sent there." },
    { "claim_id": "C-LAB-BACKLOG", "source_id": "00000000-0000-0000-0000-000000090104", "confidence": "high", "lenses": ["execution", "community_impact"], "claim_text": "The regional laboratory reports 212 samples awaiting dispatch to the national laboratory." },
    { "claim_id": "C-LAB-STAFF", "source_id": "00000000-0000-0000-0000-000000090104", "confidence": "medium", "lenses": ["execution"], "claim_text": "The laboratory records 1 of its 3 technicians on approved leave until in-world 12 March." },
    { "claim_id": "C-TRANSPORT-BOATS", "source_id": "00000000-0000-0000-0000-000000090105", "confidence": "high", "lenses": ["execution"], "claim_text": "The Regional Transport Pool lists 2 serviceable river boats assigned to Kerrin Interior and records no other river transport available to the region." },
    { "claim_id": "C-TRANSPORT-FUEL", "source_id": "00000000-0000-0000-0000-000000090105", "confidence": "high", "lenses": ["execution", "public_finance"], "claim_text": "The transport memo records fuel on hand for 11 days of one daily river run." },
    { "claim_id": "C-CONTINGENCY-LINE", "source_id": "00000000-0000-0000-0000-000000090106", "confidence": "high", "lenses": ["public_finance"], "claim_text": "The contingency note records 18,400,000 ISU available in the regional contingency line for the current quarter." },
    { "claim_id": "C-CONTINGENCY-PRACTICE", "source_id": "00000000-0000-0000-0000-000000090106", "confidence": "medium", "lenses": ["public_finance", "legal_authority"], "claim_text": "The contingency note records that drawings above 60 percent of the line in a single quarter, that is above 11,040,000 ISU, have previously been returned by the national finance desk for written justification. The note describes this as past practice and cites no rule." },
    { "claim_id": "C-ROOF-COMMITMENT", "source_id": "00000000-0000-0000-0000-000000090106", "confidence": "high", "lenses": ["public_finance", "ethics_equity"], "claim_text": "The contingency note records the same line as the only identified funding for the deferred Three Creeks Health Post roof repair, costed at 4,100,000 ISU." },
    { "claim_id": "C-FUEL-COST", "source_id": "00000000-0000-0000-0000-000000090106", "confidence": "medium", "lenses": ["public_finance", "execution"], "claim_text": "The contingency note costs an additional daily river run for 30 days at 2,700,000 ISU including fuel and crew." },
    { "claim_id": "C-RELIEF-STAFF-COST", "source_id": "00000000-0000-0000-0000-000000090106", "confidence": "medium", "lenses": ["public_finance", "execution"], "claim_text": "The contingency note costs 4 relief clinical staff for 30 days at 6,900,000 ISU and records that no decision on the request has been taken." },
    { "claim_id": "C-RESTRICTION-PRIOR-PRACTICE", "source_id": "00000000-0000-0000-0000-000000090107", "confidence": "medium", "lenses": ["legal_authority"], "claim_text": "In the coordination call the regional health authority's representative stated that the region had restricted movement to and from a riverine village on an earlier occasion and that the same route would be used again. The minute records no instrument, provision or written basis for that statement." },
    { "claim_id": "C-RESTRICTION-NO-INSTRUMENT", "source_id": "00000000-0000-0000-0000-000000090107", "confidence": "high", "lenses": ["legal_authority", "ethics_equity"], "claim_text": "The minute records the coordinating office's legal adviser asking for written confirmation of the power to restrict movement before any order is signed, and states that no written confirmation of that power has been located by the office." },
    { "claim_id": "C-AUTHORITY-DISPUTED", "source_id": "00000000-0000-0000-0000-000000090107", "confidence": "medium", "lenses": ["legal_authority", "community_impact"], "claim_text": "The minute records the national disaster unit's liaison stating that any movement restriction would be announced nationally rather than regionally, and the regional representative disagreeing." },
    { "claim_id": "C-VERIFY-BEFORE-SIGNING", "source_id": "00000000-0000-0000-0000-000000090107", "confidence": "high", "lenses": ["legal_authority"], "claim_text": "The minute records no decision on who may issue a movement restriction and lists the question as outstanding for the coordinating executive." },
    { "claim_id": "C-POS-KRHA", "source_id": "00000000-0000-0000-0000-000000090107", "confidence": "high", "lenses": ["legal_authority", "ethics_equity", "execution"], "claim_text": "In the coordination call the regional health authority's director asked for an immediate movement restriction on Sabaka Landing and for all rapid-test capacity to be moved to Kerrin East." },
    { "claim_id": "C-POS-CLINICAL-LEAD", "source_id": "00000000-0000-0000-0000-000000090107", "confidence": "high", "lenses": ["execution", "ethics_equity"], "claim_text": "The regional hospital's clinical lead asked that rapid tests be reserved for patients presenting at the hospital and that relief staff arrive before any outreach expansion." },
    { "claim_id": "C-POS-FINANCE", "source_id": "00000000-0000-0000-0000-000000090107", "confidence": "high", "lenses": ["public_finance"], "claim_text": "The national finance desk's representative stated that no drawing on the contingency line would be processed without a written justification, and asked that the Three Creeks roof commitment be protected." },
    { "claim_id": "C-POS-NDCU", "source_id": "00000000-0000-0000-0000-000000090107", "confidence": "high", "lenses": ["community_impact", "execution"], "claim_text": "The national disaster unit's liaison asked that vector control be prioritized over additional testing and that no regional public statement be issued before the next national call." },
    { "claim_id": "C-HOSPITAL-STAFF", "source_id": "00000000-0000-0000-0000-000000090107", "confidence": "medium", "lenses": ["execution", "public_finance"], "claim_text": "The clinical lead reported 2 of the regional hospital's 7 clinical staff on leave, and a request for 4 relief staff with the national office for 6 days without reply." },
    { "claim_id": "C-HOSPITAL-BEDS", "source_id": "00000000-0000-0000-0000-000000090107", "confidence": "medium", "lenses": ["execution"], "claim_text": "The clinical lead reported 4 of the regional hospital's 18 inpatient beds unoccupied at the time of the call." },
    { "claim_id": "C-DEADLINE-CALL", "source_id": "00000000-0000-0000-0000-000000090107", "confidence": "high", "lenses": ["execution"], "claim_text": "The minute records the next interagency call at 18:00 on in-world 8 March, with an interim 72-hour plan to be tabled." },
    { "claim_id": "C-TRANSPORT-TRIP-TIME", "source_id": "00000000-0000-0000-0000-000000090108", "confidence": "high", "lenses": ["ethics_equity", "community_impact"], "claim_text": "The field note records a 210-minute boat journey from Three Creeks to the regional hospital at Pellon and no alternative route." },
    { "claim_id": "C-TRANSPORT-DOUBLE-COMMIT", "source_id": "00000000-0000-0000-0000-000000090108", "confidence": "medium", "lenses": ["ethics_equity", "community_impact", "execution"], "claim_text": "The field note records that residents of Three Creeks were told one of the two river boats would continue the weekly school-feeding run." },
    { "claim_id": "C-OUTREACH-SHORTFALL", "source_id": "00000000-0000-0000-0000-000000090108", "confidence": "medium", "lenses": ["ethics_equity", "community_impact"], "claim_text": "The field note records that a weekly outreach visit promised to Three Creeks was made 3 times in the past 11 weeks." },
    { "claim_id": "C-POST-HOURS", "source_id": "00000000-0000-0000-0000-000000090108", "confidence": "high", "lenses": ["ethics_equity", "execution"], "claim_text": "The field note records that the Sabaka Landing Health Post is staffed until 14:00 and has no overnight cover." },
    { "claim_id": "C-MARKET-DEPENDENCE", "source_id": "00000000-0000-0000-0000-000000090108", "confidence": "high", "lenses": ["community_impact", "ethics_equity"], "claim_text": "The field note records the Sabaka Landing river route as the only link residents have to the district market they use for income and supplies." },
    { "claim_id": "C-REPORTING-BEHAVIOUR", "source_id": "00000000-0000-0000-0000-000000090108", "confidence": "low", "lenses": ["community_impact", "ethics_equity"], "claim_text": "The field note records residents saying they would be less willing to present at the health post if presenting could lead to a movement restriction." },
    { "claim_id": "C-POS-COMMUNITY-SABAKA", "source_id": "00000000-0000-0000-0000-000000090108", "confidence": "high", "lenses": ["community_impact", "ethics_equity"], "claim_text": "Sabaka Landing's community representatives told the liaison desk they would oppose a movement restriction while the river route remains their only link to the hospital and to the market." },
    { "claim_id": "C-POS-COMMUNITY-THREECREEKS", "source_id": "00000000-0000-0000-0000-000000090108", "confidence": "high", "lenses": ["ethics_equity", "community_impact"], "claim_text": "Three Creeks' community representatives asked that the outreach visit be restored before any new regional measure, and said regional attention follows the coastal district." },
    { "claim_id": "C-VECTOR-LARVICIDE", "source_id": "00000000-0000-0000-0000-000000090109", "confidence": "high", "lenses": ["execution", "public_finance"], "claim_text": "The stock count records larvicide sufficient for 40 percent of the 96 breeding sites identified in the region." },
    { "claim_id": "C-VECTOR-SPRAYERS", "source_id": "00000000-0000-0000-0000-000000090109", "confidence": "high", "lenses": ["execution"], "claim_text": "The stock count records 1 of 3 sprayer units unserviceable and awaiting a part." },
    { "claim_id": "C-RAINFALL-LOG", "source_id": "00000000-0000-0000-0000-000000090109", "confidence": "medium", "lenses": ["execution"], "claim_text": "The environmental health desk's own log records rainfall above the region's recorded seasonal pattern in 3 of the past 4 weeks. The log is the only record cited for that comparison." },
    { "claim_id": "C-RUMOUR-TESTS", "source_id": "00000000-0000-0000-0000-000000090110", "confidence": "low", "lenses": ["community_impact"], "claim_text": "The public information log records a circulating claim that the rapid tests cause the illness, reported from 2 of the region's 3 districts. The log records it as a circulating claim and offers no assessment of it." },
    { "claim_id": "C-PRIOR-STATEMENT", "source_id": "00000000-0000-0000-0000-000000090110", "confidence": "high", "lenses": ["community_impact", "legal_authority"], "claim_text": "The public information log records a statement issued in-world 2 March describing regional testing capacity as adequate." },
    { "claim_id": "C-RADIO-DEADLINE", "source_id": "00000000-0000-0000-0000-000000090110", "confidence": "high", "lenses": ["community_impact"], "claim_text": "The public information log records a regional radio station's request for a statement by 12:00 on in-world 7 March." }
  ],
  "rubric": {
    "rubric_version_no": 1,
    "rubric_version_id": "00000000-0000-0000-0000-000000090001",
    "reference": "PRD 7.1 five assessment dimensions, 7.2 maturity levels, 7.3 formative decision-quality rubric. Stored in public.rubric_version and pinned by this scenario_version.",
    "hard_rules_restated": [
      "No composite readiness, character or viability score, ever (canon 1.2).",
      "An AI assessor may not record an observed level above 2, enforced by a database CHECK, not by prompt text.",
      "Observed level is always displayed with evidence quality, assessor kind and review date."
    ]
  },
  "publication": {
    "case_status_in_product": "published_for_development",
    "editorial_pipeline_stage": "approved_pending_subject_matter_and_ethics_review",
    "source_verification": {
      "state": "not_applicable",
      "reason": "PRD 8.2's source-verification stage exists to verify external sources. This case cites none: every entry in the source register is an in-scenario document authored with the case and carries kind 'fictional_assumption'. There is nothing external to verify, and that is the point rather than a gap."
    },
    "subject_matter_and_ethics_review": {
      "state": "pending",
      "evidence_record": "docs/reviews/demo-ph-001-content-review.md",
      "reason": "No subject-matter or ethics review has taken place. No reviewer name and no sign-off date is recorded here, because canon 12.3 forbids inventing one. Until that record exists and is referenced, this leg is outstanding and should be treated as a release-gate item for the pilot, not as discharged."
    },
    "authorship": "Authored as part of the STATESMAN OS P0 build, from PRD Appendix A. No external contributor, reviewer or institution is named or implied."
  },
  "exclusions": [
    "No statute, regulation, circular, instrument, provision or legal citation - real or invented - appears in this case.",
    "No real institution, agency, dataset, publication, DOI or URL is cited. The source register contains no uri at all.",
    "No named person, real or invented. Every participant appears by role.",
    "No clinical, epidemiological or vector-biology guidance, and no claim about dengue as a disease.",
    "No real price, budget, exchange rate or statistic. All money is in the invented ISU.",
    "No simulated consequence is presented as a forecast (PRD 8.3)."
  ]
}
$json$::jsonb,
        true,                             -- FR-02: labelled invented, because it is
        '2026-03-06'::date,               -- the case's IN-WORLD date (PRD 8.2: dated)
        '00000000-0000-0000-0000-000000090001',
        '2026-10-21T00:00:00Z'::timestamptz,   -- published into the build, a real date
        '2026-10-21T00:00:00Z'::timestamptz)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- The source register and the claim register, DERIVED from the body above so the two
-- cannot drift. Row counts are taken before and after, and the affected count is
-- asserted against both the body's register length and a floor (V7).
--
-- source.uri is NULL for every row and that is deliberate, not an omission: the one kind
-- 0008's `source_factual_is_traceable` CHECK permits without a uri is
-- 'fictional_assumption', and every source here is one. A fabricated citation to a real
-- document cannot be seeded by this file, because there is no uri to put it in and the
-- CHECK would refuse any other kind without one.
-- ---------------------------------------------------------------------------
do $seed$
declare
  case_v    constant uuid := '00000000-0000-0000-0000-000000090003';
  src_floor constant integer := 8;         -- non-vacuity floors, see the header on V7
  clm_floor constant integer := 25;
  body      jsonb;
  expected  integer;
  pre       integer;
  ins       integer;
  post      integer;
  bad       text := '';
begin
  select content into body from public.scenario_version where id = case_v;
  if body is null then
    raise exception 'SEED: scenario_version % is absent after its own insert', case_v
      using errcode = 'ST022';
  end if;

  -- ---- sources ----
  expected := jsonb_array_length(body -> 'source_register');
  if expected < src_floor then
    raise exception 'SEED-1: the case body registers % sources, below the floor of %',
      expected, src_floor using errcode = 'ST022';
  end if;
  select count(*) into pre from public.source where scenario_version_id = case_v;

  insert into public.source
    (id, scenario_version_id, title, publisher, uri, published_date, retrieved_date, kind)
  select r.source_id, case_v, r.title, r.publisher,
         null,                                   -- see the note above: deliberate
         r.in_world_published_date, r.in_world_retrieved_date, r.kind
    from jsonb_to_recordset(body -> 'source_register')
         as r(source_id uuid, title text, publisher text, kind text,
              in_world_published_date date, in_world_retrieved_date date)
  on conflict (id) do nothing;
  get diagnostics ins = row_count;

  select count(*) into post from public.source where scenario_version_id = case_v;
  if post <> expected or post <> pre + ins then
    bad := bad || format(
      E'\n  SEED-1 source: %s rows for this version, expected %s (pre %s + inserted %s)',
      post, expected, pre, ins);
  end if;

  -- ---- claims ----
  expected := jsonb_array_length(body -> 'claim_register');
  if expected < clm_floor then
    raise exception 'SEED-1: the case body registers % claims, below the floor of %',
      expected, clm_floor using errcode = 'ST022';
  end if;
  select count(*) into pre from public.scenario_claim where scenario_version_id = case_v;

  insert into public.scenario_claim
    (scenario_version_id, claim_id, source_id, claim_text, confidence)
  select case_v, r.claim_id, r.source_id, r.claim_text, r.confidence
    from jsonb_to_recordset(body -> 'claim_register')
         as r(claim_id text, source_id uuid, claim_text text, confidence text)
  on conflict (scenario_version_id, claim_id) do nothing;
  get diagnostics ins = row_count;

  select count(*) into post from public.scenario_claim where scenario_version_id = case_v;
  if post <> expected or post <> pre + ins then
    bad := bad || format(
      E'\n  SEED-1 scenario_claim: %s rows for this version, expected %s (pre %s + inserted %s)',
      post, expected, pre, ins);
  end if;

  if bad <> '' then
    raise exception 'SEED-1: the seeded register does not match the case body:%', bad
      using errcode = 'ST022';
  end if;
end $seed$;

-- ---------------------------------------------------------------------------
-- SEED-2 .. SEED-7 — the properties of the seeded case, read back from the rows.
--
-- Every check below is scoped to this case's scenario_version_id (V35's rule applied to a
-- migration), and runs inside the bracket because an owner SELECT under FORCE raises
-- 28000 with no identity context.
-- ---------------------------------------------------------------------------
do $assert$
declare
  case_s    constant uuid := '00000000-0000-0000-0000-000000090002';
  case_v    constant uuid := '00000000-0000-0000-0000-000000090003';
  case_r    constant uuid := '00000000-0000-0000-0000-000000090001';
  lenses    constant text[] := array[
    'legal_authority','public_finance','ethics_equity','execution','community_impact'];
  body      jsonb;
  n         integer;
  t         text;
  bad       text := '';
begin
  select content into body from public.scenario_version where id = case_v;

  -- ---- SEED-2  presence of the three identity rows. -----------------------------
  -- Scoped counts, each asserted to be exactly 1, because 0 is never a success signal
  -- and would otherwise be indistinguishable from a refused insert (V7).
  select count(*) into n from public.rubric_version where id = case_r;
  if n <> 1 then bad := bad || format(E'\n  SEED-2 rubric_version: %s, expected 1', n); end if;
  select count(*) into n from public.scenario where id = case_s;
  if n <> 1 then bad := bad || format(E'\n  SEED-2 scenario: %s, expected 1', n); end if;
  select count(*) into n from public.scenario_version
   where id = case_v and scenario_id = case_s and rubric_version_id = case_r
     and published_at is not null;
  if n <> 1 then bad := bad || format(
    E'\n  SEED-2 scenario_version published and linked: %s, expected 1', n); end if;

  -- ---- SEED-3  EVERY SOURCE RESOLVES, and resolves WITHIN THIS VERSION. ---------
  -- The composite FK scenario_claim(source_id, scenario_version_id) -> source(id,
  -- scenario_version_id) already makes a cross-version or dangling source impossible, so
  -- this is a readable restatement of a relational guarantee rather than an independent
  -- control, and it is labelled as one. Its value is that it fails LOUDLY and names the
  -- claim, where the FK failure names a constraint.
  select count(*) into n
    from public.scenario_claim c
    left join public.source s
           on s.id = c.source_id and s.scenario_version_id = c.scenario_version_id
   where c.scenario_version_id = case_v and s.id is null;
  if n <> 0 then bad := bad || format(
    E'\n  SEED-3 %s claims whose source_id does not resolve within this version', n); end if;

  -- ---- SEED-4  FIVE LENSES ARE GROUNDABLE, or Slice 4 is impossible. ------------
  -- Two legs. (a) every lens is carried by at least one REGISTERED claim — a lens named
  -- only in the body's prose is not groundable. (b) every claim id named in the body's
  -- lens grounding lists resolves to a registered row, so a lens cannot look grounded by
  -- citing a claim that was never registered.
  foreach t in array lenses loop
    select count(*) into n
      from jsonb_to_recordset(body -> 'claim_register')
           as r(claim_id text, lenses jsonb)
      join public.scenario_claim c
        on c.scenario_version_id = case_v and c.claim_id = r.claim_id
     where r.lenses @> to_jsonb(t);
    if n < 1 then bad := bad || format(
      E'\n  SEED-4a lens %s is carried by no registered claim', t); end if;
  end loop;

  select count(*) into n
    from jsonb_array_elements(body -> 'challenge_lenses') as l
    cross join lateral jsonb_array_elements_text(l -> 'grounding_claims') as g(claim_id)
   where not exists (select 1 from public.scenario_claim c
                      where c.scenario_version_id = case_v and c.claim_id = g.claim_id);
  if n <> 0 then bad := bad || format(
    E'\n  SEED-4b %s lens grounding references name an unregistered claim', n); end if;

  select count(*) into n from jsonb_array_elements(body -> 'challenge_lenses');
  if n <> array_length(lenses, 1) then bad := bad || format(
    E'\n  SEED-4c the body declares %s challenge lenses, expected %s',
    n, array_length(lenses, 1)); end if;

  -- ---- SEED-5  THE EDITORIAL BOUNDARY, MEASURED ON THE ROWS. --------------------
  -- Not a promise in a comment: these are the rows a renderer, an export or a model
  -- prompt will actually read.
  select count(*) into n from public.source
   where scenario_version_id = case_v
     and (kind <> 'fictional_assumption' or uri is not null);
  if n <> 0 then bad := bad || format(
    E'\n  SEED-5a %s source rows are not fiction-kinded or carry a uri', n); end if;

  select count(*) into n from public.source
   where scenario_version_id = case_v
     and (position('(fictional scenario document)' in title) = 0
          or position('fictional' in lower(publisher)) = 0);
  if n <> 0 then bad := bad || format(
    E'\n  SEED-5b %s source rows do not announce their fiction in title and publisher', n);
  end if;

  -- The link control. No uri column is written, so a pasted link would hide in prose.
  select count(*) into n from public.source
   where scenario_version_id = case_v
     and (lower(title || ' ' || publisher) like any
          (array['%http%', '%www.%', '%doi.org%']));
  if n <> 0 then bad := bad || format(
    E'\n  SEED-5c %s source rows contain a link-shaped string in title or publisher', n);
  end if;
  select count(*) into n from public.scenario_claim
   where scenario_version_id = case_v
     and (lower(claim_text) like any (array['%http%', '%www.%', '%doi.org%']));
  if n <> 0 then bad := bad || format(
    E'\n  SEED-5d %s claims contain a link-shaped string in claim_text', n); end if;

  -- is_fiction is NOT NULL on the column, so the live question is whether the column and
  -- the body's own fiction notice AGREE. A case labelled fictional in one place and not
  -- the other is the drift this catches.
  select count(*) into n from public.scenario_version
   where id = case_v
     and is_fiction
     and (content -> 'fiction_notice' ->> 'is_fiction') = 'true'
     and (content -> 'fiction_notice' ->> 'every_source_is_fictional') = 'true'
     and as_of_date is not null;
  if n <> 1 then bad := bad || format(
    E'\n  SEED-5e is_fiction / as_of_date / the body fiction notice do not agree (matched %s of 1)',
    n); end if;

  -- ---- SEED-6  NOTHING THE BODY CITES IS UNREGISTERED. -------------------------
  -- The conflict sets, the stakeholder position lists and the constraint blocks all name
  -- claim ids. A claim the case asserts but does not register cannot be cited by anything
  -- downstream, so an unresolvable reference here is a defect in the case, not a detail.
  select count(*) into n
    from (
      select g.claim_id from jsonb_array_elements(body -> 'conflicting_evidence') as e
            cross join lateral jsonb_array_elements_text(e -> 'claims') as g(claim_id)
      union all
      select g.claim_id from jsonb_array_elements(body -> 'stakeholders') as s
            cross join lateral jsonb_array_elements_text(s -> 'claims') as g(claim_id)
      union all
      select g.claim_id from jsonb_each(body -> 'constraints') as k(key, value)
            cross join lateral jsonb_array_elements_text(
                   coalesce(k.value -> 'claims', '[]'::jsonb)) as g(claim_id)
    ) refs
   where not exists (select 1 from public.scenario_claim c
                      where c.scenario_version_id = case_v and c.claim_id = refs.claim_id);
  if n <> 0 then bad := bad || format(
    E'\n  SEED-6 %s claim references in the case body are not in the register', n); end if;

  -- And the reverse direction, which is the one a reviewer forgets: a registered claim
  -- that the body never cites is dead weight in the grounding whitelist. Reported as a
  -- failure, because the register IS the whitelist and an uncited row widens it for
  -- nothing.
  select count(*) into n from public.scenario_claim c
   where c.scenario_version_id = case_v
     and not exists (
       select 1 from (
         select g.claim_id from jsonb_array_elements(body -> 'challenge_lenses') as l
               cross join lateral jsonb_array_elements_text(l -> 'grounding_claims') as g(claim_id)
         union all
         select g.claim_id from jsonb_array_elements(body -> 'conflicting_evidence') as e
               cross join lateral jsonb_array_elements_text(e -> 'claims') as g(claim_id)
         union all
         select g.claim_id from jsonb_array_elements(body -> 'stakeholders') as s
               cross join lateral jsonb_array_elements_text(s -> 'claims') as g(claim_id)
         union all
         select g.claim_id from jsonb_each(body -> 'constraints') as k(key, value)
               cross join lateral jsonb_array_elements_text(
                      coalesce(k.value -> 'claims', '[]'::jsonb)) as g(claim_id)
       ) cited where cited.claim_id = c.claim_id);
  if n <> 0 then bad := bad || format(
    E'\n  SEED-6b %s registered claims are never cited by the case body', n); end if;

  -- ---- SEED-7  PRD 5.2 and 8.1 require the case to CONTAIN certain things. -------
  -- Conflict and data gaps are what the product is for, so their absence is a build
  -- failure rather than a thin case. The floors are deliberate minima, not the measured
  -- values, so adding material cannot break the build and removing it can.
  if jsonb_array_length(body -> 'conflicting_evidence') < 5 then
    bad := bad || format(E'\n  SEED-7 the case registers %s conflict sets, expected >= 5',
      jsonb_array_length(body -> 'conflicting_evidence')); end if;
  if jsonb_array_length(body -> 'data_gaps') < 5 then
    bad := bad || format(E'\n  SEED-7 the case registers %s data gaps, expected >= 5',
      jsonb_array_length(body -> 'data_gaps')); end if;
  if jsonb_array_length(body -> 'stakeholders') < 4 then
    bad := bad || format(E'\n  SEED-7 the case registers %s stakeholders, expected >= 4',
      jsonb_array_length(body -> 'stakeholders')); end if;
  if jsonb_array_length(body -> 'fictional_assumptions') < 3 then
    bad := bad || format(
      E'\n  SEED-7 the case states %s fictional assumptions, expected >= 3',
      jsonb_array_length(body -> 'fictional_assumptions')); end if;

  -- PRD 8.1's enumerated stores, present and non-empty. A missing key reads as NULL and
  -- is caught, which is why this is a key list rather than a prose claim that it is all
  -- there.
  foreach t in array array[
      'case_id','case_version','title','learning_objective','sector','jurisdiction',
      'issue_statement','user_role','source_register','claim_register',
      'fictional_assumptions','decision_window','available_resources','data_gaps',
      'conflicting_evidence','stakeholders','constraints','second_order_effects',
      'required_decision','response_template','challenge_lenses','rubric','publication',
      'editorial_boundary','fiction_notice','exclusions'] loop
    if (body -> t) is null or body -> t = 'null'::jsonb then
      bad := bad || format(E'\n  SEED-7 PRD 8.1 element %s is absent from the case body', t);
    end if;
  end loop;

  -- The body must describe ITSELF correctly, or an export carries the wrong ids.
  if (body -> 'ids' ->> 'scenario_version_id') is distinct from case_v::text
     or (body -> 'ids' ->> 'scenario_id') is distinct from case_s::text
     or (body -> 'ids' ->> 'rubric_version_id') is distinct from case_r::text
     or (body ->> 'case_id') is distinct from 'DEMO-PH-001' then
    bad := bad || E'\n  SEED-7 the case body does not describe its own ids correctly';
  end if;

  if bad <> '' then
    raise exception 'the seeded case is not the shape 0009 claims:%', bad
      using errcode = 'ST022';
  end if;
end $assert$;

-- ---------------------------------------------------------------------------
-- The seed bracket closes.
-- ---------------------------------------------------------------------------
alter table public.scenario         force row level security;
alter table public.scenario_version force row level security;
alter table public.source           force row level security;
alter table public.scenario_claim   force row level security;
alter table public.rubric_version   force row level security;

-- ---------------------------------------------------------------------------
-- SEED-CTRL-A / SEED-CTRL-B — the paired read control, now over REAL content.
--
-- 0008's CTRL-3 and CTRL-4 measured the same qual against a single reserved sentinel row,
-- after discovering (measured, in that file) that an EMPTY forced-RLS table raises
-- nothing at all because the qual is never reached (V6, V18). This file re-measures them
-- against 47 claim rows and 10 source rows of real content, which is the stronger
-- instrument: a policy that stopped raising would now expose content a user actually
-- reads, not a row labelled "reserved".
--
-- A  (the denial)          no identity context -> 28000 from every reference table.
-- B  (the positive control) context set        -> the case reads back, with the claim
--                          count equal to the body's own register length.
--
-- B is why A is not vacuous: `using (false)` or `using (require_user_id() is not null and
-- false)` would both pass A while making the case unreadable to every authenticated user
-- (V7: a failing qual affects zero rows and raises nothing). Runs as statesman_owner
-- under FORCE, so these reads go THROUGH the qual rather than around it by ownership
-- (V4/V8/V9). The context is restored explicitly (V17).
-- ---------------------------------------------------------------------------
do $ctrl$
declare
  case_v    constant uuid := '00000000-0000-0000-0000-000000090003';
  sentinel  constant uuid := '00000000-0000-0000-0000-00000000dead';
  tables    constant text[] := array[
    'scenario','scenario_version','source','scenario_claim','rubric_version'];
  prev_ctx  text := current_setting('app.current_user_id', true);
  t         text;
  raised    boolean;
  n         integer;
  expected  integer;
  bad       text := '';
begin
  -- A: no context -> 28000 everywhere.
  perform set_config('app.current_user_id', '', true);
  foreach t in array tables loop
    raised := false;
    begin
      execute format('select 1 from public.%I limit 1', t);
    exception
      when sqlstate '28000' then raised := true;
      when others then
        bad := bad || format(E'\n  SEED-CTRL-A %s raised %s (%s), expected 28000',
                             t, sqlerrm, sqlstate);
        raised := true;
    end;
    if not raised then
      bad := bad || format(
        E'\n  SEED-CTRL-A %s returned instead of raising 28000 with no identity context', t);
    end if;
  end loop;

  -- B: context set -> the case is readable THROUGH the policy, and complete.
  perform set_config('app.current_user_id', sentinel::text, true);
  begin
    select jsonb_array_length(content -> 'claim_register') into expected
      from public.scenario_version where id = case_v;
    select count(*) into n from public.scenario_claim where scenario_version_id = case_v;
    if expected is null then
      bad := bad || E'\n  SEED-CTRL-B the case body is not readable for an authenticated identity';
    elsif n <> expected then
      bad := bad || format(
        E'\n  SEED-CTRL-B %s claim rows readable through the policy, body registers %s',
        n, expected);
    end if;

    select count(*) into n
      from public.scenario_claim c
      join public.source s
        on s.id = c.source_id and s.scenario_version_id = c.scenario_version_id
     where c.scenario_version_id = case_v;
    if n <> expected then
      bad := bad || format(
        E'\n  SEED-CTRL-B %s of %s claims join to a source through the policy', n, expected);
    end if;

    select count(*) into n from public.scenario where id = '00000000-0000-0000-0000-000000090002'
      and status = 'published';
    if n <> 1 then
      bad := bad || E'\n  SEED-CTRL-B the published case row is not readable for an authenticated identity';
    end if;
  exception when others then
    bad := bad || format(E'\n  SEED-CTRL-B raised %s (%s) for an authenticated identity',
                         sqlerrm, sqlstate);
  end;

  perform set_config('app.current_user_id', coalesce(prev_ctx, ''), true);

  if bad <> '' then
    raise exception 'the seeded case is not readable the way 0009 claims:%', bad
      using errcode = 'ST022';
  end if;
end $ctrl$;

-- ---------------------------------------------------------------------------
-- SEED-CTRL-C — the bracket is closed, measured from pg_catalog rather than trusted.
-- A NO FORCE left open makes the owner's bypass permanent, fails no migration, and
-- quietly makes every denial test downstream vacuous (0006, 0008 CTRL-6). This file opens
-- the bracket once; it checks anyway, because the cost of the check is nothing and the
-- cost of the mistake is every tenancy test in the suite.
-- ---------------------------------------------------------------------------
do $restored$
declare r record; bad text := '';
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
  if bad <> '' then
    raise exception 'SEED-CTRL-C: 0009 left a bracket open:%', bad using errcode = 'ST022';
  end if;
end $restored$;

-- ---------------------------------------------------------------------------
-- V2 / V30. This file creates no function, so there is nothing new for PUBLIC to hold
-- EXECUTE on — but the two REVOKEs run anyway, unconditionally, at the end of every
-- migration. That is the point of V30: the control is not "revoke when you added a
-- function", it is "revoke at the end, every time", because ALTER DEFAULT PRIVILEGES
-- cannot record a negative default and nothing prevents the next function from being
-- PUBLIC-executable. Posture rule 4 is the gate; this is the statement it gates on.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema app    from public;
revoke execute on all functions in schema public from public;
