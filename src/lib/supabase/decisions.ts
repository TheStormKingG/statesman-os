/**
 * Drafts, autosave, and the submission that freezes a decision into a revision.
 *
 * ── THE RULE THIS WHOLE FILE IS ORGANISED AROUND ────────────────────────────
 *
 * A row count of zero is never a success signal. On this architecture it is
 * worse than ambiguous: canon §4.4 records that a failing `USING` clause affects
 * zero rows and raises nothing (V7), `errors.ts` records that an empty
 * forced-RLS table does not evaluate its policy at all, and PostgREST reports
 * all three of "denied", "absent" and "nothing matched" as an empty array.
 *
 * So every read here returns `RowOutcome` rather than `T | null`, and every
 * write asserts the number of rows it changed. `saveDraft` returning without
 * error is NOT evidence that anything was written, and the one place that would
 * have been easy to get wrong — autosave, which runs constantly and whose
 * failure is invisible — is the place the assertion matters most. The UI's
 * `Not saved. Your text is still here.` state exists because of this.
 */

import { z } from 'zod'
import { appSchema, supabase } from './client'
import { RowCountError, mapPostgrestError, singleRowOutcome } from './errors'
import type { RowOutcome } from './errors'
import type { DecisionState, Json } from './client'
import { DECISION_FIELD_ORDER, toRevisionPayload } from '../validation/decision'
import type { DecisionFieldName, DecisionSubmission } from '../validation/decision'

/* ------------------------------------------------------------------ *
 * The draft payload
 * ------------------------------------------------------------------ */

/**
 * What a partially written form looks like on disk.
 *
 * `v` is a shape marker, not decoration. `draft_payload` is the one column the
 * client may write, so it is the one place a future change of field names would
 * meet rows written by an older build. A payload with an unrecognised `v` is
 * reported as unreadable rather than coerced, because silently dropping fields
 * from a half-written decision is the exact failure FR-03 ("incomplete drafts
 * may be reopened WITHOUT LOSS") forbids.
 *
 * Every field is optional and every value is a string: a draft is by definition
 * incomplete, and `confidence` is held as the raw text the user typed so that
 * `60abc` survives a reload and can be reported as invalid, rather than being
 * silently discarded by a number parse at save time.
 */
export const DRAFT_PAYLOAD_VERSION = 1

const draftPayloadSchema = z.object({
  v: z.literal(DRAFT_PAYLOAD_VERSION),
  fields: z.record(z.string(), z.string()),
})

export type DraftFields = Partial<Record<DecisionFieldName, string>>

function readDraftFields(payload: Json): { fields: DraftFields; readable: boolean } {
  // `{}` is the column default, so a freshly created draft is empty and readable.
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    if (Object.keys(payload).length === 0) return { fields: {}, readable: true }
  }
  const parsed = draftPayloadSchema.safeParse(payload)
  if (!parsed.success) return { fields: {}, readable: false }

  const fields: DraftFields = {}
  for (const name of DECISION_FIELD_ORDER) {
    const value = parsed.data.fields[name]
    if (typeof value === 'string') fields[name] = value
  }
  return { fields, readable: true }
}

export function encodeDraftPayload(fields: DraftFields): Json {
  const out: Record<string, string> = {}
  for (const name of DECISION_FIELD_ORDER) {
    const value = fields[name]
    if (typeof value === 'string' && value.length > 0) out[name] = value
  }
  return { v: DRAFT_PAYLOAD_VERSION, fields: out }
}

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

export interface DecisionRecord {
  readonly id: string
  readonly scenarioVersionId: string
  readonly state: DecisionState
  readonly submittedAt: string | null
  readonly draftUpdatedAt: string | null
  readonly createdAt: string
  readonly fields: DraftFields
  /**
   * False when `draft_payload` could not be read. The screen must say so rather
   * than render an empty form over a draft that still exists in the database:
   * an empty form invites the user to retype, and the first autosave would then
   * overwrite what was there.
   */
  readonly draftReadable: boolean
}

export interface RevisionRecord {
  readonly id: string
  readonly revisionNo: number
  readonly confidence: number
  readonly forecast: string
  readonly horizon: string
  readonly rationale: string
  readonly content: Json
  readonly createdAt: string
}

const DECISION_COLUMNS =
  'id, scenario_version_id, state, submitted_at, draft_updated_at, created_at, draft_payload'

