'use client'

/**
 * Screen E — History and the evidence trail.
 *
 * Two views behind one route. `/history/` lists the records; `/history/?d=<id>`
 * reconstructs one. A dynamic segment is impossible under `output: 'export'`
 * for the reason the Desk records, and one route keeps the filters in the same
 * query string as the selection, which is what makes "filter state survives
 * back navigation" (`docs/ui-ux-design.md` §9.1) fall out of the browser rather
 * than out of a store this page would have to keep in sync with the URL.
 *
 * ── WHAT §9.1 ASKS FOR AND IS NOT HERE ──────────────────────────────────────
 *
 * The specified columns are date, scenario, sector, state, confidence, REVIEW
 * STATUS. There is no review status column, because there are no reviews: FR-13
 * reviewer sharing is deferred and no assessment exists. A column of empty cells
 * would say we looked and found nothing, which is a different claim from "this
 * does not exist yet". The absence is stated once, under the table.
 *
 * ── AND WHAT §9.2 ASKS FOR AND IS NOT HERE ──────────────────────────────────
 *
 * The trail is specified to run from the scenario version through the locked
 * response, the revisions, every CHALLENGE with its model version and timestamp,
 * the user's disputes, the REFLECTION, the ACTIONS and their completion
 * evidence. Three of those do not exist. The trail renders the hops that do and
 * names the ones that do not, in place, in order — so the shape of the record is
 * honest about where it stops rather than appearing complete.
 */

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AuthGate } from '../../components/AuthGate'
import { loadHistory, loadTrail } from '../../lib/supabase/history'
import { toExportDocument } from '../../lib/export/record'
import type { EvidenceTrail, HistoryRow } from '../../lib/supabase/history'
import { publicMessageFor } from '../../lib/supabase/errors'

export default function HistoryPage(): React.ReactElement {
  return (
    <main className="page" id="main">
      <AuthGate>{() => <HistoryBody />}</AuthGate>
    </main>
  )
}

function HistoryBody(): React.ReactElement {
  const [selected, setSelected] = useState<string | undefined>(undefined)

  // Read on mount and on popstate, so the browser's back button is what drives
  // the view rather than a copy of the URL kept in React state.
  useEffect(() => {
    const read = (): void => {
      setSelected(new URLSearchParams(window.location.search).get('d') ?? undefined)
    }
    read()
    window.addEventListener('popstate', read)
    return () => window.removeEventListener('popstate', read)
  }, [])

  return selected === undefined ? <RecordList /> : <Trail decisionId={selected} />
}

/* ------------------------------------------------------------------ *
 * The list
 * ------------------------------------------------------------------ */

type SortKey = 'createdAt' | 'title' | 'sector' | 'state' | 'confidence'
type Direction = 'ascending' | 'descending'

type Load =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly rows: readonly HistoryRow[] }
  | { readonly phase: 'error'; readonly message: string }

