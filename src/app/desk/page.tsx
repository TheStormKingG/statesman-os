'use client'

/**
 * Screen B — the Decision Desk.
 *
 * `docs/ui-ux-design.md` §6: ONE SCROLLABLE PAGE, four labelled groups, one
 * autosaving draft. Not a wizard, and §6.1 gives the reason: the user is
 * constructing a single argument that has to hold together, a wizard hides the
 * whole, and it turns "reopen a draft without loss" into a question about which
 * step you were on.
 *
 * ── THE SCENARIO ARRIVES IN THE QUERY STRING, AND WHY NOT A ROUTE SEGMENT ───
 *
 * `/desk/?v=<scenario_version_id>`. A dynamic segment — `/desk/[id]/` — would
 * need `generateStaticParams` under `output: 'export'`, and the build has no
 * database access: the Pages workflow holds only the publishable key, and `anon`
 * can read nothing (0 reachable tables, measured). So the set of ids is unknown
 * at build time, by construction, and a route segment cannot be produced.
 *
 * The value is read from `window.location.search` inside an effect rather than
 * with `useSearchParams`, which requires a Suspense boundary during prerender
 * and would otherwise fail the export. One page, one HTML file, the parameter
 * read in the browser where it exists.
 *
 * ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────────
 *
 * The completeness summary is a POSITION INDICATOR, not a progress bar (§6.1):
 * filled count over total, in mono, with no bar, no percentage and no colour
 * that changes as it fills. Confidence is a number input with a word band
 * beside it and NO track, NO fill and NO red-to-green scale (§6.3) — an
 * evaluative gradient is the thing this product refuses.
 */

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AuthGate } from '../../components/AuthGate'
import { FIELD_COPY } from './field-copy'
import {
  createDraft,
  findLatestDecisionForScenario,
  loadRevisions,
  saveDraft,
  submitDecision,
} from '../../lib/supabase/decisions'
import type { DecisionRecord, DraftFields, RevisionRecord } from '../../lib/supabase/decisions'
import {
  DECISION_FIELD_ORDER,
  DECISION_GROUPS,
  parseSubmission,
} from '../../lib/validation/decision'
import type { DecisionFieldName, FieldErrors } from '../../lib/validation/decision'
import { loadClaims, loadPublishedScenario, loadSources } from '../../lib/supabase/scenarios'
import type { ClaimRef, ScenarioBrief, SourceRef } from '../../lib/supabase/scenarios'
import { publicMessageFor } from '../../lib/supabase/errors'
import type { AuthedIdentity } from '../../lib/supabase/auth'

const AUTOSAVE_IDLE_MS = 10_000

export default function DeskPage(): React.ReactElement {
  return (
    <main className="page" id="main">
      <AuthGate>{(identity) => <DeskBody identity={identity} />}</AuthGate>
    </main>
  )
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

interface Loaded {
  readonly brief: ScenarioBrief
  readonly sources: readonly SourceRef[]
  readonly claims: readonly ClaimRef[]
  readonly decision: DecisionRecord
  readonly revisions: readonly RevisionRecord[]
}

type Phase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly data: Loaded }
  | { readonly kind: 'error'; readonly message: string }

function DeskBody({ identity }: { readonly identity: AuthedIdentity }): React.ReactElement {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false

    async function load(): Promise<void> {
      const requested = new URLSearchParams(window.location.search).get('v')

      const scenarioOutcome = await loadPublishedScenario()
      if (scenarioOutcome.kind === 'empty') {
        throw new Error(scenarioOutcome.note)
      }
      const brief = scenarioOutcome.row

      // A `v` naming a different case is reported rather than silently ignored:
      // opening the Desk on a case the user did not ask for, with their answer
      // then pinned to it by the composite FK, is not a recoverable confusion.
      if (requested !== null && requested !== brief.scenarioVersionId) {
        throw new Error(
          `This link asks for case ${requested}, which is not the published case. ` +
            'Only one case is published, and a decision is pinned to the case it ' +
            'answers, so the Desk will not open against a different one.',
        )
      }

      const existing = await findLatestDecisionForScenario(brief.scenarioVersionId)
      const decision =
        existing.kind === 'row'
          ? existing.row
          : await createDraft(identity.userId, brief.scenarioVersionId)

      const [sources, claims, revisions] = await Promise.all([
        loadSources(brief.scenarioVersionId),
        loadClaims(brief.scenarioVersionId),
        decision.submittedAt === null
          ? Promise.resolve([] as readonly RevisionRecord[])
          : loadRevisions(decision.id),
      ])

      if (!cancelled) {
        setPhase({ kind: 'ready', data: { brief, sources, claims, decision, revisions } })
      }
    }

    load().catch((error: unknown) => {
      if (!cancelled) setPhase({ kind: 'error', message: publicMessageFor(error) })
    })
    return () => {
      cancelled = true
    }
  }, [identity.userId])

  if (phase.kind === 'loading') return <p className="autosave">Opening the desk.</p>
  if (phase.kind === 'error') {
    return (
      <p className="notice" role="alert">
        The desk could not be opened. {phase.message}
      </p>
    )
  }
  return <Desk data={phase.data} />
}

