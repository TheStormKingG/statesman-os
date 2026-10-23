'use client'

/**
 * Screen A — Today.
 *
 * `docs/ui-ux-design.md` §5: "present one decision and the open actions.
 * Nothing else." One `--surface` panel, a single column, left-aligned, and in
 * the order that section fixes:
 *
 *   1. sector and jurisdiction, mono xs
 *   2. the fiction and date stamp, ALWAYS VISIBLE, never behind a disclosure
 *   3. scenario title at 2xl
 *   4. the decision task in one sentence at lg
 *   5. three facts as a plain definition list
 *   6. one primary action
 *
 * ── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────────
 *
 * No score of any kind, no streak, no completion ring, no "you are on track",
 * no counter of days practised, no chart. PRD §5.1 says the secondary content is
 * open actions and recent factual feedback, "not a large readiness score", and
 * CLAUDE.md §2 lists a composite score first among the hard prohibitions.
 * `tests/unit/no-composite-score.test.ts` fails the build if one appears.
 *
 * ── AND WHY THERE IS NO EMPTY "OPEN ACTIONS" LIST ───────────────────────────
 *
 * §5 specifies an open-actions list whose empty state reads `No open actions.`
 * That copy is correct once development actions exist. They do not: the schema
 * holds eight tables and none of them records an action (checked, not assumed).
 * Rendering `No open actions.` would state that we looked and found none, which
 * is a different claim from "this does not exist yet" and the kind of small lie
 * this product is built not to tell. So the section says what is true instead,
 * and the copy §5 specifies arrives with the table in Slice 5.
 */

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { AuthGate } from '../../components/AuthGate'
import { loadPublishedScenario } from '../../lib/supabase/scenarios'
import type { ScenarioBrief } from '../../lib/supabase/scenarios'
import { publicMessageFor } from '../../lib/supabase/errors'

export default function TodayPage(): React.ReactElement {
  return (
    <main className="page" id="main">
      <AuthGate>{() => <TodayBody />}</AuthGate>
    </main>
  )
}

type Load =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly brief: ScenarioBrief }
  | { readonly phase: 'none'; readonly note: string }
  | { readonly phase: 'error'; readonly message: string }

function TodayBody(): React.ReactElement {
  const [load, setLoad] = useState<Load>({ phase: 'loading' })

  useEffect(() => {
    let cancelled = false
    loadPublishedScenario()
      .then((outcome) => {
        if (cancelled) return
        setLoad(
          outcome.kind === 'row'
            ? { phase: 'ready', brief: outcome.row }
            : { phase: 'none', note: outcome.note },
        )
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoad({ phase: 'error', message: publicMessageFor(error) })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <>
      <p className="eyebrow">Today</p>
      <h1>Today&apos;s decision</h1>

      {load.phase === 'loading' ? <p className="autosave">Loading the case.</p> : null}

      {load.phase === 'error' ? (
        <p className="notice" role="alert">
          The case could not be loaded. {load.message}
        </p>
      ) : null}

      {load.phase === 'none' ? (
        <section className="panel">
          <h2>No published case</h2>
          {/*
            `outcome.note` says, in the data layer's own words, that zero rows
            cannot distinguish a denial from an absence. It is shown rather than
            paraphrased, because paraphrasing it into "there are no cases" would
            assert the one of the three possibilities we cannot establish.
          */}
          <p>{load.note}</p>
        </section>
      ) : null}

      {load.phase === 'ready' ? <DecisionCard brief={load.brief} /> : null}

      <section>
        <h2>Open actions</h2>
        <p className="field-help">
          Development actions are recorded after a reflection, which arrives with Slice 5.
          There is no table for them yet, so this is not an empty list: it is a part of the
          product that does not exist. Nothing has been counted.
        </p>
      </section>
    </>
  )
}

function DecisionCard({ brief }: { readonly brief: ScenarioBrief }): React.ReactElement {
  return (
    <section className="panel">
      {/* 1. Sector and jurisdiction. */}
      <p className="meta-line">
        <span>{brief.sector}</span>
        <span>{brief.jurisdiction}</span>
      </p>

      {/* 2. The fiction and date stamp. FR-02, and not decoration. */}
      <p style={{ marginBlockStart: '12px' }}>
        <FictionMarker brief={brief} />
      </p>

      {/* 3. The title. */}
      <h2 style={{ fontSize: '28px', marginBlockStart: '16px' }}>{brief.title}</h2>

      {/* 4. The task, in the one sentence the case states it in. */}
      <p className="lede">{brief.learningObjective}</p>

      {/* 5. The three facts. */}
      <dl className="facts">
        <dt>Time window</dt>
        <dd>
          {brief.windowHours} hours in the case. Interim plan due: {brief.interimMilestone}
        </dd>
        <dt>Estimated effort</dt>
        <dd>
          <span className="mono">{brief.estimatedEffortMinutes}</span> minutes
        </dd>
        <dt>Assumed role</dt>
        <dd>{brief.roleTitle}</dd>
      </dl>

      {/* 6. One primary action. */}
      <div className="button-row" style={{ marginBlockStart: '24px' }}>
        <Link
          className="button button--primary"
          href={{ pathname: '/desk/', query: { v: brief.scenarioVersionId } }}
        >
          Start decision
        </Link>
      </div>
    </section>
  )
}

/**
 * The fiction and date stamp.
 *
 * `isFiction` comes from the `scenario_version.is_fiction` COLUMN. If a case
 * ever arrives with it false, this renders NO fiction claim rather than the
 * label: a marker saying "fictional" over real material would be worse than
 * none, and the opposite — real-world content presented unlabelled — is why the
 * column is `not null` and why M15 exists to prove that cannot be dropped.
 *
 * `fictionNoticeAgrees` reports a disagreement between the column and the
 * content's own notice instead of silently preferring one. Two sources saying
 * different things about whether material is invented is a content fault worth
 * surfacing on the screen that presents it.
 */
function FictionMarker({ brief }: { readonly brief: ScenarioBrief }): React.ReactElement {
  return (
    <>
      <span className="fiction-marker">
        {brief.isFiction ? <span>Fictional training case.</span> : null}
        <span>As of {brief.asOfDate}.</span>
      </span>
      {brief.fictionNoticeAgrees ? null : (
        <span className="field-error" role="alert">
          {' '}
          This case&apos;s own notice disagrees with its fiction flag. Treat the material as
          unverified and report it.
        </span>
      )}
    </>
  )
}
