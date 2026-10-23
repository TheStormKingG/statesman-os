/**
 * Reading published scenario content: the brief, its source register and its
 * claim register.
 *
 * ── CONTENT IS UNTRUSTED INPUT, AND THAT IS NOT A FORMALITY HERE ────────────
 *
 * Canon §6 classes scenario text and source excerpts as untrusted input, and
 * CLAUDE.md §8 makes render-time escaping load-bearing rather than defence in
 * depth, because the `freeText` factory does not reject HTML metacharacters.
 *
 * Two structural consequences, both visible below:
 *
 *   * every value this module returns is a `string`, a `number`, a `boolean` or
 *     an array of those, parsed by zod. Nothing is handed back as unvalidated
 *     `Json`, so a caller cannot accidentally render a nested object;
 *   * nothing in this file or its callers may use `dangerouslySetInnerHTML`.
 *     React escapes a string child, so a scenario containing `<script>` renders
 *     as that text. That is the whole defence and it only holds while the text
 *     stays a text child.
 *
 * ── WHY THE JSONB IS PARSED AND NOT TRUSTED ─────────────────────────────────
 *
 * `scenario_version.content` is authored by a migration, so it is "our" data in
 * the sense that no user wrote it. It is still parsed, for a reason that has
 * nothing to do with malice: the seeded case carries about thirty top-level
 * keys and the UI reads twelve of them. A typo in a key name would otherwise
 * render as a blank region on a screen whose entire purpose is to present a
 * case faithfully, and a brief that silently omits the constraints is worse
 * than one that refuses to load.
 *
 * `.passthrough()` is NOT used on the keys we read: an unexpected SHAPE must
 * fail. Unknown ADDITIONAL keys are ignored, because the content deliberately
 * carries editorial material the UI has no business rendering.
 */

import { z } from 'zod'
import { supabase } from './client'
import { mapPostgrestError, singleRowOutcome } from './errors'
import type { RowOutcome } from './errors'

/* ------------------------------------------------------------------ *
 * The content schema
 * ------------------------------------------------------------------ */

const nonEmpty = z.string().trim().min(1)
const lines = z.array(nonEmpty).min(1)

const contentSchema = z.object({
  title: nonEmpty,
  sector: nonEmpty,
  issue_statement: nonEmpty,
  learning_objective: nonEmpty,
  required_decision: lines,
  available_resources: lines,
  data_gaps: lines,
  jurisdiction: z.object({ name: nonEmpty }),
  fiction_notice: z.object({
    is_fiction: z.boolean(),
    statement: nonEmpty,
    as_of_date: nonEmpty,
  }),
  user_role: z.object({
    title: nonEmpty,
    authority_in_scenario: nonEmpty,
    explicit_limits: lines,
  }),
  decision_window: z.object({
    window_hours: z.number().int().positive(),
    in_world_deadline: nonEmpty,
    interim_milestone: nonEmpty,
    estimated_user_effort_minutes: z.number().int().positive(),
  }),
})

/* ------------------------------------------------------------------ *
 * What the screens receive
 * ------------------------------------------------------------------ */

export interface ScenarioBrief {
  readonly scenarioVersionId: string
  readonly scenarioId: string
  readonly sector: string
  readonly jurisdiction: string
  readonly title: string
  /**
   * From the COLUMN, not from the jsonb.
   *
   * `scenario_version.is_fiction` is `boolean not null` and M15 exists to prove
   * that NOT NULL cannot be dropped, so the column is the authority. The jsonb
   * carries its own `fiction_notice.is_fiction`, and the two could disagree;
   * `fictionNoticeAgrees` below reports whether they do rather than picking a
   * winner silently.
   */
  readonly isFiction: boolean
  readonly fictionNoticeAgrees: boolean
  readonly fictionStatement: string
  /** From the COLUMN. The in-world date the jsonb states is reported separately. */
  readonly asOfDate: string
  readonly issueStatement: string
  readonly learningObjective: string
  readonly requiredDecision: readonly string[]
  readonly availableResources: readonly string[]
  readonly dataGaps: readonly string[]
  readonly roleTitle: string
  readonly roleAuthority: string
  readonly roleLimits: readonly string[]
  readonly windowHours: number
  readonly inWorldDeadline: string
  readonly interimMilestone: string
  readonly estimatedEffortMinutes: number
}

export interface SourceRef {
  readonly id: string
  readonly title: string
  readonly publisher: string
  readonly uri: string | null
  readonly publishedDate: string | null
  readonly retrievedDate: string | null
  readonly kind: string
}

