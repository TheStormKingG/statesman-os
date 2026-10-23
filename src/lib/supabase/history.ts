/**
 * Screen E — the history list and the evidence trail behind one record.
 *
 * ── THE ONE PROPERTY THIS FILE EXISTS TO GET RIGHT ──────────────────────────
 *
 * `docs/ui-ux-design.md` §9.2: "A submitted decision continues to resolve the
 * scenario version it was written against EVEN AFTER A NEWER VERSION IS
 * PUBLISHED."
 *
 * That is why `loadScenarioVersionById` exists beside
 * `loadPublishedScenario`. The Desk reads the current published case; a trail
 * must read the case the decision is PINNED to, which may by then be
 * superseded, unpublished, or both. Reusing the published-case reader here
 * would silently re-point an old record at today's content, and every claim in
 * the record would then be read against sources the author never saw. The
 * composite FK makes that impossible to get wrong in the DATABASE; this module
 * is where it could still be got wrong in the application.
 *
 * ── WHY THE JOINS ARE DONE IN TYPESCRIPT ────────────────────────────────────
 *
 * PostgREST can embed related rows in one request. The `Database` type here is
 * hand-written and declares `Relationships: NoRelationships`, so an embed would
 * be untyped at exactly the boundary that is supposed to be typed. Three small
 * reads joined in memory are honest about what they cost — N is one user's
 * decisions — and keep every row parsed by a schema it was declared with.
 */

import { z } from 'zod'
import { supabase } from './client'
import { mapPostgrestError, singleRowOutcome } from './errors'
import type { RowOutcome } from './errors'
import type { DecisionState, Json } from './client'
import { loadRevisions } from './decisions'
import type { RevisionRecord } from './decisions'
import { loadSources } from './scenarios'
import type { SourceRef } from './scenarios'

/* ------------------------------------------------------------------ *
 * The minimum this screen needs out of the content jsonb
 * ------------------------------------------------------------------ */

/**
 * Narrow on purpose. The Desk parses twelve keys because it renders a brief;
 * a history row needs a title, and a trail needs a title and the fiction
 * notice. Parsing more here would make an old record unreadable because a key
 * the list never shows had changed shape.
 */
const titleOnly = z.object({ title: z.string().trim().min(1) })
const trailContent = z.object({
  title: z.string().trim().min(1),
  fiction_notice: z.object({ statement: z.string().trim().min(1) }).optional(),
})

function readTitle(content: Json): string {
  const parsed = titleOnly.safeParse(content)
  // A record whose title cannot be read still has to be listed: it is the
  // user's own work and hiding it would be worse than showing it unnamed.
  return parsed.success ? parsed.data.title : '(this case has no readable title)'
}

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

export interface HistoryRow {
  readonly decisionId: string
  readonly scenarioVersionId: string
  readonly title: string
  readonly sector: string
  readonly jurisdiction: string
  readonly state: DecisionState
  readonly createdAt: string
  readonly submittedAt: string | null
  /** From the LATEST revision. Null while a decision is still a draft. */
  readonly confidence: number | null
  readonly revisionCount: number
}

export interface PinnedScenario {
  readonly scenarioVersionId: string
  readonly title: string
  readonly sector: string
  readonly jurisdiction: string
  readonly versionNo: number
  readonly asOfDate: string
  readonly isFiction: boolean
  readonly fictionStatement: string | undefined
  /**
   * Null when the pinned version was never published, or has been superseded
   * and unpublished since. Reported rather than hidden: a record written
   * against an unpublished case is a fact about the record.
   */
  readonly publishedAt: string | null
  /** True when a LATER version of the same scenario has been published since. */
  readonly supersededBy: number | null
}

export interface AuditRow {
  readonly id: string
  readonly action: string
  readonly actorUserId: string | null
  readonly detail: Json
  readonly occurredAt: string
}

