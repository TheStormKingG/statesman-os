'use client'

/**
 * The one page in the shell.
 *
 * ── WHY THIS IS NOW A CLIENT COMPONENT ──────────────────────────────────────
 *
 * ADR-0015: the app is a Next.js static export on GitHub Pages talking to
 * Supabase from the browser. `output: 'export'` forbids Route Handlers, so
 * `src/app/api/health/route.ts` was deleted in the same change. What that
 * endpoint proved — the chain from the client to the database, and that the
 * data boundary refuses to serve without a verified identity — is proved here
 * instead, from the browser, which is strictly more honest: it exercises the
 * path a user actually takes rather than a path only the server could take.
 *
 * The whole page is `'use client'` rather than a server component wrapping a
 * client child. A static export prerenders this file to HTML at build time
 * either way, so nothing is lost, and the alternative would split one page
 * across two files for no behavioural difference.
 *
 * ── WHAT THIS PAGE MAY NOT DO, and why it is written the way it is ──────────
 *
 * Canon §1.2 prohibits simulated outcomes presented as forecasts and invented
 * institutional content; canon §11 and PRD §9.4 forbid sample metrics standing
 * in for personal history. A placeholder dashboard, a mock decision card, a
 * demo streak or an example scenario would each be a claim about a person who
 * has not used the product yet, and the whole premise of STATESMAN OS is that
 * it does not grade or flatter anyone on evidence it does not have. So this
 * page shows no product surface at all. It says what exists, what does not, and
 * where to look. Every file path named below was checked against the tree; none
 * is aspirational.
 *
 * That constraint binds the chain check too. It reports what it observed and
 * refuses to upgrade an observation into a guarantee — see the long note on
 * `ZERO_ROWS_IS_NOT_A_PASS` below, which is the single most important comment
 * in this file.
 */

import { useEffect, useState } from 'react'

/* ------------------------------------------------------------------ *
 * Configuration
 *
 * Read as direct `process.env.<NAME>` member expressions so Next inlines the
 * literal value into the bundle at build time. That inlining is what makes a
 * static export able to reach a database at all, and it is also why the anon
 * key is public by design: it ships in the JavaScript that GitHub Pages
 * serves, readable by anyone. docs/deployment.md states why that is correct
 * and what must never be published alongside it.
 *
 * Both are read, and a missing one is REPORTED rather than defaulted. A bundle
 * built without them cannot reach the database, and a page that said nothing
 * about it would present an unreachable backend as a denied read — the two
 * look identical from the outside and mean opposite things.
 * ------------------------------------------------------------------ */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

/**
 * The table the probe reads.
 *
 * `public.decision` is the journal: RLS enabled and FORCED, scoped to the
 * owning user. It is deliberately the hardest target rather than a harmless
 * one, because a probe against an unprotected content table would prove only
 * that the network works.
 */
const PROBE_TABLE = 'decision'

/**
 * ── ZERO ROWS IS NOT A PASS. This is the load-bearing honesty in this file. ──
 *
 * Three measured facts make a naive "0 rows means the policy worked" claim
 * false:
 *
 *   V7      a row count of 0 is never a success signal.
 *   ADR-0015 `auth.uid()` returns NULL where `app.require_user_id()` raised
 *           28000. A missing identity no longer announces itself: the read
 *           returns zero rows and NO error.
 *   V18     an EMPTY table under FORCE RLS does not deny at all. The policy
 *           qual is never evaluated, so an empty protected table and a table
 *           with no policy whatsoever both return zero rows.
 *
 * `supabase/migrations/20261021140600_sentinels.sql` exists for exactly this
 * reason: it seeds one reserved-owner row per protected table, so that "0 rows"
 * becomes evidence instead of an ambiguity. But this page CANNOT verify that the
 * sentinel is
 * present, and the reason is not laziness — confirming it would require
 * reading the very row the policy is supposed to withhold. The check therefore
 * reports zero rows as DENIED and states the condition it rests on, in the
 * interface, where the reader can see it. An integration test connecting as
 * `authenticated` with a JWT claim is the instrument that settles it; a browser
 * is not.
 */
const ZERO_ROWS_IS_NOT_A_PASS =
  'Zero rows is not by itself proof. A missing identity returns zero rows and no error on ' +
  'Supabase, and an empty table under forced row level security returns zero rows too, ' +
  'because the policy is never evaluated. This reads as a refusal only if the seeded ' +
  'sentinel row is present — and this page cannot check that, because checking it would ' +
  'mean reading the row the policy is meant to withhold.'

/* ------------------------------------------------------------------ *
 * The probe
 * ------------------------------------------------------------------ */

