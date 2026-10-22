# Content review record — DEMO-PH-001

**Case:** DEMO-PH-001, "A Regional Dengue Response Under Uncertainty"
**Referenced by:** `content/demo-ph-001.json` → `publication.subject_matter_and_ethics_review.evidence_record`

## State: OUTSTANDING

**No subject-matter review and no ethics review has taken place.** No reviewer is named
and no sign-off date is recorded, because inventing either would be a fabrication of
exactly the kind the case content was audited against (canon §12.3 forbids it).

This file exists so the pointer in the case's `publication` block resolves to a real
record rather than dangling. A dangling pointer to a review is indistinguishable from a
review that happened and was lost.

## Why the case is nonetheless seeded and live

`scenario.status = 'published'` and `scenario_version.published_at` is set, so the case is
readable by the application. That is deliberate for a development build: the Decision Desk
needs a case to display, and the immutability gates that protect a submitted decision only
engage once a version is published.

`publication.case_status_in_product` therefore reads **`published_for_development`**, and
`publication.editorial_pipeline_stage` reads
**`approved_pending_subject_matter_and_ethics_review`** — its real position in PRD §8.2's
pipeline (Draft → Source verification → Subject-matter/ethics review → Approved →
Published). An earlier version of both fields read `published`, which contradicted the
`pending` state recorded two keys below it in the same object.

## What has been discharged

**Source verification: not applicable, and that is a finding rather than a gap.** The case
cites no external source. Every entry in its register is an in-scenario document authored
with the case and carrying kind `fictional_assumption`. There is nothing external to
verify. This was chosen over citing real material precisely to avoid fabricating a
citation to a real publication, agency or statute — the failure mode PRD §9.4 and FR-08
prohibit, and the one an auditor would be least able to detect.

**Fabrication audit: clean, twice, independently.** Two reviewers read every assertion —
all 47 `claim_text` values, all 10 source rows, and every prose field — and then swept the
body for `http`, `www.`, `doi.org`, `.gov`, `.org`, `.com`, `@`, and the names of real
health organisations and ministries. Both returned an empty fabrication list. That is the
strongest statement available about this case's content and it is the reason the case is
safe to develop against.

**Provenance chain: verified by query.** Every factual claim in the body resolves to a
`scenario_claim` row, every `scenario_claim` row resolves to a `source` in the same
`scenario_version`, with no orphans in either direction.

## What a reviewer must still do before the pilot

1. **Subject-matter review.** Is the dengue-response scenario pedagogically sound? Do the
   decision pressures, the resource constraints and the stakeholder conflicts resemble the
   real shape of such a decision closely enough to train judgement, without asserting
   anything false about the world?
2. **Ethics review.** Does the case handle a public-health emergency, a vulnerable
   population and an invented jurisdiction responsibly? Does any part of it risk being
   read as guidance for a real outbreak?
3. **Confirm the fictional framing holds under a naive reading.** The audit confirmed no
   fabricated citation exists. A reviewer should confirm something different: that a
   learner skimming the case cannot mistake the invented region, the invented documents or
   the invented figures for real ones.
4. **Record the outcome here**, with a name and a date, and update
   `publication.subject_matter_and_ethics_review.state` and `editorial_pipeline_stage` in
   the same change.

Until step 4 is done, FR-02's manual verification leg for this case is `NOT RUN`, never
`PASS` (canon §12.3).
