/**
 * Unit: the exported record's shape.              [FR-16] [NFR-09] [FR-02] [FR-04]
 *
 * Pure logic, no network. `toExportDocument` is a total function from an
 * evidence trail to a document, and the document is a PUBLISHED CONTRACT: FR-16
 * asks for "a portable format" and NFR-09 for "a documented machine-readable
 * format", which means somebody will read these files with no access to this
 * code.
 *
 * ── THE TWO CLAIMS THIS FILE EXISTS FOR ─────────────────────────────────────
 *
 *   1. THE PINNED IDENTIFIERS SURVIVE THE EXPORT. `docs/ui-ux-design.md` §9.2
 *      requires each hop to show the identifiers it is pinned to, and an export
 *      that drops them is a story rather than a record: without
 *      `scenario_version.id` nobody can later establish WHICH version of a case
 *      a decision answered, which is the whole point of the composite foreign
 *      key that pins it.
 *
 *   2. THE DOCUMENT SAYS WHAT IT DOES NOT CONTAIN. Three quarters of the record
 *      §9.2 describes — challenges, reflection, actions — do not exist yet. A
 *      file that silently omits them is one a reader could reasonably take as
 *      complete, and the statement has to travel INSIDE the artefact because
 *      that is the only place it travels at all.
 */
import { describe, expect, it } from 'vitest'
import { EXPORT_FORMAT, toExportDocument } from '../../../src/lib/export/record'
// `import type` only: it is erased at compile time, so this does NOT pull in the
// Supabase client, which throws at module load without credentials the unit gate
// deliberately does not have.
import type { EvidenceTrail } from '../../../src/lib/supabase/history'

const TRAIL: EvidenceTrail = {
  decisionId: '11111111-1111-4111-8111-111111111111',
  state: 'submitted',
  createdAt: '2026-10-20T09:00:00Z',
  submittedAt: '2026-10-20T09:40:00Z',
  scenario: {
    scenarioVersionId: '22222222-2222-4222-8222-222222222222',
    title: 'A Regional Dengue Response Under Uncertainty',
    sector: 'Public health emergency coordination',
    jurisdiction: 'Kerrin Region, Republic of Mereva',
    versionNo: 1,
    asOfDate: '2026-03-06',
    isFiction: true,
    fictionStatement: 'This case is entirely invented training material.',
    publishedAt: '2026-10-21T00:00:00Z',
    supersededBy: 2,
  },
  sources: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      title: 'Kerrin Region situation report 3 (fictional scenario document)',
      publisher: 'Kerrin Regional Health Authority',
      uri: null,
      publishedDate: '2026-03-04',
      retrievedDate: '2026-03-05',
      kind: 'fictional_assumption',
    },
  ],
  revisions: [
    {
      id: '44444444-4444-4444-8444-444444444444',
      revisionNo: 1,
      confidence: 70,
      forecast: 'Testing backlog falls below 100 within the window.',
      horizon: '72 hours',
      rationale: 'Because the two counts disagree and only one route confirms.',
      content: { objective: 'Contain while verifying.' },
      createdAt: '2026-10-20T09:40:00Z',
    },
  ],
  audit: [
    {
      id: '55555555-5555-4555-8555-555555555555',
      action: 'submission',
      actorUserId: '66666666-6666-4666-8666-666666666666',
      detail: { revision_no: 1 },
      occurredAt: '2026-10-20T09:40:00Z',
    },
  ],
}

describe('toExportDocument', () => {
  it('[NFR-09] carries a format marker and an export timestamp', () => {
    const doc = toExportDocument(TRAIL)
    // A file with no version marker is a file nobody can safely read later.
    expect(doc.format).toBe(EXPORT_FORMAT)
    expect(EXPORT_FORMAT).toMatch(/\bv\d+$/)
    expect(Date.parse(doc.exported_at), 'exported_at is not a parseable instant').not.toBeNaN()
  })

  it('[FR-02][FR-04] every pinned identifier survives the export', () => {
    const doc = toExportDocument(TRAIL)
    expect(doc.decision.id).toBe(TRAIL.decisionId)
    expect(doc.scenario_version.id).toBe(TRAIL.scenario.scenarioVersionId)
    expect(doc.scenario_version.version_no).toBe(1)
    expect(doc.revisions[0]?.id).toBe(TRAIL.revisions[0]?.id)
    expect(doc.sources[0]?.id).toBe(TRAIL.sources[0]?.id)
    expect(doc.audit[0]?.id).toBe(TRAIL.audit[0]?.id)
  })

  it('[FR-02] records that the case has been superseded, without re-pointing at the newer version', () => {
    const doc = toExportDocument(TRAIL)
    // The record resolves to the version it was WRITTEN AGAINST. The newer one
    // is reported as context, never substituted.
    expect(doc.scenario_version.version_no).toBe(1)
    expect(doc.scenario_version.superseded_by_version_no).toBe(2)
  })

  it('[FR-04] the whole revision is exported, not a summary of it', () => {
    const doc = toExportDocument(TRAIL)
    const r = doc.revisions[0]
    expect(r?.confidence).toBe(70)
    expect(r?.expected_outcomes).toBe(TRAIL.revisions[0]?.forecast)
    expect(r?.time_horizon).toBe(TRAIL.revisions[0]?.horizon)
    expect(r?.rationale).toBe(TRAIL.revisions[0]?.rationale)
    expect(r?.content).toEqual(TRAIL.revisions[0]?.content)
  })

  it('[NFR-03] the audit hop keeps the actor, including when there is none', () => {
    const doc = toExportDocument(TRAIL)
    expect(doc.audit[0]?.actor_user_id).toBe('66666666-6666-4666-8666-666666666666')

    // A system event has no actor, and null must survive as null rather than
    // being coerced to the subject's id, which would invent a person.
    const systemTrail: EvidenceTrail = {
      ...TRAIL,
      audit: [{ ...TRAIL.audit[0]!, actorUserId: null }],
    }
    expect(toExportDocument(systemTrail).audit[0]?.actor_user_id).toBeNull()
  })

  it('[FR-16] the document states what it does NOT contain', () => {
    const doc = toExportDocument(TRAIL)
    expect(doc.not_included.length).toBeGreaterThan(0)
    const blob = doc.not_included.join(' ').toLowerCase()
    for (const absent of ['challenge', 'reflection', 'review']) {
      expect(blob, `the export does not disclose that ${absent} data is missing`).toContain(
        absent,
      )
    }
  })

  it('[NFR-09] the document round-trips through JSON unchanged', () => {
    // The artefact is a file, so the thing that must be correct is what
    // JSON.stringify produces, not the in-memory object. A Date, a Map or an
    // undefined would survive the assertions above and be lost or malformed here.
    const doc = toExportDocument(TRAIL)
    const roundTripped: unknown = JSON.parse(JSON.stringify(doc))
    expect(roundTripped).toEqual(doc)
  })

  it('[FR-16] a draft with no revisions still exports, and says so by being empty', () => {
    // The positive control for the shape: an empty record must still produce a
    // valid document rather than throwing, because a draft is a real record.
    const draft: EvidenceTrail = { ...TRAIL, revisions: [], audit: [], submittedAt: null }
    const doc = toExportDocument(draft)
    expect(doc.revisions).toEqual([])
    expect(doc.audit).toEqual([])
    expect(doc.decision.submitted_at).toBeNull()
    expect(doc.scenario_version.id).toBe(TRAIL.scenario.scenarioVersionId)
  })
})
