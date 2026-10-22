/**
 * Unit: the submission validation boundary.      [FR-03] [FR-05] [FR-04] [FR-12]
 *
 * Implementation plan task 3.8. Pure logic, no database and no network.
 *
 * ── THE ACCEPT HALF IS THE POSITIVE CONTROL ─────────────────────────────────
 *
 * A validator whose body is `return { ok: false }` passes EVERY rejection case
 * in this file. So each boundary is asserted in both directions in the same
 * test: 0 and 100 accepted beside -1 and 101 rejected, a complete submission
 * accepted beside each incomplete one rejected. A rejection suite on its own
 * would be the 56-gates-that-exercise-nothing failure again (ADR-0009).
 *
 * ── THE KEY SET IS ASSERTED BY DEEP EQUALITY, NOT BY SPOT CHECKS ────────────
 *
 * `toEqual` on the whole ordered list, so a field DROPPED from the form is a
 * failure rather than a silently optional input, and a field ADDED without being
 * thought about is a failure too. The expected list below is restated from
 * `docs/ui-ux-design.md` §6.1 and PRD §5.2 rather than imported from the module,
 * because a test that imports the thing it is checking and compares it to itself
 * passes under every mutation.
 */
import { describe, expect, it } from 'vitest'
import {
  DECISION_FIELD_ORDER,
  DECISION_GROUPS,
  REVISION_COLUMN_FIELDS,
  decisionSubmissionSchema,
  parseSubmission,
  toRevisionPayload,
} from '../../../src/lib/validation/decision'

/**
 * The fourteen, restated from the approved design in presentation order.
 * `docs/ui-ux-design.md` §6.1 groups, read top to bottom.
 */
const EXPECTED_ORDER = [
  'objective',
  'assumptions',
  'unknowns',
  'alternatives',
  'recommended_action',
  'rationale',
  'lawful_authority',
  'resources',
  'stakeholders',
  'risks',
  'confidence',
  'expected_outcomes',
  'indicators',
  'time_horizon',
] as const

/**
 * PRD §5.2's ten items, mapped to field names. This is the list FR-03 and FR-05
 * are accepted against, so it is asserted separately from the fourteen: the
 * design may expand the form, but it may not quietly drop something the PRD
 * requires.
 */
const PRD_5_2_REQUIRED = [
  'objective',
  'alternatives',
  'recommended_action',
  'lawful_authority',
  'resources',
  'stakeholders',
  'risks',
  'unknowns',
  'confidence',
  'expected_outcomes',
  'indicators',
] as const

/** A submission with every field present and valid. */
function complete(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {}
  for (const field of EXPECTED_ORDER) {
    base[field] = field === 'confidence' ? 60 : `a written answer for ${field}`
  }
  return { ...base, ...overrides }
}

describe('the field set', () => {
  it('[FR-03] the schema holds exactly the fourteen design fields, in order', () => {
    expect(DECISION_FIELD_ORDER).toEqual(EXPECTED_ORDER)
    // And the schema itself agrees with the exported order, so the order cannot
    // be a decorative list beside a differently-shaped schema.
    expect(Object.keys(decisionSubmissionSchema.shape)).toEqual([...EXPECTED_ORDER])
  })

  it('[FR-03] [FR-05] every PRD §5.2 required field is present in the schema', () => {
    const keys = new Set(Object.keys(decisionSubmissionSchema.shape))
    const missing = PRD_5_2_REQUIRED.filter((f) => !keys.has(f))
    expect(missing, 'PRD §5.2 fields absent from the validation boundary').toEqual([])
  })

  it('[FR-03] the four groups cover every field exactly once', () => {
    const grouped = DECISION_GROUPS.flatMap((g) => [...g.fields])
    // Sorted comparison for coverage, plus a length check for duplicates: a
    // field listed in two groups would render twice and still satisfy a set
    // comparison on its own.
    expect([...grouped].sort()).toEqual([...EXPECTED_ORDER].sort())
    expect(grouped.length, 'a field appears in more than one group').toBe(EXPECTED_ORDER.length)
  })
})

describe('confidence — the boundary, both directions', () => {
  it('[FR-05] accepts 0 and 100, and rejects -1, 101 and a non-integer', () => {
    // Accept half FIRST: this is what makes the rejections below meaningful.
    for (const value of [0, 100, 1, 50, 99]) {
      const result = parseSubmission(complete({ confidence: value }))
      expect(result.ok, `confidence ${value} must be accepted`).toBe(true)
    }
    for (const value of [-1, 101, 50.5, -0.5, 100.5]) {
      const result = parseSubmission(complete({ confidence: value }))
      expect(result.ok, `confidence ${value} must be rejected`).toBe(false)
      if (!result.ok) expect(result.errors.confidence).toBeDefined()
    }
  })

  it('[FR-05] rejects a numeric string, which an unvalidated form would submit', () => {
    // A number input yields a string in the DOM. If this passed, `p_confidence`
    // would reach a `smallint` parameter as text and the failure would surface
    // at the database as a type error rather than at the field as a message.
    const result = parseSubmission(complete({ confidence: '60' }))
    expect(result.ok).toBe(false)
  })

  it('[FR-05] rejects a missing confidence rather than defaulting it', () => {
    const input = complete()
    delete input['confidence']
    expect(parseSubmission(input).ok).toBe(false)
  })
})

