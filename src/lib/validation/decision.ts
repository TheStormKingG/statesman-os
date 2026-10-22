/**
 * The submission validation boundary. ONE schema module, and it is the only
 * place the shape of a decision submission is written down.
 *
 * ── WHY THIS EXISTS WHEN THE DATABASE ALREADY CHECKS ────────────────────────
 *
 * `decision_revision` declares `confidence smallint not null check (confidence
 * between 0 and 100)`, `forecast text not null`, `horizon text not null` and
 * `rationale text not null`. Those checks stay exactly as they are. They are an
 * INDEPENDENT BACKSTOP, not a thing this module replaces.
 *
 * Two layers is the point, and they are not redundant because they fail
 * differently:
 *
 *   * this schema gives the user a field-level error before anything is sent,
 *     which a NOT NULL violation cannot do — it names a column, not a question;
 *   * the column makes the bad row unwritable even if a caller bypasses this
 *     module entirely, which on a static site is not hypothetical: the
 *     publishable key is in the bundle and anyone can POST to PostgREST by hand.
 *
 * Either alone is a single point of failure. Deleting one because the other
 * exists is the mistake this comment is here to prevent.
 *
 * ── THE FIELD LIST, AND ITS RELATIONSHIP TO PRD §5.2 ────────────────────────
 *
 * PRD §5.2 specifies ten items in order: objective, options considered,
 * recommended action, lawful authority to verify, resources/budget, stakeholders
 * and equity, risks, uncertainty, confidence (0-100%), expected outcomes and
 * indicators.
 *
 * `docs/ui-ux-design.md` §6.1 — the approved design — carries FOURTEEN fields in
 * four groups. It is an expansion of the ten, not a departure from them, and
 * every one of the ten is present:
 *
 *   PRD §5.2 item                     field here
 *   --------------------------------- ---------------------------------------
 *   objective                         objective
 *   options considered                alternatives
 *   recommended action                recommended_action
 *   lawful authority to verify        lawful_authority
 *   resources / budget                resources
 *   stakeholders and equity           stakeholders
 *   risks                             risks
 *   uncertainty                       unknowns
 *   confidence (0-100%)               confidence
 *   expected outcomes and indicators  expected_outcomes  +  indicators   (split)
 *
 * Three fields have no PRD §5.2 counterpart and are additions:
 *
 *   assumptions     separated from `unknowns` because an assumption is a thing
 *                   you have decided to treat as true, and an unknown is a thing
 *                   you have not. Collapsing them loses the distinction the
 *                   challenge lenses are supposed to interrogate (FR-07).
 *   rationale       required by FR-04/FR-12 for a revision, and already a NOT
 *                   NULL column on `decision_revision`, so it is a field whether
 *                   or not the form shows it.
 *   time_horizon    FR-05 requires "a stated expected outcome AND timeframe".
 *                   `horizon` is already its own NOT NULL column, so the
 *                   timeframe cannot live inside the outcome prose.
 *
 * This expansion is recorded as D15 in `docs/decisions.md` rather than applied
 * silently, because which fields are REQUIRED is what FR-03 and FR-05 are
 * accepted against.
 *
 * ── WHAT IS DELIBERATELY NOT VALIDATED ──────────────────────────────────────
 *
 * No minimum length on any prose field beyond "not blank". PRD §5.2 and the FR
 * table imply no bound, so a 40-character or 200-word minimum would be a
 * requirement this module invented. Canon §9 forbids inventing a metric; a
 * threshold with no source is passed, or failed, at whoever's discretion wrote
 * it. If a bound is wanted later it arrives with a requirement to cite.
 */

import { z } from 'zod'

/* ------------------------------------------------------------------ *
 * The field order
 * ------------------------------------------------------------------ */

/**
 * The fourteen fields, in the order they are presented and validated.
 *
 * Exported as a `const` tuple so that the ORDER is a value a test can assert,
 * not a property of an object literal that a reader has to eyeball. Object key
 * order is observable in JavaScript but it is not something a reviewer should
 * have to rely on noticing.
 */