function toRecord(row: {
  id: string
  scenario_version_id: string
  state: DecisionState
  submitted_at: string | null
  draft_updated_at: string | null
  created_at: string
  draft_payload: Json
}): DecisionRecord {
  const { fields, readable } = readDraftFields(row.draft_payload)
  return {
    id: row.id,
    scenarioVersionId: row.scenario_version_id,
    state: row.state,
    submittedAt: row.submitted_at,
    draftUpdatedAt: row.draft_updated_at,
    createdAt: row.created_at,
    fields,
    draftReadable: readable,
  }
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/**
 * The decision this user most recently started for a case.
 *
 * ── WHY "MOST RECENT" AND NOT "THE OPEN ONE" ────────────────────────────────
 *
 * `decision_one_open_draft_per_scenario` guarantees at most one OPEN draft per
 * user per case, but it deliberately does not restrict submitted ones: a user
 * may practise the same case again later, and FR-04 requires the earlier record
 * to survive that. So a case can have several decisions and exactly one of them
 * can be open.
 *
 * Returning the most recent means the Desk opens the thing the user was last
 * doing, which is either an editable draft or a submitted record it renders
 * read-only. The rejected alternative was to look for the open draft and create
 * one when none was found — which would hide a submitted decision behind a blank
 * form, and silently start a second attempt the user did not ask for.
 */
export async function findLatestDecisionForScenario(
  scenarioVersionId: string,
): Promise<RowOutcome<DecisionRecord>> {
  const { data, error } = await supabase
    .from('decision')
    .select(DECISION_COLUMNS)
    .eq('scenario_version_id', scenarioVersionId)
    .order('created_at', { ascending: false })
    .limit(1)

  if (error !== null) throw mapPostgrestError(error)
  // `data` is non-null here: supabase-js's return type is discriminated on `error`,
  // so the throw above narrows it. A `?? []` fallback would be unreachable.
  const outcome = singleRowOutcome(data)
  return outcome.kind === 'row' ? { kind: 'row', row: toRecord(outcome.row) } : outcome
}

/** Every revision of a decision, oldest first. FR-04: both versions stay visible. */
export async function loadRevisions(decisionId: string): Promise<readonly RevisionRecord[]> {
  const { data, error } = await supabase
    .from('decision_revision')
    .select('id, revision_no, confidence, forecast, horizon, rationale, content, created_at')
    .eq('decision_id', decisionId)
    .order('revision_no', { ascending: true })

  if (error !== null) throw mapPostgrestError(error)
  return data.map((r) => ({
    id: r.id,
    revisionNo: r.revision_no,
    confidence: r.confidence,
    forecast: r.forecast,
    horizon: r.horizon,
    rationale: r.rationale,
    content: r.content,
    createdAt: r.created_at,
  }))
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

/**
 * Start a draft for a case.
 *
 * `user_id` is supplied from the session because the column has no default and
 * `authenticated` holds a plain INSERT. The policy's
 * `with check (user_id = auth.uid())` is what makes that safe: a row naming
 * anyone else is refused with 42501 regardless of what this code sends, which is
 * the same argument `ensureProfile` makes in `auth.ts`.
 *
 * `.select()` is present so the insert RETURNS the row: without it PostgREST
 * answers 201 with no body and this function would have nothing to assert on.
 */
export async function createDraft(
  userId: string,
  scenarioVersionId: string,
): Promise<DecisionRecord> {
  const { data, error } = await supabase
    .from('decision')
    .insert({ user_id: userId, scenario_version_id: scenarioVersionId })
    .select(DECISION_COLUMNS)

  if (error !== null) throw mapPostgrestError(error)
  const rows = data
  if (rows.length !== 1) {
    throw new RowCountError(
      `createDraft expected exactly 1 inserted row, got ${rows.length}. An insert that ` +
        'reports no row is indistinguishable from one the policy refused, so it is not ' +
        'treated as success.',
    )
  }
  const first = rows[0]
  if (first === undefined) throw new RowCountError('createDraft: row 0 was undefined')
  return toRecord(first)
}

/**
 * Autosave.
 *
 * ── THE ROW COUNT IS THE WHOLE POINT ────────────────────────────────────────
 *
 * This runs on blur and on a 10-second idle timer, so it runs constantly and
 * nobody watches it. If a save is scoped away — the draft was submitted and is
 * now frozen, the row belongs to someone else, the id is stale — PostgREST
 * answers `200 []` with no error. Treating that as success is how a user types
 * for twenty minutes into a form that is saving nothing and is told
 * `Draft saved 14:21` the whole time.
 *
 * So the update RETURNS its rows and this function raises unless exactly one
 * came back. The caller renders `Not saved. Your text is still here.`
 *
 * `draft_updated_at` is deliberately NOT written here: it is set by a trigger,
 * and `authenticated` holds `update (draft_payload)` only, so naming it would be
 * refused with 42501. That is the design — a payload-only grant cannot evade the
 * frozen-draft check.
 */
export async function saveDraft(
  decisionId: string,
  fields: DraftFields,
): Promise<{ readonly draftUpdatedAt: string | null }> {
  const { data, error } = await supabase
    .from('decision')
    .update({ draft_payload: encodeDraftPayload(fields) })
    .eq('id', decisionId)
    .select('id, draft_updated_at')

  if (error !== null) throw mapPostgrestError(error)
  const rows = data
  if (rows.length !== 1) {
    throw new RowCountError(
      `saveDraft affected ${rows.length} rows, expected 1. Zero rows here means the write ` +
        'was refused, scoped away, or aimed at a row that is frozen or not yours — ' +
        'PostgREST reports all of those as an empty result with no error, so this is not ' +
        'reported as a save.',
    )
  }
  return { draftUpdatedAt: rows[0]?.draft_updated_at ?? null }
}

/* ------------------------------------------------------------------ *
 * Submission
 * ------------------------------------------------------------------ */

export interface SubmitResult {
  readonly revisionId: string
  readonly revisionNo: number
  /** True when this exact token had already been used: a replay, not a new revision. */
  readonly replayed: boolean
}

const rpcResultSchema = z
  .array(
    z.object({
      revision_id: z.guid(),
      revision_no: z.number().int().positive(),
      replayed: z.boolean(),
    }),
  )
  .length(1)

/**
 * Freeze a decision into revision 1, or append a correction.
 *
 * ── WHY THE CALLER OWNS THE IDEMPOTENCY TOKEN ───────────────────────────────
 *
 * `idempotency_token uuid unique` is what makes a replayed request return the
 * existing revision instead of writing a second one. That only works if a RETRY
 * sends the SAME token, so the token cannot be generated here: a function that
 * minted a fresh uuid per call would make every retry a new submission and the
 * unique constraint would be the only thing standing between a dropped response
 * and a duplicate record. The screen generates it once, when the dialog opens,
 * and reuses it until the submission succeeds.
 *
 * ── WHY THE RESULT IS PARSED ────────────────────────────────────────────────
 *
 * Both functions return `table (...)`, i.e. SETOF, so PostgREST answers with an
 * ARRAY. There is no server-side `get diagnostics` left on this path, so the
 * array's length IS the row-count assertion, and it is made here rather than
 * assumed. `z.guid()` and not `z.uuid()`: zod 4 renamed it, and the old name is
 * the kind of detail that type-checks and fails at runtime.
 */
export async function submitDecision(
  decisionId: string,
  idempotencyToken: string,
  submission: DecisionSubmission,
): Promise<SubmitResult> {
  return callRevisionRpc('submit_decision', decisionId, idempotencyToken, submission)
}

/** FR-04 / FR-12: a correction appends, never overwrites. */
export async function appendRevision(
  decisionId: string,
  idempotencyToken: string,
  submission: DecisionSubmission,
): Promise<SubmitResult> {
  return callRevisionRpc('append_revision', decisionId, idempotencyToken, submission)
}

async function callRevisionRpc(
  fn: 'submit_decision' | 'append_revision',
  decisionId: string,
  idempotencyToken: string,
  submission: DecisionSubmission,
): Promise<SubmitResult> {
  const payload = toRevisionPayload(submission)
  const { data, error } = await appSchema.rpc(fn, {
    p_decision_id: decisionId,
    p_token: idempotencyToken,
    p_content: payload.p_content,
    p_confidence: payload.p_confidence,
    p_forecast: payload.p_forecast,
    p_horizon: payload.p_horizon,
    p_rationale: payload.p_rationale,
  })

  if (error !== null) throw mapPostgrestError(error)

  const parsed = rpcResultSchema.safeParse(data)
  if (!parsed.success) {
    throw new RowCountError(
      `app.${fn} returned a result this build cannot read: ${JSON.stringify(data)}. ` +
        'The array length is the row-count assertion on this path, because there is no ' +
        'server-side get diagnostics left.',
    )
  }
  const row = parsed.data[0]
  if (row === undefined) throw new RowCountError(`app.${fn} returned an empty row`)
  return { revisionId: row.revision_id, revisionNo: row.revision_no, replayed: row.replayed }
}