type ProbeState =
  /** The effect has not run. With JavaScript off, this is the final state. */
  | { readonly kind: 'not_started' }
  | { readonly kind: 'running' }
  /** `NEXT_PUBLIC_SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_ANON_KEY` was absent at build time. */
  | { readonly kind: 'no_config'; readonly missing: readonly string[] }
  /** The request never got an answer: offline, DNS, CORS, blocked. */
  | { readonly kind: 'unreachable'; readonly detail: string }
  /** The schema is not deployed to this project yet. */
  | { readonly kind: 'no_schema'; readonly code: string; readonly detail: string }
  /** The grant model refused before RLS was consulted. */
  | { readonly kind: 'no_grant'; readonly code: string; readonly detail: string }
  /** Reached, answered, zero rows. See `ZERO_ROWS_IS_NOT_A_PASS`. */
  | { readonly kind: 'denied'; readonly role: string }
  /** Reached, answered, rows returned to a caller with no identity. A finding. */
  | { readonly kind: 'rows_returned'; readonly count: number; readonly role: string }
  /** Answered with an error this file does not classify. */
  | { readonly kind: 'error'; readonly code: string; readonly detail: string }

function missingConfigKeys(): readonly string[] {
  const missing: string[] = []
  if (SUPABASE_URL == null || SUPABASE_URL === '') missing.push('NEXT_PUBLIC_SUPABASE_URL')
  if (SUPABASE_ANON_KEY == null || SUPABASE_ANON_KEY === '') {
    missing.push('NEXT_PUBLIC_SUPABASE_ANON_KEY')
  }
  return missing
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** How much of a reported detail is shown. */
const DETAIL_MAX = 180

/**
 * One line, bounded.
 *
 * MEASURED: on a fetch failure the library's `details` field carried the whole
 * stack trace, including the hashed chunk URLs, and the page rendered all of
 * it. A diagnostic that floods the interface stops being read, and the chunk
 * paths say nothing a reader can act on. The first line is the message; the
 * rest belongs in the browser console, where it still is.
 */
function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? text
  const trimmed = line.trim()
  return trimmed.length > DETAIL_MAX ? `${trimmed.slice(0, DETAIL_MAX)}…` : trimmed
}

/**
 * Runs the round trip. Never rejects: every outcome, including a thrown
 * network error, is returned as a state so the page can report it. A probe
 * that can throw would report nothing in the one case worth reporting.
 *
 * The client is constructed HERE rather than at module scope. This module is
 * evaluated during prerender, in Node, where there is no browser storage for
 * the auth client to attach to; building it inside the effect keeps
 * construction in the browser where it belongs.
 */
async function runProbe(): Promise<ProbeState> {
  const missing = missingConfigKeys()
  if (missing.length > 0) return { kind: 'no_config', missing }
  /* Narrowed by `missingConfigKeys`, but that is a function boundary the
     compiler cannot see through, so the values are re-read as locals. */
  const url = SUPABASE_URL
  const key = SUPABASE_ANON_KEY
  if (url == null || key == null) return { kind: 'no_config', missing: ['unknown'] }

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(url, key)

    /* Which role the request will be made as. No Supabase Auth session means
       `anon`; sign in is not built yet, so `anon` is the expected answer and a
       session here would itself be worth seeing. */
    const { data: sessionData } = await supabase.auth.getSession()
    const role = sessionData.session == null ? 'anon' : 'authenticated'

    /* `head: false`, and no `count`. A count over a protected table is the
       wrong instrument twice over: it tells you nothing a row read does not,
       and it invites the unscoped-count mistake the unit gate exists to catch.
       `limit(1)` is enough — the question is whether ANY row comes back. */
    const { data, error } = await supabase.from(PROBE_TABLE).select('id').limit(1)

    if (error != null) {
      /* ── A FETCH FAILURE IS NOT AN ANSWER ────────────────────────────────
       *
       * MEASURED, and it corrected this file: pointed at a hostname that does
       * not resolve, the probe first reported "Supabase answered with an error
       * ... Code unknown: TypeError: Failed to fetch". Supabase had not
       * answered at all. The library does not throw when the fetch itself
       * fails — it catches the `TypeError` and returns it in the ERROR
       * position, so an unreached server arrives looking exactly like a
       * database error. Observed in that run: `message` was
       * "TypeError: Failed to fetch", `code` was the EMPTY STRING, and
       * `details` carried the whole stack trace including the hashed chunk
       * URLs (which is why `firstLine` exists).
       *
       * The discriminator is the empty code. PostgREST and PostgreSQL always
       * supply one for a real error; the library leaves it empty only on this
       * path. Misreporting it would be the specific dishonesty this page
       * exists to avoid — claiming knowledge about a database nothing reached.
       */
      if (error.code === '') {
        return { kind: 'unreachable', detail: firstLine(error.message) }
      }
      const code = error.code
      /* 42P01 is PostgreSQL's undefined_table. PGRST205 is PostgREST failing
         to find the table in its schema cache, which is what a project with
         no migrations applied actually answers. */
      if (code === '42P01' || code === 'PGRST205') {
        return { kind: 'no_schema', code, detail: firstLine(error.message) }
      }
      /* 42501 is insufficient_privilege: the grant model refused before RLS
         was reached. That is a refusal, and a different one from a policy
         refusal, so it is reported separately rather than folded in. */
      if (code === '42501') return { kind: 'no_grant', code, detail: firstLine(error.message) }
      return { kind: 'error', code, detail: firstLine(error.message) }
    }

    /* No `data == null` guard. The library's return type is a discriminated
       union — `error: null` implies `data: T[]` — so a null check here is dead
       code and `@typescript-eslint/no-unnecessary-condition` rejects it. If the
       library ever broke that contract, the property access would throw and
       land in the `catch` below rather than passing silently. */
    if (data.length > 0) return { kind: 'rows_returned', count: data.length, role }
    return { kind: 'denied', role }
  } catch (err: unknown) {
    return { kind: 'unreachable', detail: firstLine(messageOf(err)) }
  }
}