/* ------------------------------------------------------------------ *
 * The desk
 * ------------------------------------------------------------------ */

type SaveState =
  | { readonly kind: 'clean' }
  | { readonly kind: 'dirty' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved'; readonly at: Date }
  | { readonly kind: 'failed'; readonly retrying: boolean }

function Desk({ data }: { readonly data: Loaded }): React.ReactElement {
  const frozen = data.decision.submittedAt !== null
  const [fields, setFields] = useState<DraftFields>(data.decision.fields)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [save, setSave] = useState<SaveState>({ kind: 'clean' })
  const [submitError, setSubmitError] = useState<string | undefined>(undefined)
  const [submitted, setSubmitted] = useState<{ no: number; replayed: boolean } | undefined>(
    undefined,
  )

  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  /**
   * The idempotency token, minted once when the dialog first opens and reused
   * for every retry until the submission succeeds.
   *
   * `idempotency_token uuid unique` only makes a replay safe if the retry sends
   * the SAME token. A token generated per attempt would make the unique
   * constraint the only thing between a dropped response and a duplicate
   * record, which is the opposite of what it is for.
   */
  const token = useRef<string | undefined>(undefined)
  /** The latest fields, for the timer and the keyboard handler to read. */
  const latest = useRef<DraftFields>(fields)
  latest.current = fields

  const persist = useCallback(
    async (next: DraftFields): Promise<void> => {
      if (frozen) return
      setSave({ kind: 'saving' })
      try {
        await saveDraft(data.decision.id, next)
        setSave({ kind: 'saved', at: new Date() })
      } catch {
        // Deliberately not the error text: the user's concern is their typing,
        // and `saveDraft` already refuses to call a zero-row update a save.
        setSave({ kind: 'failed', retrying: false })
      }
    },
    [data.decision.id, frozen],
  )

  // Autosave on a 10 second idle timer (ui-ux §6.5). The blur handler saves too.
  useEffect(() => {
    if (frozen || save.kind !== 'dirty') return
    idleTimer.current = setTimeout(() => {
      void persist(latest.current)
    }, AUTOSAVE_IDLE_MS)
    return () => {
      if (idleTimer.current !== undefined) clearTimeout(idleTimer.current)
    }
  }, [save.kind, frozen, persist])

  const openDialog = useCallback(() => {
    const result = parseSubmission(toSubmissionInput(latest.current))
    if (!result.ok) {
      // §6.5: if any required field is empty the dialog does not open; focus
      // moves to the first invalid field instead.
      setErrors(result.errors)
      document.getElementById(`field-${result.firstInvalid}`)?.focus()
      return
    }
    setErrors({})
    token.current ??= crypto.randomUUID()
    dialogRef.current?.showModal()
  }, [])

  // Keyboard (ui-ux §10). Cmd/Ctrl+S saves, Cmd/Ctrl+Enter opens the dialog.
  // Neither animates: these are the frequent paths.
  useEffect(() => {
    if (frozen) return
    function onKey(event: KeyboardEvent): void {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key === 's') {
        event.preventDefault()
        void persist(latest.current)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        openDialog()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [frozen, persist, openDialog])

  function setField(name: DecisionFieldName, value: string): void {
    setFields((prev) => ({ ...prev, [name]: value }))
    setSave({ kind: 'dirty' })
  }

  async function doSubmit(): Promise<void> {
    const result = parseSubmission(toSubmissionInput(latest.current))
    if (!result.ok) {
      setErrors(result.errors)
      dialogRef.current?.close()
      return
    }
    const activeToken = token.current
    if (activeToken === undefined) return
    try {
      const outcome = await submitDecision(data.decision.id, activeToken, result.value)
      setSubmitted({ no: outcome.revisionNo, replayed: outcome.replayed })
      dialogRef.current?.close()
    } catch (caught: unknown) {
      setSubmitError(publicMessageFor(caught))
    }
  }

  return (
    <>
      <p className="eyebrow">Decision desk</p>
      <h1>{data.brief.title}</h1>
      <p className="meta-line" style={{ marginBlockStart: '8px' }}>
        <span>{data.brief.sector}</span>
        <span>{data.brief.jurisdiction}</span>
      </p>
      <p style={{ marginBlockStart: '12px' }}>
        <span className="fiction-marker">
          {data.brief.isFiction ? <span>Fictional training case.</span> : null}
          <span>As of {data.brief.asOfDate}.</span>
        </span>
      </p>

      <Brief brief={data.brief} sources={data.sources} claims={data.claims} />

      {submitted !== undefined ? (
        <section className="notice" role="status" style={{ marginBlockStart: '24px' }}>
          <p>
            {submitted.replayed
              ? `This submission had already been recorded as revision ${submitted.no}. Nothing was written twice.`
              : `Submitted as revision ${submitted.no}. This version cannot be edited.`}
          </p>
          <p className="field-help">
            Challenge review arrives in Slice 4. There is no challenge system yet, so there
            is nothing to open.
          </p>
        </section>
      ) : null}

      {frozen ? (
        <FrozenRecord decision={data.decision} revisions={data.revisions} />
      ) : (
        <>
          {data.decision.draftReadable ? null : (
            <p className="notice" role="alert">
              This draft was saved by a different version of the application and cannot be
              read. Nothing has been overwritten, and nothing will be: saving is disabled
              so that the stored text is not replaced by an empty form.
            </p>
          )}

          <CompletenessSummary fields={fields} />

          <form
            onSubmit={(e) => {
              e.preventDefault()
              openDialog()
            }}
            noValidate
          >
            {DECISION_GROUPS.map((group) => (
              <fieldset
                key={group.id}
                id={`group-${group.id}`}
                className="group"
                style={{ border: 'none', padding: 0, margin: 0 }}
              >
                <legend style={{ padding: 0 }}>
                  <h2>{group.label}</h2>
                </legend>
                {group.fields.map((name) => (
                  <Field
                    key={name}
                    name={name}
                    value={fields[name] ?? ''}
                    error={errors[name]}
                    disabled={!data.decision.draftReadable}
                    onChange={(value) => setField(name, value)}
                    onBlur={() => {
                      if (save.kind === 'dirty') void persist(latest.current)
                    }}
                  />
                ))}
              </fieldset>
            ))}

            <div className="button-row" style={{ marginBlockStart: '32px' }}>
              <button
                type="submit"
                className="button button--primary"
                disabled={!data.decision.draftReadable}
              >
                Submit decision
              </button>
              <button
                type="button"
                className="button"
                disabled={!data.decision.draftReadable}
                onClick={() => void persist(latest.current)}
              >
                Save draft
              </button>
              <AutosaveLine state={save} />
            </div>
            {submitError === undefined ? null : (
              <p className="field-error" role="alert">
                The submission was not recorded. {submitError}
              </p>
            )}
          </form>
        </>
      )}

      <SubmitDialog ref={dialogRef} onConfirm={() => void doSubmit()} />

      <p style={{ marginBlockStart: '32px' }}>
        <Link href="/today/">Back to Today</Link>
      </p>
    </>
  )
}

/* ------------------------------------------------------------------ *
 * Pieces
 * ------------------------------------------------------------------ */

/**
 * `confidence` is held in the draft as the raw text the user typed, so that
 * `60abc` survives a reload and can be reported. It is converted to a number
 * only here, at the validation boundary, and a value that is not an integer is
 * passed through as the string so zod rejects it with a field-level message
 * rather than this function silently turning it into NaN.
 */
function toSubmissionInput(fields: DraftFields): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const name of DECISION_FIELD_ORDER) {
    const raw = fields[name]
    if (raw === undefined) continue
    if (name === 'confidence') {
      out[name] = /^-?\d+$/.test(raw.trim()) ? Number.parseInt(raw.trim(), 10) : raw
    } else {
      out[name] = raw
    }
  }
  return out
}

function Field({
  name,
  value,
  error,
  disabled,
  onChange,
  onBlur,
}: {
  readonly name: DecisionFieldName
  readonly value: string
  readonly error: string | undefined
  readonly disabled: boolean
  readonly onChange: (value: string) => void
  readonly onBlur: () => void
}): React.ReactElement {
  const copy = FIELD_COPY[name]
  const helpId = `help-${name}`
  const errorId = `error-${name}`

  return (
    <div className="field">
      <label htmlFor={`field-${name}`}>{copy.label}</label>
      <p className="field-help" id={helpId}>
        {copy.help}
      </p>
      {name === 'confidence' ? (
        <div className="confidence-row">
          <input
            id={`field-${name}`}
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            step={5}
            disabled={disabled}
            value={value}
            aria-describedby={error === undefined ? helpId : `${helpId} ${errorId}`}
            aria-invalid={error === undefined ? undefined : true}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur}
          />
          <span className="confidence-band">{confidenceBand(value)}</span>
        </div>
      ) : (
        <textarea
          id={`field-${name}`}
          rows={copy.rows}
          // The same number as `rows`, as a custom property, because
          // `field-sizing: content` shrinks an empty box past `rows` to a single
          // line. The CSS turns this into a min-height the shrink cannot cross.
          style={{ '--rows': copy.rows } as React.CSSProperties}
          disabled={disabled}
          value={value}
          aria-describedby={error === undefined ? helpId : `${helpId} ${errorId}`}
          aria-invalid={error === undefined ? undefined : true}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
        />
      )}
      {error === undefined ? null : (
        <p className="field-error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * A word beside the number so the value is not carried by digits alone.
 *
 * Three bands, named, with no colour and no implied grade: 30 is not worse than
 * 80, it is a different claim about the same decision. An empty or unparseable
 * value reports nothing rather than guessing a band.
 */
function confidenceBand(raw: string): string {
  if (!/^\d+$/.test(raw.trim())) return ''
  const n = Number.parseInt(raw.trim(), 10)
  if (n < 0 || n > 100) return ''
  if (n < 34) return 'Low'
  if (n < 67) return 'Moderate'
  return 'High'
}

/**
 * Filled count over total, per group.
 *
 * A POSITION INDICATOR (ui-ux §6.1). Deliberately not a bar, not a percentage,
 * and it does not change colour as it fills: a form that congratulates you for
 * filling it in is grading the typing rather than the thinking.
 */
function CompletenessSummary({ fields }: { readonly fields: DraftFields }): React.ReactElement {
  const counts = useMemo(
    () =>
      DECISION_GROUPS.map((group) => ({
        id: group.id,
        label: group.label,
        filled: group.fields.filter((f) => (fields[f] ?? '').trim().length > 0).length,
        total: group.fields.length,
      })),
    [fields],
  )

  return (
    <nav className="summary-bar" aria-label="Sections">
      {counts.map((c) => (
        <a key={c.id} href={`#group-${c.id}`}>
          {c.label} <span className="mono">{`${c.filled}/${c.total}`}</span>
        </a>
      ))}
    </nav>
  )
}

/** Exactly the copy `docs/ui-ux-design.md` §11 specifies, including on failure. */
function AutosaveLine({ state }: { readonly state: SaveState }): React.ReactElement {
  if (state.kind === 'saving') return <span className="autosave">Saving.</span>
  if (state.kind === 'saved') {
    const at = state.at
    const hh = String(at.getHours()).padStart(2, '0')
    const mm = String(at.getMinutes()).padStart(2, '0')
    return <span className="autosave">{`Draft saved ${hh}:${mm}`}</span>
  }
  if (state.kind === 'failed') {
    return (
      <span className="autosave autosave--failed" role="alert">
        Not saved. Your text is still here.
      </span>
    )
  }
  if (state.kind === 'dirty') return <span className="autosave">Unsaved changes.</span>
  return <span className="autosave" />
}

function Brief({
  brief,
  sources,
  claims,
}: {
  readonly brief: ScenarioBrief
  readonly sources: readonly SourceRef[]
  readonly claims: readonly ClaimRef[]
}): React.ReactElement {
  return (
    <section>
      <h2>The case</h2>
      <p>{brief.issueStatement}</p>

      <h3 style={{ marginBlockStart: '24px' }}>What is being asked of you</h3>
      <ul>
        {brief.requiredDecision.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>

      <dl className="facts">
        <dt>Your role</dt>
        <dd>{brief.roleAuthority}</dd>
        <dt>Window</dt>
        <dd>
          {brief.windowHours} hours. Deadline in the case: {brief.inWorldDeadline}
        </dd>
      </dl>

      <details>
        <summary>Limits on your role ({brief.roleLimits.length})</summary>
        <ul className="register">
          {brief.roleLimits.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>

      <details>
        <summary>Available resources ({brief.availableResources.length})</summary>
        <ul className="register">
          {brief.availableResources.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>

      <details>
        <summary>Data gaps ({brief.dataGaps.length})</summary>
        <ul className="register">
          {brief.dataGaps.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>

      {/*
        The source register, read from `public.source`. Title, publisher,
        publication date and retrieved date, as §6.2 requires — those four are
        what make FR-02 traceability checkable by a reader rather than asserted.
      */}
      <details>
        <summary>Source register ({sources.length})</summary>
        <ul className="register">
          {sources.map((s) => (
            <li key={s.id}>
              <p>{s.title}</p>
              <p className="meta-line">
                <span>{s.publisher}</span>
                <span>{s.kind}</span>
                {s.publishedDate === null ? null : <span>published {s.publishedDate}</span>}
                {s.retrievedDate === null ? null : <span>retrieved {s.retrievedDate}</span>}
              </p>
            </li>
          ))}
        </ul>
      </details>

      <details>
        <summary>Claim register ({claims.length})</summary>
        <ul className="register">
          {claims.map((c) => (
            <li key={c.claimId}>
              <p>{c.claimText}</p>
              <p className="meta-line">
                <span className="mono">{c.claimId}</span>
                <span>confidence {c.confidence}</span>
              </p>
            </li>
          ))}
        </ul>
      </details>

      <p className="field-help" style={{ marginBlockStart: '16px' }}>
        {brief.fictionStatement}
      </p>
    </section>
  )
}

/**
 * The submitted record, read-only.
 *
 * §6.6: fields become `--subtle` panels with their values and a mono stamp.
 * Read-only is visually and semantically distinct from disabled — these are not
 * inputs at all, because there is nothing to type into: the revision is
 * append-only in the database and the grant to change it does not exist.
 */
function FrozenRecord({
  decision,
  revisions,
}: {
  readonly decision: DecisionRecord
  readonly revisions: readonly RevisionRecord[]
}): React.ReactElement {
  return (
    <section style={{ marginBlockStart: '24px' }}>
      <h2>Submitted</h2>
      <p className="meta-line">
        <span>{`Submitted ${decision.submittedAt ?? 'unknown'}. This version cannot be edited.`}</span>
        <span>{`State ${decision.state}`}</span>
      </p>
      {revisions.length === 0 ? (
        <p className="notice">
          This decision is marked submitted but no revision came back. That is a fault worth
          reporting, not an empty state: a submitted decision always has at least revision 1.
        </p>
      ) : (
        revisions.map((r) => (
          <article key={r.id} style={{ marginBlockStart: '24px' }}>
            <h3>
              Revision {r.revisionNo}
              {r.revisionNo > 1 ? '. Revision 1 remains visible.' : ''}
            </h3>
            <dl className="facts">
              <dt>Confidence</dt>
              <dd className="mono">{r.confidence}</dd>
              <dt>Expected outcomes</dt>
              <dd className="field-frozen">{r.forecast}</dd>
              <dt>Time horizon</dt>
              <dd className="field-frozen">{r.horizon}</dd>
              <dt>Rationale</dt>
              <dd className="field-frozen">{r.rationale}</dd>
            </dl>
          </article>
        ))
      )}
    </section>
  )
}

/**
 * The one dialog in the product.
 *
 * §6.5: "Submission is the one consequential moment", so it gets the one
 * dialog. The copy below is that section's, close to verbatim: it states what
 * becomes immutable AND what remains possible, and it names the fields that are
 * recorded. `<dialog>` is used rather than a div because the native element
 * traps focus, closes on Escape and returns focus to its trigger without any of
 * that being reimplemented.
 */
function SubmitDialog({
  ref,
  onConfirm,
}: {
  readonly ref: React.Ref<HTMLDialogElement>
  readonly onConfirm: () => void
}): React.ReactElement {
  return (
    <dialog className="confirm" ref={ref} aria-labelledby="submit-dialog-title">
      <h2 id="submit-dialog-title">Submit this decision</h2>
      <p>
        Submitting saves a permanent, timestamped version of this response. You cannot edit
        it afterwards. You can add a later revision, and both versions stay visible.
      </p>
      <p>
        Objective, alternatives, recommended action, rationale, authority, resources,
        stakeholders, risks, assumptions, unknowns, confidence, outcomes, indicators and
        horizon are all recorded.
      </p>
      <div className="button-row">
        <button type="button" className="button button--primary" onClick={onConfirm}>
          Submit decision
        </button>
        <form method="dialog" style={{ display: 'contents' }}>
          <button type="submit" className="button">
            Keep editing
          </button>
        </form>
      </div>
    </dialog>
  )
}