export const DECISION_FIELD_ORDER = [
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

export type DecisionFieldName = (typeof DECISION_FIELD_ORDER)[number]

/**
 * The four groups of `docs/ui-ux-design.md` §6.1. The Desk renders from this, so
 * a field added to the schema and not to a group is a field with nowhere to be
 * typed — which the group-coverage test turns into a failure rather than an
 * invisible omission.
 */
export const DECISION_GROUPS = [
  { id: 'problem', label: 'The problem', fields: ['objective', 'assumptions', 'unknowns'] },
  { id: 'options', label: 'The options', fields: ['alternatives', 'recommended_action', 'rationale'] },
  {
    id: 'means',
    label: 'The authority and the means',
    fields: ['lawful_authority', 'resources', 'stakeholders'],
  },
  {
    id: 'exposure',
    label: 'The exposure',
    fields: ['risks', 'confidence', 'expected_outcomes', 'indicators', 'time_horizon'],
  },
] as const satisfies readonly {
  readonly id: string
  readonly label: string
  readonly fields: readonly DecisionFieldName[]
}[]

/* ------------------------------------------------------------------ *
 * The schema
 * ------------------------------------------------------------------ */

/**
 * A prose answer: present, and not whitespace.
 *
 * `.trim()` BEFORE the length check, so a field holding only spaces is rejected
 * rather than stored as a value that renders as an empty panel. The transform
 * also means the value that reaches the database is the trimmed one, so trailing
 * whitespace cannot make two otherwise identical revisions differ.
 */
const prose = z
  .string({ message: 'This field is required.' })
  .trim()
  .min(1, { message: 'This field is required.' })

/**
 * Confidence: an integer from 0 to 100 inclusive.
 *
 * `.int()` is load-bearing and is tested at `50.5`. FR-05 says "0-100%", and the
 * column is `smallint`, so a fractional value is not a stricter answer — it is a
 * value PostgreSQL will silently ROUND. 50.5 arriving as 51 would be the
 * application changing a number the user chose, which is worse than refusing it.
 *
 * Both endpoints are ACCEPTED. 0 means "I do not back this at all" and 100 means
 * "I am certain", and both are real answers a person may give; a validator that
 * rejected them would be an opinion about confidence disguised as a bound.
 */
const confidence = z
  .number({ message: 'Enter a whole number from 0 to 100.' })
  .int({ message: 'Confidence must be a whole number.' })
  .min(0, { message: 'Confidence cannot be below 0.' })
  .max(100, { message: 'Confidence cannot be above 100.' })

export const decisionSubmissionSchema = z.object({
  objective: prose,
  assumptions: prose,
  unknowns: prose,
  alternatives: prose,
  recommended_action: prose,
  rationale: prose,
  lawful_authority: prose,
  resources: prose,
  stakeholders: prose,
  risks: prose,
  confidence,
  expected_outcomes: prose,
  indicators: prose,
  time_horizon: prose,
})

export type DecisionSubmission = z.infer<typeof decisionSubmissionSchema>

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

/** A field-level error map, keyed by field name, for rendering beside inputs. */
export type FieldErrors = Partial<Record<DecisionFieldName, string>>

export type ParseResult =
  | { readonly ok: true; readonly value: DecisionSubmission }
  | { readonly ok: false; readonly errors: FieldErrors; readonly firstInvalid: DecisionFieldName }

/**
 * Validate a submission and return either the parsed value or per-field errors.
 *
 * Returns a result rather than throwing, because every caller is a form that has
 * to render the errors; an exception would make the normal case — a person who
 * has not finished typing — an exceptional one.
 *
 * `firstInvalid` is part of the contract, not a convenience: the design requires
 * that a failed submit move focus to the first invalid field in presentation
 * order (`docs/ui-ux-design.md` §6.5), and "first" has to be defined against
 * `DECISION_FIELD_ORDER` rather than against whatever order Zod happens to
 * report issues in.
 */
export function parseSubmission(input: unknown): ParseResult {
  const parsed = decisionSubmissionSchema.safeParse(input)
  if (parsed.success) return { ok: true, value: parsed.data }

  const errors: FieldErrors = {}
  for (const issue of parsed.error.issues) {
    const key = issue.path[0]
    if (typeof key !== 'string') continue
    if (!(DECISION_FIELD_ORDER as readonly string[]).includes(key)) continue
    const field = key as DecisionFieldName
    // First issue per field wins: a field with two problems needs one message,
    // and the first is the one closest to what the user did.
    if (errors[field] === undefined) errors[field] = issue.message
  }

  const firstInvalid = DECISION_FIELD_ORDER.find((f) => errors[f] !== undefined)
  if (firstInvalid === undefined) {
    // Zod rejected the input but no issue named a known field — a non-object
    // input, for instance. Attribute it to the first field so focus still lands
    // somewhere, and keep a message rather than reporting a silent failure.
    const first = DECISION_FIELD_ORDER[0]
    return {
      ok: false,
      errors: { [first]: 'This submission could not be read.' },
      firstInvalid: first,
    }
  }
  return { ok: false, errors, firstInvalid }
}

/* ------------------------------------------------------------------ *
 * Mapping onto the RPC
 * ------------------------------------------------------------------ */

/**
 * The four fields that are COLUMNS on `decision_revision` rather than keys in
 * its `content` jsonb. Declared once, here, because the split has to agree in
 * two places — what goes in `p_content` and what goes in the named parameters —
 * and two hand-maintained lists would drift.
 */
export const REVISION_COLUMN_FIELDS = [
  'confidence',
  'expected_outcomes',
  'time_horizon',
  'rationale',
] as const satisfies readonly DecisionFieldName[]

/** The arguments of `app.submit_decision` / `app.append_revision`, less the ids. */
export interface RevisionPayload {
  readonly p_content: Record<string, string>
  readonly p_confidence: number
  readonly p_forecast: string
  readonly p_horizon: string
  readonly p_rationale: string
}

/**
 * Split a validated submission into the RPC's shape.
 *
 * The parameter NAMES are the SQL parameter names, because PostgREST matches the
 * JSON body keys against them — renaming a SQL parameter is a breaking API
 * change, as `client.ts` records.
 *
 * `p_content` carries the ten remaining fields and is built by EXCLUDING the
 * four column fields rather than by listing the ten. A field added to the schema
 * is then carried into `content` automatically instead of being silently dropped
 * by a list nobody updated.
 */
export function toRevisionPayload(submission: DecisionSubmission): RevisionPayload {
  const content: Record<string, string> = {}
  for (const field of DECISION_FIELD_ORDER) {
    if ((REVISION_COLUMN_FIELDS as readonly string[]).includes(field)) continue
    const value = submission[field]
    // Every non-column field is prose by construction; the guard keeps the type
    // honest rather than asserting it.
    if (typeof value === 'string') content[field] = value
  }
  return {
    p_content: content,
    p_confidence: submission.confidence,
    p_forecast: submission.expected_outcomes,
    p_horizon: submission.time_horizon,
    p_rationale: submission.rationale,
  }
}