/* ------------------------------------------------------------------ *
 * Rendering
 *
 * Labels are short because `.status-list` gives them a 12ch column at
 * >=34rem; a longer word would spill out of it. Nothing here is colour-coded:
 * DESIGN.md §1 forbids colour carrying evaluative meaning, so the word is the
 * signal.
 * ------------------------------------------------------------------ */

function labelFor(state: ProbeState): string {
  switch (state.kind) {
    case 'not_started':
      return 'Not run'
    case 'running':
      return 'Checking'
    case 'no_config':
      return 'No config'
    case 'unreachable':
      return 'No answer'
    case 'no_schema':
      return 'No schema'
    case 'no_grant':
      return 'No grant'
    case 'denied':
      return 'Refused'
    case 'rows_returned':
      return 'Returned'
    case 'error':
      return 'Error'
  }
}

function ChainCheckResult({ state }: { readonly state: ProbeState }) {
  switch (state.kind) {
    case 'not_started':
      return (
        <span>
          This check runs in your browser when the page loads, so it needs JavaScript. With
          JavaScript off it does not run, and nothing is claimed either way.
        </span>
      )

    case 'running':
      return <span>Reading one row from the journal table. No row is written.</span>

    case 'no_config':
      return (
        <span>
          This bundle was built without{' '}
          {state.missing.map((name, i) => (
            <span key={name}>
              {i > 0 ? ' and ' : ''}
              <code>{name}</code>
            </span>
          ))}
          , so it has no database to reach and the check cannot run. Nothing below this line is
          a statement about the database. See <code>docs/deployment.md</code>.
        </span>
      )

    case 'unreachable':
      return (
        <span>
          The request did not get an answer, so nothing about the database is known from it —
          not that it is down, and not that it is protected. Reported detail:{' '}
          <code>{state.detail}</code>
        </span>
      )

    case 'no_schema':
      return (
        <span>
          Supabase answered, so the round trip works, but it has no{' '}
          <code>public.{PROBE_TABLE}</code> to read: the schema has not been migrated to this
          project yet. Code <code>{state.code}</code>. This is the expected answer until the
          migration port lands.
        </span>
      )

    case 'no_grant':
      return (
        <span>
          Supabase answered and refused on privileges, before row level security was consulted:
          the role this page connects as holds no <code>select</code> on{' '}
          <code>public.{PROBE_TABLE}</code>. Code <code>{state.code}</code>. A refusal, and a
          stronger one than a policy refusal, because it does not depend on a policy being
          right.
        </span>
      )

    case 'denied':
      return (
        <span>
          The round trip completed as <code>{state.role}</code> and returned no rows.{' '}
          {ZERO_ROWS_IS_NOT_A_PASS}
        </span>
      )

    case 'rows_returned':
      return (
        <span>
          <strong>
            The journal table returned {state.count === 1 ? 'a row' : `${String(state.count)} rows`}{' '}
            to this page as <code>{state.role}</code>.
          </strong>{' '}
          No one is signed in, so no row should be readable. Either a policy is missing or it is
          wrong, and row level security is the only thing protecting this data. Treat this as a
          breach until a policy test connecting as <code>authenticated</code> says otherwise.
        </span>
      )

    case 'error':
      return (
        <span>
          Supabase answered with an error this page does not classify, so it is reported raw
          rather than interpreted. Code <code>{state.code}</code>:{' '}
          <code>{state.detail}</code>
        </span>
      )
  }
}