describe('required prose fields', () => {
  it('[FR-03] [FR-05] rejects each field in turn when absent, and accepts the complete form', () => {
    expect(parseSubmission(complete()).ok, 'the complete submission is the control').toBe(true)

    for (const field of EXPECTED_ORDER) {
      const input = complete()
      delete input[field]
      const result = parseSubmission(input)
      expect(result.ok, `a submission missing ${field} must be rejected`).toBe(false)
      if (!result.ok) {
        expect(result.errors[field], `the error must name ${field}`).toBeDefined()
      }
    }
  })

  it('[FR-05] rejects an absent forecast, horizon and rationale specifically', () => {
    // Named explicitly because these three are also NOT NULL columns on
    // decision_revision: the plan requires each to be refused at this boundary
    // AND at the database, and this is the boundary half.
    for (const field of ['expected_outcomes', 'time_horizon', 'rationale'] as const) {
      const input = complete()
      delete input[field]
      expect(parseSubmission(input).ok, `${field} must be required here too`).toBe(false)
    }
  })

  it('[FR-03] rejects whitespace-only prose, which is not an answer', () => {
    for (const blank of ['', '   ', '\n\t ', ' ']) {
      const result = parseSubmission(complete({ objective: blank }))
      expect(result.ok, `objective ${JSON.stringify(blank)} must be rejected`).toBe(false)
    }
  })

  it('[FR-03] trims accepted prose, so trailing whitespace cannot make two revisions differ', () => {
    const result = parseSubmission(complete({ objective: '  contain the outbreak  ' }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.objective).toBe('contain the outbreak')
  })
})

describe('firstInvalid — presentation order, not issue order', () => {
  /**
   * The design requires focus to move to the FIRST invalid field
   * (`docs/ui-ux-design.md` §6.5). "First" must be defined against the
   * presentation order, not against whatever order Zod reports issues in. This
   * invalidates a LATE field and an EARLY one together and asserts the early one
   * wins — an implementation that returned `issues[0]` passes only by luck.
   */
  it('[FR-03] reports the earliest invalid field by presentation order', () => {
    const input = complete({ time_horizon: '', assumptions: '' })
    const result = parseSubmission(input)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.firstInvalid).toBe('assumptions')
      expect(Object.keys(result.errors).sort()).toEqual(['assumptions', 'time_horizon'])
    }
  })

  it('[FR-03] a non-object input still yields a focusable field and a message', () => {
    for (const value of [null, undefined, 'a string', 42, []]) {
      const result = parseSubmission(value)
      expect(result.ok, `${String(value)} must be rejected`).toBe(false)
      if (!result.ok) {
        expect(DECISION_FIELD_ORDER).toContain(result.firstInvalid)
        expect(result.errors[result.firstInvalid]).toBeDefined()
      }
    }
  })
})

describe('toRevisionPayload — the split onto the RPC', () => {
  it('[FR-04] [FR-12] maps the four column fields and puts the other ten in content', () => {
    const result = parseSubmission(complete({ confidence: 73 }))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const payload = toRevisionPayload(result.value)

    expect(payload.p_confidence).toBe(73)
    expect(payload.p_forecast).toBe('a written answer for expected_outcomes')
    expect(payload.p_horizon).toBe('a written answer for time_horizon')
    expect(payload.p_rationale).toBe('a written answer for rationale')

    // Deep equality on the content key set: exactly the fourteen less the four
    // columns. A field dropped on the way to the database is a lost answer, and
    // a duplicated one would be stored twice under two names.
    const expectedContentKeys = EXPECTED_ORDER.filter(
      (f) => !(REVISION_COLUMN_FIELDS as readonly string[]).includes(f),
    )
    expect(Object.keys(payload.p_content).sort()).toEqual([...expectedContentKeys].sort())
    expect(Object.keys(payload.p_content).length).toBe(10)
  })

  it('[FR-04] the column fields are NOT also duplicated into content', () => {
    const result = parseSubmission(complete())
    if (!result.ok) throw new Error('fixture must be valid')
    const payload = toRevisionPayload(result.value)
    for (const field of REVISION_COLUMN_FIELDS) {
      expect(
        Object.keys(payload.p_content),
        `${field} is a column and must not also sit in content`,
      ).not.toContain(field)
    }
  })

  it('[FR-04] content carries the trimmed values, matching what was validated', () => {
    const result = parseSubmission(complete({ objective: '  stated plainly  ' }))
    if (!result.ok) throw new Error('fixture must be valid')
    const payload = toRevisionPayload(result.value)
    expect(payload.p_content['objective']).toBe('stated plainly')
  })
})
