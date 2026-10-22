/**
 * The one page in the shell.
 *
 * WHAT THIS PAGE MAY NOT DO, and why it is written the way it is.
 *
 * Canon §1.2 prohibits simulated outcomes presented as forecasts and invented
 * institutional content; canon §11 and PRD §9.4 forbid sample metrics standing
 * in for personal history. A placeholder dashboard, a mock decision card, a
 * demo streak or an example scenario would each be a claim about a person who
 * has not used the product yet, and the whole premise of STATESMAN OS is that
 * it does not grade or flatter anyone on evidence it does not have. So this
 * page shows no product surface at all. It says what exists, what does not, and
 * where to look. Every file path and route named below was checked against the
 * tree; none is aspirational.
 *
 * It is also a server component with no client JavaScript: there is no state to
 * hold.
 */

/* `NODE_ENV` is `'production'` during `next build`, so the production bundle of
 * this page simply does not contain the development-endpoint section. The
 * endpoint refuses to serve there in any case; this keeps the page from
 * advertising a route that would answer 404. */
const isDevelopment = process.env['NODE_ENV'] !== 'production'

export default function HomePage() {
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
            together: a browser request reaches the Next.js server, the server reaches PostgreSQL
            as the unprivileged application role, and the data boundary refuses to serve without a
            verified identity. There are no screens yet.
          </p>
          <p>
            It shows no decisions, no scenarios, no assessments and no history, because it has
            none. Sample content on this page would be a fabricated record of someone&rsquo;s
            judgement, which is the one thing this product is built not to do.
          </p>
        </section>

        <section aria-labelledby="slice-status">
          <h2 id="slice-status">Build status</h2>
          <p>
            Slices are numbered as <code>docs/implementation-plan.md</code> numbers them. This list
            describes the <strong>interface</strong>, not the repository: it says which parts of the
            product you can use, which is a thing this page can be honest about without going stale
            every time work lands in the database layer.
          </p>
          <ul className="status-list panel">
            <li>
              <span className="status-label">Usable</span>
              <span>
                This shell, and nothing else. One page, one development health endpoint, the design
                token layer.
              </span>
            </li>
            <li>
              <span className="status-label">No screen</span>
              <span>
                Slice 1, the secure foundation: the <code>app</code> schema functions, row level
                security enabled and forced on the user owned tables, the SQL posture check, and the
                data boundary in <code>src/server/db/</code>. It is the thing the health endpoint
                exercises, and it has no interface of its own.
              </span>
            </li>
            <li>
              <span className="status-label">No screen</span>
              <span>
                Sign in and sign up. No account can be created and no session can be established,
                which is why no screen that reads your data could work yet even if one existed.
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

        {isDevelopment ? (
          <section aria-labelledby="health">
            <h2 id="health">Checking the chain yourself</h2>
            <p>
              <a href="/api/health">/api/health</a> performs the round trip and reports what it
              could and could not establish. It is a development endpoint and answers 404 when{' '}
              <code>NODE_ENV</code> is <code>production</code>.
            </p>
            <p>
              It cannot report the current database, the migration state or the posture check
              result, and it says so rather than guessing. Those three need a database read, the
              only read path requires a verified session, and sign in does not exist yet. The
              posture check additionally has no <code>EXECUTE</code> grant to the application role
              by design: it runs as the schema owner at the end of every migration run.
            </p>
          </section>
        ) : null}
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