export default function HomePage() {
  const [state, setState] = useState<ProbeState>({ kind: 'not_started' })

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'running' })
    void runProbe().then((result) => {
      if (!cancelled) setState(result)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="page">
      <header>
        <p className="eyebrow">Development shell</p>
        <h1>STATESMAN OS</h1>
        <p className="lede">
          A private practice system for one person: decide, be challenged, reflect, record what
          changed. Nothing here is shared, published or scored.
        </p>
      </header>

      <main id="main">
        <section aria-labelledby="what-this-is">
          <h2 id="what-this-is">What you are looking at</h2>
          <p>
            This is not the product. It is a shell that exists to prove the stack is wired
            together. There are no screens yet.
          </p>
          <p>
            It shows no decisions, no scenarios, no assessments and no history, because it has
            none. Sample content on this page would be a fabricated record of someone&rsquo;s
            judgement, which is the one thing this product is built not to do.
          </p>
        </section>

        <section aria-labelledby="how-it-runs">
          <h2 id="how-it-runs">How this page runs</h2>
          <p>
            These files are static. They are built ahead of time and served by GitHub Pages,
            which runs no code of ours: there is no server in the request path, no session
            cookie and no server-side database connection. The page talks to the database
            directly from your browser, using a publishable key that ships inside this
            JavaScript and is meant to be readable.
          </p>
          <p>
            So <strong>row level security in the database is the only thing protecting the
            data.</strong> The three layers that used to stand in front of it — a server
            boundary, a privileged-role model, and the policies — are down to the policies
            alone. That is the trade this deployment makes, and{' '}
            <code>docs/adr/ADR-0015-static-github-pages-plus-supabase.md</code> states it in
            full.
          </p>
        </section>

        <section aria-labelledby="chain-check">
          <h2 id="chain-check">Checking the chain</h2>
          <p>
            On load, this page reads one row from the journal table in the database. Nobody is
            signed in, so the correct outcome is a refusal. It is a read; nothing is written.
          </p>
          <ul className="status-list panel">
            <li>
              <span className="status-label">{labelFor(state)}</span>
              <ChainCheckResult state={state} />
            </li>
          </ul>
          <p>
            What this check cannot establish: that the policies are correct. A browser with no
            identity can only observe that it was refused, and being refused is also what an
            empty table and an unreachable database look like. Correctness is settled by the
            policy tests, which connect as the authenticated role with a verified claim, and by
            the mutation gate, which proves each of those tests can fail. Until those run
            against this project, nothing on this page should be read as a security guarantee.
          </p>
        </section>

        <section aria-labelledby="slice-status">
          <h2 id="slice-status">Build status</h2>
          <p>
            Slices are numbered as <code>docs/implementation-plan.md</code> numbers them. This
            list describes the <strong>interface</strong>, not the repository: it says which
            parts of the product you can use, which is a thing this page can be honest about
            without going stale every time work lands in the database layer.
          </p>
          <ul className="status-list panel">
            <li>
              <span className="status-label">Usable</span>
              <span>
                This shell, and nothing else. One page, the chain check above, the design token
                layer.
              </span>
            </li>
            <li>
              <span className="status-label">No screen</span>
              <span>
                Slice 1, the secure foundation: the schema, row level security enabled and
                forced on the user-owned tables, the immutability triggers, the state machine and
                the SQL posture check. It has no interface of its own; the check above is the
                only part of it this page can show you.
              </span>
            </li>
            <li>
              <span className="status-label">No screen</span>
              <span>
                Sign in and sign up. No account can be created and no session can be
                established, which is why no screen that reads your data could work yet even if
                one existed, and why the check above runs with no identity.
              </span>
            </li>
            <li>
              <span className="status-label">No screen</span>
              <span>
                Slice 2, the scenario content, source register and claim whitelist. It arrives as
                migrations and seed data, so nothing on this page changes when it lands.
              </span>
            </li>
            <li>
              <span className="status-label">No screen</span>
              <span>
                Slices 3 to 6: Today, the Decision Desk, Challenge Review, Reflection and
                Development, Review History, the AI challenge system, and the hardening pass.
              </span>
            </li>
          </ul>
        </section>
      </main>

      <footer>
        <p>
          Private workspace. Not for publication, not for assessment of real officials, and not a
          source of legal, financial or political advice.
        </p>
      </footer>
    </div>
  )
}
