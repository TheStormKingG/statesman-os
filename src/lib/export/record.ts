/**
 * The exported decision record: its shape, and the pure function that builds it.
 *
 * ── WHY THIS IS NOT IN `supabase/history.ts` ────────────────────────────────
 *
 * It was, and the unit suite could not load it. `history.ts` imports the
 * Supabase client, which THROWS at module load when `NEXT_PUBLIC_SUPABASE_URL`
 * is absent — deliberately, because under `output: 'export'` a missing variable
 * is inlined as the literal `undefined` and the broken bundle is what gets
 * published. `scripts/gates.sh` must pass with no credentials and no network,
 * so a pure formatter living next to a client is a formatter the offline gate
 * cannot test.
 *
 * Separating them is the right shape anyway: turning a record into a document
 * has nothing to do with how the record was fetched. The only link back is an
 * `import type`, which is erased at compile time and pulls in no runtime code.
 *
 * ── THE DOCUMENT IS A PUBLISHED CONTRACT ────────────────────────────────────
 *
 * FR-16 asks for "a portable format" and NFR-09 for "a documented
 * machine-readable format", which means someone will read these files with no
 * access to this code. So the shape is declared as an interface rather than
 * reached with a cast: an earlier version returned `Record<string, Json>` via
 * `as unknown as`, and the repository's own lint rule rejected it — correctly,
 * since a double assertion turns off the type system exactly where the shape is
 * a promise to a stranger.
 *
 * snake_case keys, matching the database columns they came from, so a reader
 * holding both the export and the schema does not have to translate.
 */

import type { Json } from '../supabase/client'
import type { DecisionState } from '../supabase/client'
import type { EvidenceTrail } from '../supabase/history'


/**
 * The record as a portable object. FR-16 ("export records in portable format")
 * and NFR-09 ("documented machine-readable format").
 *
 * `format` and `exported_at` are in the payload because a file with no version
 * marker is a file nobody can safely read in two years. The identifiers each
 * hop is pinned to are included for the same reason §9.2 asks the SCREEN to
 * show them: an export that drops them is a story rather than a record.
 *
 * This is the whole of FR-16's export half. Its DELETION half is not built:
 * there is no erasure function in schema `app` (checked, not assumed), so
 * nothing in this application offers one.
 */
export const EXPORT_FORMAT = 'statesman-os.decision-record.v1'

/**
 * The export's shape, declared rather than cast.
 *
 * The first version returned `Record<string, Json>` and reached it with
 * `as unknown as`, which the repository's own lint rule rejects: a double
 * assertion through `unknown` turns off the type system at exactly the boundary
 * where the shape is a published contract. If a consumer two years from now has
 * to read these files, the shape they are promised is this interface, and
 * nothing may be added to a document without being added here first.
 *
 * snake_case keys, matching the database columns they came from, so a reader
 * holding both the export and the schema does not have to translate.
 */
export interface ExportedSource {
  readonly id: string
  readonly title: string
  readonly publisher: string
  readonly uri: string | null
  readonly published_date: string | null
  readonly retrieved_date: string | null
  readonly kind: string
}

export interface ExportedRevision {
  readonly id: string
  readonly revision_no: number
  readonly created_at: string
  readonly confidence: number
  readonly expected_outcomes: string
  readonly time_horizon: string
  readonly rationale: string
  readonly content: Json
}

export interface ExportedAuditEvent {
  readonly id: string
  readonly action: string
  readonly actor_user_id: string | null
  readonly detail: Json
  readonly occurred_at: string
}

export interface ExportDocument {
  readonly format: typeof EXPORT_FORMAT
  readonly exported_at: string
  readonly decision: {
    readonly id: string
    readonly state: DecisionState
    readonly created_at: string
    readonly submitted_at: string | null
  }
  readonly scenario_version: {
    readonly id: string
    readonly title: string
    readonly version_no: number
    readonly sector: string
    readonly jurisdiction: string
    readonly as_of_date: string
    readonly is_fiction: boolean
    readonly published_at: string | null
    readonly superseded_by_version_no: number | null
  }
  readonly sources: readonly ExportedSource[]
  readonly revisions: readonly ExportedRevision[]
  readonly audit: readonly ExportedAuditEvent[]
  /**
   * What this file does NOT contain, in the file itself.
   *
   * An export that silently omits three quarters of the record described in
   * `docs/ui-ux-design.md` §9.2 is a document someone could reasonably read as
   * complete. Saying so inside the artefact is the only place the statement
   * travels with it.
   */
  readonly not_included: readonly string[]
}

export function toExportDocument(trail: EvidenceTrail): ExportDocument {
  return {
    format: EXPORT_FORMAT,
    exported_at: new Date().toISOString(),
    decision: {
      id: trail.decisionId,
      state: trail.state,
      created_at: trail.createdAt,
      submitted_at: trail.submittedAt,
    },
    scenario_version: {
      id: trail.scenario.scenarioVersionId,
      title: trail.scenario.title,
      version_no: trail.scenario.versionNo,
      sector: trail.scenario.sector,
      jurisdiction: trail.scenario.jurisdiction,
      as_of_date: trail.scenario.asOfDate,
      is_fiction: trail.scenario.isFiction,
      published_at: trail.scenario.publishedAt,
      superseded_by_version_no: trail.scenario.supersededBy,
    },
    sources: trail.sources.map((s) => ({
      id: s.id,
      title: s.title,
      publisher: s.publisher,
      uri: s.uri,
      published_date: s.publishedDate,
      retrieved_date: s.retrievedDate,
      kind: s.kind,
    })),
    revisions: trail.revisions.map((r) => ({
      id: r.id,
      revision_no: r.revisionNo,
      created_at: r.createdAt,
      confidence: r.confidence,
      expected_outcomes: r.forecast,
      time_horizon: r.horizon,
      rationale: r.rationale,
      content: r.content,
    })),
    audit: trail.audit.map((a) => ({
      id: a.id,
      action: a.action,
      actor_user_id: a.actorUserId,
      detail: a.detail,
      occurred_at: a.occurredAt,
    })),
    not_included: [
      'Challenge review: the AI challenge system is not built, so no challenge, response or dispute exists for any record.',
      'Reflection and development actions: not built.',
      'Human review decisions: reviewer sharing is deferred (FR-13), so no review exists.',
    ],
  }
}