function RecordList(): React.ReactElement {
  const [load, setLoad] = useState<Load>({ phase: 'loading' })
  const [sector, setSector] = useState('')
  const [state, setState] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: Direction }>({
    key: 'createdAt',
    dir: 'descending',
  })

  // Filters live in the query string, so back navigation restores them (§9.1).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    setSector(q.get('sector') ?? '')
    setState(q.get('state') ?? '')
    setFrom(q.get('from') ?? '')
    setTo(q.get('to') ?? '')
  }, [])

  const syncUrl = useCallback(
    (next: Record<string, string>) => {
      const q = new URLSearchParams(window.location.search)
      for (const [k, v] of Object.entries(next)) {
        if (v === '') q.delete(k)
        else q.set(k, v)
      }
      const search = q.toString()
      window.history.replaceState(null, '', search === '' ? window.location.pathname : `?${search}`)
    },
    [],
  )

  useEffect(() => {
    let cancelled = false
    loadHistory()
      .then((rows) => {
        if (!cancelled) setLoad({ phase: 'ready', rows })
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad({ phase: 'error', message: publicMessageFor(error) })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const all = load.phase === 'ready' ? load.rows : []
  const sectors = useMemo(() => [...new Set(all.map((r) => r.sector))].sort(), [all])
  const states = useMemo(() => [...new Set(all.map((r) => r.state))].sort(), [all])

  const rows = useMemo(() => {
    const filtered = all.filter((r) => {
      if (sector !== '' && r.sector !== sector) return false
      if (state !== '' && r.state !== state) return false
      // Dates compare as ISO strings, which sort correctly and need no parsing.
      if (from !== '' && r.createdAt.slice(0, 10) < from) return false
      if (to !== '' && r.createdAt.slice(0, 10) > to) return false
      return true
    })
    const dir = sort.dir === 'ascending' ? 1 : -1
    return [...filtered].sort((a, b) => {
      const x = a[sort.key]
      const y = b[sort.key]
      // Nulls last in both directions: a draft with no confidence yet is not
      // "lower" than 0, it is absent, and sorting it to an end is less wrong
      // than pretending it is a number.
      if (x === null) return 1
      if (y === null) return -1
      return x < y ? -dir : x > y ? dir : 0
    })
  }, [all, sector, state, from, to, sort])

  function header(key: SortKey, label: string): React.ReactElement {
    const active = sort.key === key
    return (
      <th scope="col" aria-sort={active ? sort.dir : 'none'}>
        <button
          type="button"
          onClick={() =>
            setSort({
              key,
              dir: active && sort.dir === 'descending' ? 'ascending' : 'descending',
            })
          }
        >
          {label}
          {active ? <span aria-hidden="true">{sort.dir === 'ascending' ? '▲' : '▼'}</span> : null}
        </button>
      </th>
    )
  }

  return (
    <>
      <p className="eyebrow">History</p>
      <h1>Your records</h1>

      {load.phase === 'loading' ? <p className="autosave">Loading your records.</p> : null}
      {load.phase === 'error' ? (
        <p className="notice" role="alert">
          Your records could not be loaded. {load.message}
        </p>
      ) : null}

      {load.phase === 'ready' ? (
        <>
          <div className="filters">
            <div>
              <label htmlFor="f-sector">Sector</label>
              <select
                id="f-sector"
                value={sector}
                onChange={(e) => {
                  setSector(e.target.value)
                  syncUrl({ sector: e.target.value })
                }}
              >
                <option value="">All</option>
                {sectors.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="f-state">State</label>
              <select
                id="f-state"
                value={state}
                onChange={(e) => {
                  setState(e.target.value)
                  syncUrl({ state: e.target.value })
                }}
              >
                <option value="">All</option>
                {states.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="f-from">From</label>
              <input
                id="f-from"
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value)
                  syncUrl({ from: e.target.value })
                }}
              />
            </div>
            <div>
              <label htmlFor="f-to">To</label>
              <input
                id="f-to"
                type="date"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value)
                  syncUrl({ to: e.target.value })
                }}
              />
            </div>
          </div>

          {all.length === 0 ? (
            <p className="notice">
              You have no records yet. A record appears here once you open a decision on the
              desk, and becomes permanent when you submit it.
            </p>
          ) : (
            <>
              <p className="meta-line" style={{ marginBlockStart: '16px' }}>
                <span>
                  {rows.length} of {all.length} shown
                </span>
              </p>

              {/* ≥768px: the table. Below: blocks. Different markup, not a
                  restyled table — a `display: block` table still announces as a
                  table to a screen reader. */}
              <div className="only-wide">
                <table className="record-table">
                  <caption className="visually-hidden">
                    Your decision records, sortable by column
                  </caption>
                  <thead>
                    <tr>
                      {header('createdAt', 'Started')}
                      {header('title', 'Case')}
                      {header('sector', 'Sector')}
                      {header('state', 'State')}
                      {header('confidence', 'Confidence')}
                      <th scope="col">Revisions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.decisionId}>
                        <td className="num">{r.createdAt.slice(0, 10)}</td>
                        <td>
                          <Link href={{ pathname: '/history/', query: { d: r.decisionId } }}>
                            {r.title}
                          </Link>
                        </td>
                        <td>{r.sector}</td>
                        <td>{r.state}</td>
                        <td className="num">{r.confidence ?? '—'}</td>
                        <td className="num">{r.revisionCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <ul className="record-list only-narrow">
                {rows.map((r) => (
                  <li key={r.decisionId}>
                    <Link href={{ pathname: '/history/', query: { d: r.decisionId } }}>
                      {r.title}
                    </Link>
                    <p className="meta-line">
                      <span className="mono">{r.createdAt.slice(0, 10)}</span>
                      <span>{r.state}</span>
                      <span>{r.sector}</span>
                      <span className="mono">
                        confidence {r.confidence ?? 'not yet given'}
                      </span>
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}

          <p className="field-help" style={{ marginBlockStart: '16px' }}>
            There is no review-status column. `docs/ui-ux-design.md` §9.1 specifies one, and
            there are no reviews to put in it: reviewer sharing is deferred (FR-13) and no
            assessment exists. A column of empty cells would say we looked and found none.
          </p>
        </>
      ) : null}

      <p style={{ marginBlockStart: '32px' }}>
        <Link href="/today/">Back to Today</Link>
      </p>
    </>
  )
}

/* ------------------------------------------------------------------ *
 * The trail
 * ------------------------------------------------------------------ */

type TrailLoad =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly trail: EvidenceTrail }
  | { readonly phase: 'missing'; readonly note: string }
  | { readonly phase: 'error'; readonly message: string }

function Trail({ decisionId }: { readonly decisionId: string }): React.ReactElement {
  const [load, setLoad] = useState<TrailLoad>({ phase: 'loading' })

  useEffect(() => {
    let cancelled = false
    loadTrail(decisionId)
      .then((outcome) => {
        if (cancelled) return
        setLoad(
          outcome.kind === 'row'
            ? { phase: 'ready', trail: outcome.row }
            : { phase: 'missing', note: outcome.note },
        )
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad({ phase: 'error', message: publicMessageFor(error) })
      })
    return () => {
      cancelled = true
    }
  }, [decisionId])

  if (load.phase === 'loading') return <p className="autosave">Reconstructing the record.</p>
  if (load.phase === 'error') {
    return (
      <p className="notice" role="alert">
        The record could not be reconstructed. {load.message}
      </p>
    )
  }
  if (load.phase === 'missing') {
    return (
      <>
        <h1>Record not available</h1>
        <p className="notice">{load.note}</p>
        <p>
          <Link href="/history/">Back to your records</Link>
        </p>
      </>
    )
  }

  const t = load.trail
  return (
    <>
      <p className="eyebrow">Evidence trail</p>
      <h1>{t.scenario.title}</h1>
      <p className="meta-line">
        <span>{t.scenario.sector}</span>
        <span>{t.scenario.jurisdiction}</span>
        <span>state {t.state}</span>
      </p>

      <div className="button-row" style={{ marginBlockStart: '16px' }}>
        <ExportButton trail={t} />
      </div>

      {/* HOP 1 — the case, as it was. */}
      <section className="hop">
        <h2>The case this answers</h2>
        <p>
          <span className="fiction-marker">
            {t.scenario.isFiction ? <span>Fictional training case.</span> : null}
            <span>As of {t.scenario.asOfDate}.</span>
          </span>
        </p>
        <p className="pins">
          <span>scenario_version_id {t.scenario.scenarioVersionId}</span>
          <span>version {t.scenario.versionNo}</span>
          <span>
            published {t.scenario.publishedAt ?? 'never — this record was written against an unpublished case'}
          </span>
        </p>
        {t.scenario.supersededBy === null ? null : (
          <p className="notice">
            Version {t.scenario.supersededBy} of this case has been published since. This
            record still resolves to version {t.scenario.versionNo}, the one it was written
            against, and always will: the revision is pinned to it by a foreign key.
          </p>
        )}
        <details>
          <summary>Sources as they stood ({t.sources.length})</summary>
          <ul className="register">
            {t.sources.map((s) => (
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
      </section>

      {/* HOP 2 — the locked response and every later revision. */}
      {t.revisions.length === 0 ? (
        <section className="hop">
          <h2>No submitted response</h2>
          <p>
            This decision is still a draft. Nothing has been locked, so there is no permanent
            version of it yet.
          </p>
        </section>
      ) : (
        t.revisions.map((r) => (
          <section className="hop" key={r.id}>
            <h2>
              {r.revisionNo === 1 ? 'The locked response' : `Revision ${r.revisionNo}`}
            </h2>
            <p className="meta-line">
              <span className="mono">{r.createdAt}</span>
              <span className="mono">confidence {r.confidence}</span>
            </p>
            <dl className="facts">
              <dt>Expected outcomes</dt>
              <dd className="field-frozen">{r.forecast}</dd>
              <dt>Time horizon</dt>
              <dd className="field-frozen">{r.horizon}</dd>
              <dt>Rationale</dt>
              <dd className="field-frozen">{r.rationale}</dd>
            </dl>
            <p className="pins">
              <span>revision_id {r.id}</span>
              <span>decision_id {t.decisionId}</span>
            </p>
          </section>
        ))
      )}

      {/* HOP 3 — what the system recorded about the record. */}
      <section className="hop">
        <h2>What was recorded, and when</h2>
        {t.audit.length === 0 ? (
          <p>No events. A submitted decision always has at least one, so this is worth reporting.</p>
        ) : (
          <ul className="register">
            {t.audit.map((a) => (
              <li key={a.id}>
                <p>{a.action}</p>
                <p className="pins">
                  <span>{a.occurredAt}</span>
                  <span>
                    actor {a.actorUserId ?? 'none — recorded as a system event, not a person'}
                  </span>
                  <span>{JSON.stringify(a.detail)}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* The hops that do not exist, named in place and in order. */}
      <section className="hop">
        <h2>Challenge, reflection and development</h2>
        <p className="field-help">
          §9.2 continues the trail through every challenge with its model version and
          generation timestamp, your responses and disputes, the reflection, the actions and
          their completion evidence. None of that exists: the AI challenge system is Slice 4
          and reflection and development are Slice 5. This is where the record stops, and it
          stops because the product does, not because this record is missing anything.
        </p>
      </section>

      <section className="hop">
        <h2>Deletion</h2>
        <p className="field-help">
          There is no delete action here, and that is not an oversight: no erasure path
          exists in the database (checked, not assumed), so a button would do nothing. FR-16
          requires deletion to follow a documented retention and backup schedule, and a
          control that promised immediate erasure would be a promise this system cannot
          keep. It arrives with that schedule.
        </p>
      </section>

      <p style={{ marginBlockStart: '32px' }}>
        <Link href="/history/">Back to your records</Link>
      </p>
    </>
  )
}

/**
 * Export, as a real file (§9.2).
 *
 * The Blob is built and revoked in the handler rather than held in state: an
 * object URL that outlives its click is a reference to the user's journal
 * sitting in memory for as long as the page is open.
 */
function ExportButton({ trail }: { readonly trail: EvidenceTrail }): React.ReactElement {
  return (
    <button
      type="button"
      className="button"
      onClick={() => {
        const doc = toExportDocument(trail)
        const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `statesman-record-${trail.decisionId}.json`
        a.click()
        URL.revokeObjectURL(url)
      }}
    >
      Export this record
    </button>
  )
}

