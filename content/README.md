# Scenario content — editorial rules for whoever writes case 2

This directory holds the editorial source of truth for STATESMAN OS training cases. One
case exists: `demo-ph-001.json`, seeded by
`supabase/migrations/20261021140800_seed_demo_ph_001.sql`.

Read this before writing a case. The rules below are not house style. Three of them are
product requirements with database controls behind them, and a case that breaks one fails
the migration rather than shipping quietly.

---

## 1. The rule that matters most: do not fabricate a citation

**Never cite a real publication, agency, statute, official, dataset, DOI or URL in a case
or in its source register.** Not even one you are fairly confident exists.

A plausible-looking citation to a real organisation is the exact failure FR-08 and PRD 9.4
prohibit, and it is **worse than an obviously fictional source**, because a learner may act
on it. "Ministry of Health circular 2026-14" is not a shortcut to rigour; it is a
fabrication with a reference number attached. Canon §1.2 says the same thing from the other
direction: Guyana-first is editorial *context*, not licence to invent Guyanese legal
provisions, current incidents, prices, budgets, institutional positions or health facts.

So the honest default, and what `DEMO-PH-001` does:

> **Every source in the register is an explicitly fictional in-scenario document.**

Each one is a situation report, a laboratory capacity note, a transport memo, a minute, a
field note — written as part of the case, labelled fictional in its own title and
publisher, and stored with `kind = 'fictional_assumption'` and `uri IS NULL`.

This is not a weaker case. A case built entirely from in-scenario documents can be made
*more* demanding than one resting on real reports, because you control the conflicts
precisely and you never have to pretend a real document says something it does not.

### What the database enforces

`20261021140800_seed_demo_ph_001.sql` reads the rows back after writing them and aborts the migration with
`ST022` unless all of the following hold for the case being seeded:

| Control | What fails the build |
|---|---|
| SEED-5a | a source row that is not `kind = 'fictional_assumption'`, or that carries a `uri` |
| SEED-5b | a source title missing `(fictional scenario document)`, or a publisher not containing `fictional` |
| SEED-5c / 5d | `http`, `www.` or `doi.org` anywhere in a source title, publisher or claim text |
| SEED-5e | `is_fiction` disagreeing with the case body's own fiction notice, or a missing `as_of_date` |

`source`'s own `source_factual_is_traceable` CHECK (migration 0008) closes the other side:
any `kind` other than `fictional_assumption` **requires** both a `uri` and a
`retrieved_date`. So there is no way to seed a half-real source — either it is openly
fictional, or it must be reachable and dated.

### If you want real-world grounding

Real-world grounding belongs **here, in this README, as background for the editor**, clearly
separated from any case's source register — and only if you can name a source you are
confident exists.

For `DEMO-PH-001` no such source is named. The case was written **entirely** from fictional
in-scenario documents, with no real reference consulted or cited for how outbreak response
is generally structured. That is stated rather than papered over, because inventing a real
reference to look rigorous is the failure mode this section exists to prevent. The one
external material the case leans on is the project's own `docs/PRD.md` Appendix A, which is
where the case, its role, its window and its five challenge questions come from.

---

## 2. The jurisdiction is invented, and says so

`DEMO-PH-001` is set in the Kerrin Region of the Republic of Mereva. Neither exists. Its
three districts, four settlements, five facilities and six institutions are all invented,
and the case body says so in `fiction_notice` and in `fictional_assumptions`.

Rules for case 2:

- **No real region, town, hospital, body or official.** Not Guyanese, not anyone else's.
- **No named people at all.** Every participant appears by role: "the regional hospital's
  clinical lead", "the national finance desk's representative". A case with no names cannot
  be used to impersonate a real official (PRD 9.3), and a renderer cannot print a name that
  is not there.
- **Money is in an invented unit.** `DEMO-PH-001` uses the "in-scenario currency unit
  (ISU)", with no exchange rate. A real currency symbol invites the figure to be read as a
  real budget or price, which canon §1.2 prohibits.
- **State in the content that the setting is invented and resembles no actual
  jurisdiction.** Put it in the body, not only in a migration comment: the body is what a
  renderer, an export and a model prompt all read.

---

## 3. Legal constraints without inventing a statute

This is the subtlest rule and the easiest to get wrong.