export interface ClaimRef {
  readonly claimId: string
  readonly sourceId: string
  readonly claimText: string
  readonly confidence: string
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/**
 * The one case Today presents.
 *
 * ── `published_at is not null` IS A PRODUCT REQUIREMENT, NOT A FILTER ───────
 *
 * MEASURED on the live project: the policy on `public.scenario_version` is
 * `using (auth.uid() is not null)` with NO published predicate, so any signed-in
 * user can read UNPUBLISHED content — including the rule-9b sentinel version and
 * any draft case. NFR-10 and the editorial process in PRD §8.2 both require a
 * case to be published before it is practised against, and
 * `scenario_version_published_has_rubric` makes publication the point at which a
 * rubric is guaranteed. An unpublished case has no rubric, so a challenge
 * against it could not be scored.
 *
 * `20261022170000` records why this is not a database constraint: the sentinel
 * version is deliberately unpublished, so a constraint would reject the sentinel
 * graph, and a cross-table rule would need a trigger, which is a new enforcement
 * mechanism and therefore an ADR. So it is enforced here, and the fact that the
 * database would permit otherwise is written down rather than left to be found.
 *
 * ── ORDERING ────────────────────────────────────────────────────────────────
 *
 * Most recently published first, then `version_no` descending as a tiebreaker,
 * because `published_at` is a timestamp a migration sets and two versions
 * published in one transaction share it exactly. Without the tiebreaker the
 * "one case" Today shows would be whichever row the planner happened to return.
 */
export async function loadPublishedScenario(): Promise<RowOutcome<ScenarioBrief>> {
  const { data, error } = await supabase
    .from('scenario_version')
    .select(
      'id, scenario_id, version_no, content, is_fiction, as_of_date, published_at',
    )
    .not('published_at', 'is', null)
    .order('published_at', { ascending: false })
    .order('version_no', { ascending: false })
    .limit(1)

  if (error !== null) throw mapPostgrestError(error)

  // `data` is non-null here: supabase-js's return type is discriminated on `error`,
  // so the throw above narrows it. A `?? []` fallback would be unreachable.
  const outcome = singleRowOutcome(data)
  if (outcome.kind === 'empty') return outcome

  const row = outcome.row
  const parsed = contentSchema.safeParse(row.content)
  if (!parsed.success) {
    // A brief that silently omits a section is worse than one that refuses to
    // load: the screen's whole job is to present the case faithfully.
    throw new Error(
      `scenario_version ${row.id} has content this build cannot read: ` +
        parsed.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; '),
    )
  }
  const c = parsed.data

  return {
    kind: 'row',
    row: {
      scenarioVersionId: row.id,
      scenarioId: row.scenario_id,
      sector: c.sector,
      jurisdiction: c.jurisdiction.name,
      title: c.title,
      isFiction: row.is_fiction,
      fictionNoticeAgrees: c.fiction_notice.is_fiction === row.is_fiction,
      fictionStatement: c.fiction_notice.statement,
      asOfDate: row.as_of_date,
      issueStatement: c.issue_statement,
      learningObjective: c.learning_objective,
      requiredDecision: c.required_decision,
      availableResources: c.available_resources,
      dataGaps: c.data_gaps,
      roleTitle: c.user_role.title,
      roleAuthority: c.user_role.authority_in_scenario,
      roleLimits: c.user_role.explicit_limits,
      windowHours: c.decision_window.window_hours,
      inWorldDeadline: c.decision_window.in_world_deadline,
      interimMilestone: c.decision_window.interim_milestone,
      estimatedEffortMinutes: c.decision_window.estimated_user_effort_minutes,
    },
  }
}

/**
 * The source register for a version, read from `public.source` rather than from
 * the jsonb's `source_register`.
 *
 * The two mirror each other and the TABLE is the one with constraints on it:
 * `source_factual_is_traceable` requires a non-fictional source to carry a uri
 * and a retrieved date (M17 proves that check is load-bearing), and
 * `scenario_claim_source_fk` is a COMPOSITE key that pins a claim's source to
 * the same version (M16 proves that one). None of that applies to a jsonb array.
 * Reading the jsonb copy would be reading the unconstrained mirror of the
 * constrained thing — which is exactly how FR-02 traceability becomes decorative.
 */
export async function loadSources(scenarioVersionId: string): Promise<readonly SourceRef[]> {
  const { data, error } = await supabase
    .from('source')
    .select('id, title, publisher, uri, published_date, retrieved_date, kind')
    .eq('scenario_version_id', scenarioVersionId)
    .order('title', { ascending: true })

  if (error !== null) throw mapPostgrestError(error)
  return data.map((r) => ({
    id: r.id,
    title: r.title,
    publisher: r.publisher,
    uri: r.uri,
    publishedDate: r.published_date,
    retrievedDate: r.retrieved_date,
    kind: r.kind,
  }))
}

/** The claim register: what the case asserts, and which source each rests on. */
export async function loadClaims(scenarioVersionId: string): Promise<readonly ClaimRef[]> {
  const { data, error } = await supabase
    .from('scenario_claim')
    .select('claim_id, source_id, claim_text, confidence')
    .eq('scenario_version_id', scenarioVersionId)
    .order('claim_id', { ascending: true })

  if (error !== null) throw mapPostgrestError(error)
  return data.map((r) => ({
    claimId: r.claim_id,
    sourceId: r.source_id,
    claimText: r.claim_text,
    confidence: r.confidence,
  }))
}