export interface EvidenceTrail {
  readonly decisionId: string
  readonly state: DecisionState
  readonly createdAt: string
  readonly submittedAt: string | null
  readonly scenario: PinnedScenario
  readonly sources: readonly SourceRef[]
  readonly revisions: readonly RevisionRecord[]
  readonly audit: readonly AuditRow[]
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/**
 * Every decision this user owns, newest first.
 *
 * No `user_id` predicate, deliberately: the tenancy policy IS the filter, and
 * adding one here would make the policy untested by this path — if the policy
 * were dropped, a client-side predicate would keep the screen looking correct
 * while every other user's rows became reachable through any other query.
 */
export async function loadHistory(): Promise<readonly HistoryRow[]> {
  const { data: decisions, error } = await supabase
    .from('decision')
    .select('id, scenario_version_id, state, created_at, submitted_at')
    .order('created_at', { ascending: false })
  if (error !== null) throw mapPostgrestError(error)
  if (decisions.length === 0) return []

  const versionIds = [...new Set(decisions.map((d) => d.scenario_version_id))]
  const { data: versions, error: vErr } = await supabase
    .from('scenario_version')
    .select('id, scenario_id, content')
    .in('id', versionIds)
  if (vErr !== null) throw mapPostgrestError(vErr)

  const scenarioIds = [...new Set(versions.map((v) => v.scenario_id))]
  const { data: scenarios, error: sErr } = await supabase
    .from('scenario')
    .select('id, sector, jurisdiction')
    .in('id', scenarioIds)
  if (sErr !== null) throw mapPostgrestError(sErr)

  const { data: revisions, error: rErr } = await supabase
    .from('decision_revision')
    .select('decision_id, revision_no, confidence')
    .order('revision_no', { ascending: true })
  if (rErr !== null) throw mapPostgrestError(rErr)

  const versionById = new Map(versions.map((v) => [v.id, v]))
  const scenarioById = new Map(scenarios.map((s) => [s.id, s]))
  const latestByDecision = new Map<string, { revision_no: number; confidence: number }>()
  let count = new Map<string, number>()
  for (const r of revisions) {
    count = count.set(r.decision_id, (count.get(r.decision_id) ?? 0) + 1)
    const seen = latestByDecision.get(r.decision_id)
    if (seen === undefined || r.revision_no > seen.revision_no) {
      latestByDecision.set(r.decision_id, { revision_no: r.revision_no, confidence: r.confidence })
    }
  }

  return decisions.map((d) => {
    const version = versionById.get(d.scenario_version_id)
    const scenario = version === undefined ? undefined : scenarioById.get(version.scenario_id)
    const latest = latestByDecision.get(d.id)
    return {
      decisionId: d.id,
      scenarioVersionId: d.scenario_version_id,
      // A missing case row is reported in the cell rather than defaulted to a
      // plausible-looking blank: it would mean the FK's target is unreadable,
      // which is a fault worth seeing.
      title: version === undefined ? '(case not readable)' : readTitle(version.content),
      sector: scenario?.sector ?? '(unknown)',
      jurisdiction: scenario?.jurisdiction ?? '(unknown)',
      state: d.state,
      createdAt: d.created_at,
      submittedAt: d.submitted_at,
      confidence: latest?.confidence ?? null,
      revisionCount: count.get(d.id) ?? 0,
    }
  })
}

/**
 * The scenario version a record is PINNED to, by id, whatever its publication
 * state. See this file's header: this is not `loadPublishedScenario`.
 */
export async function loadScenarioVersionById(
  scenarioVersionId: string,
): Promise<RowOutcome<PinnedScenario>> {
  const { data, error } = await supabase
    .from('scenario_version')
    .select('id, scenario_id, version_no, content, is_fiction, as_of_date, published_at')
    .eq('id', scenarioVersionId)
    .limit(1)
  if (error !== null) throw mapPostgrestError(error)

  const outcome = singleRowOutcome(data)
  if (outcome.kind === 'empty') return outcome
  const v = outcome.row

  const { data: scenarios, error: sErr } = await supabase
    .from('scenario')
    .select('id, sector, jurisdiction')
    .eq('id', v.scenario_id)
    .limit(1)
  if (sErr !== null) throw mapPostgrestError(sErr)
  const s = scenarios[0]

  // Has a LATER version of the same scenario been published since? The record
  // still resolves to ITS version; this only tells the reader that the case has
  // moved on, which is a fact about the record's context, not about the record.
  const { data: later, error: lErr } = await supabase
    .from('scenario_version')
    .select('version_no')
    .eq('scenario_id', v.scenario_id)
    .gt('version_no', v.version_no)
    .not('published_at', 'is', null)
    .order('version_no', { ascending: false })
    .limit(1)
  if (lErr !== null) throw mapPostgrestError(lErr)

  const parsed = trailContent.safeParse(v.content)
  return {
    kind: 'row',
    row: {
      scenarioVersionId: v.id,
      title: parsed.success ? parsed.data.title : '(this case has no readable title)',
      sector: s?.sector ?? '(unknown)',
      jurisdiction: s?.jurisdiction ?? '(unknown)',
      versionNo: v.version_no,
      asOfDate: v.as_of_date,
      isFiction: v.is_fiction,
      fictionStatement: parsed.success ? parsed.data.fiction_notice?.statement : undefined,
      publishedAt: v.published_at,
      supersededBy: later[0]?.version_no ?? null,
    },
  }
}

/** Every audit event for one decision, oldest first. */
export async function loadAudit(decisionId: string): Promise<readonly AuditRow[]> {
  const { data, error } = await supabase
    .from('audit_event')
    .select('id, action, actor_user_id, detail, occurred_at')
    .eq('decision_id', decisionId)
    .order('occurred_at', { ascending: true })
  if (error !== null) throw mapPostgrestError(error)
  return data.map((a) => ({
    id: a.id,
    action: a.action,
    actorUserId: a.actor_user_id,
    detail: a.detail,
    occurredAt: a.occurred_at,
  }))
}

/** One record, reconstructed whole. */
export async function loadTrail(decisionId: string): Promise<RowOutcome<EvidenceTrail>> {
  const { data, error } = await supabase
    .from('decision')
    .select('id, scenario_version_id, state, created_at, submitted_at')
    .eq('id', decisionId)
    .limit(1)
  if (error !== null) throw mapPostgrestError(error)

  const outcome = singleRowOutcome(data)
  if (outcome.kind === 'empty') return outcome
  const d = outcome.row

  const scenario = await loadScenarioVersionById(d.scenario_version_id)
  if (scenario.kind === 'empty') {
    // The decision exists and its case does not resolve. That is a fault, not
    // an empty state, and it must not render as a trail with a blank header.
    throw new Error(
      `decision ${decisionId} is pinned to scenario version ${d.scenario_version_id}, ` +
        `which did not come back. ${scenario.note}`,
    )
  }

  const [sources, revisions, audit] = await Promise.all([
    loadSources(d.scenario_version_id),
    loadRevisions(decisionId),
    loadAudit(decisionId),
  ])

  return {
    kind: 'row',
    row: {
      decisionId: d.id,
      state: d.state,
      createdAt: d.created_at,
      submittedAt: d.submitted_at,
      scenario: scenario.row,
      sources,
      revisions,
      audit,
    },
  }
}
