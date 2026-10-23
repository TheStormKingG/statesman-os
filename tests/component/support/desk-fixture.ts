/**
 * A `Loaded` for the Desk, in the one state the lock is about: an OPEN draft
 * whose fields are already complete.
 *
 * The fields are pre-filled rather than typed in by the test because the
 * assertion under test is about what happens AFTER a successful submission, and
 * `parseSubmission` has to pass to get there. Typing fourteen fields through the
 * DOM would add fourteen ways for the test to fail for a reason that is not the
 * one it is measuring.
 *
 * Every string says TEST FIXTURE. Nothing here is a real jurisdiction, body or
 * figure: the Guyana editorial boundary in CLAUDE.md §2 applies to fixtures too.
 */
import type { DecisionRecord, DraftFields, RevisionRecord } from '../../../src/lib/supabase/decisions'
import type { ClaimRef, ScenarioBrief, SourceRef } from '../../../src/lib/supabase/scenarios'
import { DECISION_FIELD_ORDER } from '../../../src/lib/validation/decision'

const SCENARIO_VERSION_ID = '00000000-0000-0000-0000-0000000900ff'

/** Complete and valid: every field non-empty, `confidence` inside 0-100. */
export function completeFields(): DraftFields {
  const out: Record<string, string> = {}
  for (const name of DECISION_FIELD_ORDER) {
    out[name] = name === 'confidence' ? '65' : `TEST FIXTURE. Content for ${name}.`
  }
  return out
}

export function brief(): ScenarioBrief {
  return {
    scenarioVersionId: SCENARIO_VERSION_ID,
    scenarioId: '00000000-0000-0000-0000-0000000800ff',
    sector: 'TEST FIXTURE SECTOR',
    jurisdiction: 'TEST FIXTURE JURISDICTION',
    title: 'TEST FIXTURE. A case that exists only in this suite',
    isFiction: true,
    fictionNoticeAgrees: true,
    fictionStatement: 'TEST FIXTURE. Invented for a component test. Resembles nothing.',
    asOfDate: '2026-01-01',
    issueStatement: 'TEST FIXTURE issue statement.',
    learningObjective: 'TEST FIXTURE learning objective.',
    requiredDecision: ['TEST FIXTURE required decision.'],
    availableResources: ['TEST FIXTURE resource.'],
    dataGaps: ['TEST FIXTURE data gap.'],
    roleTitle: 'TEST FIXTURE role',
    roleAuthority: 'TEST FIXTURE authority.',
    roleLimits: ['TEST FIXTURE limit.'],
    windowHours: 72,
    inWorldDeadline: '2026-01-04T07:00:00',
    interimMilestone: 'TEST FIXTURE milestone.',
    estimatedEffortMinutes: 45,
  }
}

/** An open draft: `submittedAt` null, so `frozen` is false. */
export function openDraft(): DecisionRecord {
  return {
    id: '00000000-0000-0000-0000-0000000d00ff',
    scenarioVersionId: SCENARIO_VERSION_ID,
    state: 'draft',
    submittedAt: null,
    draftUpdatedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    fields: completeFields(),
    draftReadable: true,
  }
}

export function sources(): readonly SourceRef[] {
  return [
    {
      id: '00000000-0000-0000-0000-0000000500ff',
      title: 'TEST FIXTURE source',
      publisher: 'TEST FIXTURE publisher',
      uri: null,
      publishedDate: null,
      retrievedDate: null,
      kind: 'fictional',
    },
  ]
}

export function claims(): readonly ClaimRef[] {
  return [
    {
      claimId: '00000000-0000-0000-0000-0000000c00ff',
      sourceId: '00000000-0000-0000-0000-0000000500ff',
      claimText: 'TEST FIXTURE claim.',
      confidence: 'stated',
    },
  ]
}

export function revisions(): readonly RevisionRecord[] {
  return []
}