- **A fabrication:** "section 14 of the Public Health Act empowers the regional officer
  to…". Also a fabrication if the Act is invented, because the learner still comes away
  believing a provision exists that can be relied on.
- **A decision prompt:** "the coordinating executive has been advised that a movement
  restriction would need written confirmation of the power to issue it, and the office has
  not located that confirmation."

`DEMO-PH-001` contains **no statute, regulation, circular, instrument number or legal
citation of any kind, real or invented.** Legal authority appears only as a contested
question: one official asserts the region has restricted movement before, the coordinating
office's legal adviser asks for written confirmation first and reports none has been found,
a third official says any restriction would be announced nationally, and the minute records
no decision. That is a stronger legal-authority lens than an invented provision, because the
only defensible answer is to name what must be verified and by whom — which is precisely the
PRD Appendix A legal challenge.

The same discipline applies to budgetary constraints: `DEMO-PH-001` records a *past practice*
of an invented finance desk ("drawings above 60 per cent of the line have previously been
returned for written justification") and explicitly notes that the document cites no rule.

---

## 4. No health, clinical or epidemiological facts

`DEMO-PH-001` is a dengue case that contains **no claim about dengue as a disease.** No
transmission fact, no incubation period, no clinical sign, no test-performance figure, no
vector biology.

That is deliberate. Any such statement would need either a real citation (prohibited above)
or an invented health fact (worse). So the case's register carries only *operational* facts:
reported counts, laboratory throughput and backlog, stock and expiry, transport and fuel,
staffing, journey times, positions taken in a meeting, and what residents said. Clinical
management is declared out of scope for the role the case asks the user to play, and the
body says a response that reasons clinically is reasoning outside the material supplied.

Carry this forward. A case about flood response can describe sandbag stock and road access
without asserting a hydrological fact.

---

## 5. The claim register is the load-bearing part

`public.scenario_claim` is **the grounding whitelist** (canon §5.1 and §7.3). A model
citation naming a `(scenario_version_id, claim_id)` absent from it is rejected server-side,
and once the citation tables of the challenge slice exist, a fabricated citation cannot be
persisted at all.

The consequence for an editor: **a factual assertion in the case body that is not registered
as a claim cannot be cited by anything downstream.** It is invisible to the challenge layer.
So the register is not metadata; it is the case.

### Write the register once, and let the database derive the rows

`20261021140800_seed_demo_ph_001.sql` does **not** retype the claims into `INSERT … VALUES`. It inserts the case
body as `scenario_version.content` and then derives both `source` and `scenario_claim` from
that jsonb with `jsonb_to_recordset`. Transcribing 47 claims twice would put a drift defect
one typo away; deriving them makes the body and the register identical by construction.

Do the same for case 2. The shape the derivation expects:

```jsonc
"source_register": [
  { "source_id": "<uuid>",            // reserved id, see §8
    "title": "… (fictional scenario document)",
    "publisher": "… (fictional in-scenario body)",
    "kind": "fictional_assumption",
    "in_world_published_date": "2026-03-04",
    "in_world_retrieved_date": "2026-03-05",
    "description": "what this document is, for the editor" }
],
"claim_register": [
  { "claim_id": "C-LAB-BACKLOG",      // ^[A-Za-z0-9._-]{1,64}$
    "source_id": "<uuid from source_register>",
    "confidence": "high",             // high | medium | low | insufficient
    "lenses": ["execution", "community_impact"],
    "claim_text": "The regional laboratory reports 212 samples awaiting dispatch …" }
]
```

`claim_text` must stand on its own. It is what a model cites and what a user is shown as
evidence, so "212 samples awaiting dispatch" belongs in the text, not implied by the title.

### What the database enforces

| Control | What fails the build |
|---|---|
| SEED-1 | registered rows not matching the body's register length, or a register below the floor (8 sources, 25 claims) |
| SEED-3 | a claim whose `source_id` does not resolve **within the same scenario version** |
| SEED-4a/b/c | a lens carried by no registered claim; a lens grounding list naming an unregistered claim; fewer than five lenses |
| SEED-6 | a claim id cited by a conflict set, a stakeholder or a constraint block that is not registered |
| SEED-6b | a registered claim that the body never cites anywhere — dead weight in the whitelist |
| SEED-7 | a missing PRD 8.1 element, fewer than 5 conflict sets / 5 data gaps / 4 stakeholders / 3 stated assumptions, or a body that misdescribes its own ids |

The floors exist because an equality check alone passes vacuously: an empty register
satisfies `0 = 0` and reports success. V7 — a row count of 0 is never a success signal.

### What `confidence` means for a fictional case

It is the **designed in-world evidential strength of the document the claim came from** — a
handwritten tally is `low`, a laboratory stock count is `high` — and never a truth claim
about the real world, which would be meaningless for invented material.

That reading is what makes the band teachable: the learner is meant to notice that the
instrument disagreeing with the official figures is also the weaker instrument, *without*
being told which is right. Use the band the same way in case 2. The domain is the same four
values as `dimension_assessment.evidence_quality`, deliberately, rather than the 0–100
percentage `decision_revision.confidence` uses for the user's own forecast.

---

## 6. Conflict is the product

PRD 5.2 requires data gaps and competing legitimate interests, and the whole value of the
exercise is reasoning under conflicting evidence. A case where the right answer is legible
from the register teaches nothing.

`DEMO-PH-001` registers ten conflict sets and nine data gaps. The ones worth copying as
patterns:

- **Two instruments that cannot both be right.** A district figure of 38 suspected cases in
  one village against that village's own handwritten tally of 96, with the surveillance desk
  recording that it has not reconciled them. The case never resolves it, so a response that
  silently picks one has made an assumption it did not state.
- **A resource that reads sufficient one way and insufficient another.** 1,100 tests in
  stock, 40 a day of throughput, 212 samples already queued for a 5-to-7-day confirmatory
  route, and 300 tests near expiry. Both pictures are sourced.
- **The same asset committed twice.** Two boats listed as available in the transport memo,
  one of them already promised to a school-feeding run in the community liaison note.
- **Authority asserted from practice and denied in writing.** See §3.
- **Arithmetic that does not stretch.** 60 per cent of 18,400,000 ISU is 11,040,000; the two
  operational asks are 9,600,000 together and the protected commitment is a further
  4,100,000. A learner can check it, and it will not reconcile.
- **A second-order effect that runs against the first-order aim.** Residents saying they
  would be less willing to present at the health post if presenting could trigger a
  restriction.

Ground each of the five lenses — legal authority, public finance, ethics and equity,
execution, community impact — in registered claims. `DEMO-PH-001` carries 9 to 28 claims per
lens. SEED-4a fails the build if any lens has none, because a case that cannot ground five
lenses makes the challenge slice impossible and the failure would surface as an abstaining
model rather than as a content defect.

---

## 7. Publication status, told honestly

`scenario.status` is the PRD 8.2 editorial record. `scenario_version.published_at` is the
authoritative "is this content live" signal, and the column the immutability gate reads.

**A published `scenario_version` is immutable (`ST020`).** There is no later `UPDATE` to fix
a typo — the trigger fires for the owner too. Insert the version complete, or leave
`published_at` NULL until it is.

`DEMO-PH-001` is published with its review legs recorded as they actually stand:

- `source_verification: not_applicable` — that PRD 8.2 stage exists to verify *external*
  sources, and this case cites none. The reason is stated in the body, not assumed.
- `subject_matter_and_ethics_review: pending`, naming an evidence record
  (`docs/reviews/demo-ph-001-content-review.md`) that does not yet exist, with **no reviewer
  name and no sign-off date**, because canon §12.3 forbids inventing one. Treat it as a pilot
  release-gate item.

Do not invent an approver to make the pipeline look complete. Record the gap in the content,
where every renderer and export carries it.

---

## 8. Reserved ids, and keeping this file and the database in step

Ids are fixed, not generated, so a diff of the template database is byte-stable. The
convention is the all-zero prefix block tagged with the migration number:

| Block | Meaning |
|---|---|
| `…00000000dead` | the reserved sentinel **user** (migration 0006) |
| `…0000000800xx` | the reserved reference **sentinel** rows (migration 0008) — not content |
| `…0000000900xx` | `DEMO-PH-001`: rubric `…090001`, scenario `…090002`, version `…090003` |
| `…000000090101`–`…000000090110` | its ten fictional sources |

Case 2 takes its own block from its own migration number. Note V33: `z.guid()` accepts these
ids and `z.uuid()` would reject them, so every identifier validator in this project is
`z.guid()`.

### The drift check

`20261021140800_seed_demo_ph_001.sql` splices this directory's JSON verbatim into a dollar-quoted literal, so
the file and the seeded row start identical. To re-verify after any edit:

```sh
export PATH=/opt/homebrew/opt/postgresql@17/bin:$PATH LC_ALL=en_US.UTF-8
diff <(PGOPTIONS="-c app.current_user_id=00000000-0000-0000-0000-00000000dead" \
       psql -qAt -U statesman_app -h 127.0.0.1 -d statesman_test_template \
         -c "select content from public.scenario_version
               where id='00000000-0000-0000-0000-000000090003'" | jq -S .) \
     <(jq -S . content/demo-ph-001.json) && echo "content/ and the database agree"
```

Run exactly that. The identity context is supplied through `PGOPTIONS` at connection time
rather than by a second `-c "select set_config(…)"`, and the difference is not cosmetic: the
first draft of this command used the two-statement form, and `set_config` **returns a row**,
so `jq` received a bare UUID on line 1 and died with `Invalid numeric literal` while `diff`
reported the entire case as missing. A drift check that fails that way looks exactly like a
drift check that found drift. Measured here, which is the only reason it is written down.

It is a **key-sorted `jq` comparison, not a hash**, and that is not laziness: `jsonb`
normalises key order, so `{"b":1,"a":2}` and `{"a":2,"b":1}` are stored and hashed
identically. An outside serialisation of the same content is therefore not byte-reproducible,
which is why `scenario_version.content_hash` is useful as an equality handle *between
database readers* and useless as a check against a file. Migration 0008's header records the
measurement behind that.

---

## 9. Checklist for case 2

1. Write `content/<case>.json`. Every source fictional, every person a role, no statute, no
   real citation, no health fact, invented currency, invented jurisdiction, the fiction
   stated in the body.
2. Register every factual assertion as a claim with a source and a confidence band. If it is
   not in the register, nothing downstream can cite it.
3. Ground all five lenses, and build real conflicts between claims rather than describing
   conflict in prose.
4. Record the PRD 8.1 elements — SEED-7 lists them and fails on a missing one.
5. Write `supabase/migrations/<CLI-timestamp>_seed_<case>.sql` on the shape of
   `20261021140800_seed_demo_ph_001.sql`: bracket
   `no force` / `force` (V8/V9 — the policies are `for select` only, so an owner insert under
   FORCE is refused outright), insert the body, derive `source` and `scenario_claim` from it,
   assert counts against the register length **and** a floor (V7), scope every count to the
   case's `scenario_version_id` (V35), close with the two
   `revoke execute on all functions … from public` statements (V2/V30), and keep every
   assertion inside the bracket because an owner read under FORCE raises `28000`.
6. `bash scripts/db-template.sh` and read the real exit code. Then prove the case is readable
   **as `statesman_app`, through the policy**, and that an uncontexted read raises `28000`.
7. Break it on purpose once. Paste a link into a claim, rename a claim the body cites, strip
   a fiction label — and confirm the migration dies with `ST022`. A control that has never
   been made to fire has not been shown to work (canon §8). Eight such mutations were run
   against `0009`; all eight were caught, and one of them exposed a mutation harness that was
   silently not mutating anything, which is the more useful lesson.

## 10. SQLSTATEs in this area

| Code | Meaning | Raised by |
|---|---|---|
| `ST020` | published reference content is immutable | `app.guard_published_reference()` (0008) |
| `ST021` | a reference content table cannot be truncated | `app.forbid_reference_truncate()` (0008) |
| `ST022` | seeded scenario content integrity: a seed assertion failed | the `SEED-*` blocks in 0009 |

All custom SQLSTATEs are **uppercase**. A lowercase code silently resolves to `42704`
(V13). `ST022` is raised only while a migration runs, as `statesman_owner`, and is never
reachable from the application path, so it needs no mapping in `src/server/db/errors.ts`.
`ST020` and `ST021` *are* runtime-reachable and their mapping is an open follow-up recorded
by 0008.
