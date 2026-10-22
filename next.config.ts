import type { NextConfig } from 'next'

/**
 * Next configuration for the GitHub Pages static export (ADR-0015).
 *
 * ── WHAT `output: 'export'` COSTS, STATED UP FRONT ──────────────────────────
 *
 * There is no server at runtime. GitHub Pages serves files. So this setting is
 * not a build tweak, it is the architecture: Route Handlers, Server Actions and
 * any Server Component that needs request-time data cannot exist in the
 * shipped artefact. `src/app/api/health/route.ts` was deleted in the same
 * change that added this line, because a route that cannot exist in the
 * artefact but still sits in the tree is a lie about what runs. What it proved
 * — that the chain from browser to database is wired and the data boundary
 * refuses to serve without an identity — is now proved from the browser, which
 * is the path a user actually takes.
 *
 * `src/server/db/**` and `src/server/session/resolve.ts` still typecheck and
 * still pass the boundary gate, but nothing in the app graph imports them any
 * more, so they are not bundled. They are not deleted here: that is ADR-0015's
 * migration work, not this change's, and deleting verified code is a separate
 * decision with its own evidence.
 *
 * ── basePath / assetPrefix ──────────────────────────────────────────────────
 *
 * The site serves from https://thestormkingg.github.io/statesman-os/, a
 * PROJECT page, so every absolute path the bundle emits must be prefixed with
 * the repository name or every asset 404s. MEASURED, not reasoned: after
 * `next build` the emitted `out/index.html` references
 * `/statesman-os/_next/static/...`, and `grep -c '"/_next/' out/index.html`
 * returns 0. That grep is the real check — a wrong basePath produces a page
 * that looks correct in the HTML source and is blank in the browser.
 *
 * It is set UNCONDITIONALLY rather than behind an environment flag. A basePath
 * that is empty in development and set in production means development cannot
 * catch a basePath mistake, and this is the exact class of bug that only shows
 * up once deployed. The cost is that `next dev` serves the app at
 * http://localhost:3000/statesman-os rather than at the root. That is the
 * intended trade: one code path, exercised everywhere.
 *
 * If a custom domain is ever attached, the site moves to the root of that
 * domain and BOTH values must become `undefined` in the same commit as the
 * DNS change. They are written as a single constant below so there is one
 * place to do it.
 *
 * `assetPrefix` is stated explicitly even though `basePath` already prefixes
 * assets. The two are separable — a CDN deployment sets `assetPrefix` alone —
 * so leaving it implicit would make a future split silently change behaviour.
 *
 * ── trailingSlash ───────────────────────────────────────────────────────────
 *
 * `true`, so the export writes `out/<route>/index.html` instead of
 * `out/<route>.html`. GitHub Pages resolves a directory to its `index.html`
 * deterministically; whether it rewrites an extensionless `/route` to
 * `route.html` is not something this repository has measured, and there is
 * currently one route, so the question would go unanswered until Slice 3 added
 * the second one and broke it. Directory form removes the question.
 *
 * ── `images` is deliberately absent ─────────────────────────────────────────
 *
 * `output: 'export'` rejects the default Image Optimization loader, so a
 * project using `next/image` must set `images: { unoptimized: true }`. This
 * one does not use `next/image` anywhere (checked, not assumed), so the key is
 * left out rather than added pre-emptively. The build is the gate: if an image
 * component lands later, `next build` fails loudly and names this setting.
 *
 * ── ON CANON §8.7's "`next build` may not lint" ──────────────────────────────
 *
 * MEASURED against the installed next@16.4.2 rather than written from memory
 * (canon O4). The first version of this file carried
 * `eslint: { ignoreDuringBuilds: true }`, which is the Next 14/15 shape. On
 * next@16.4.2 the build answered:
 *
 *   ⚠ `eslint` configuration in next.config.ts is no longer supported
 *   ⚠ Unrecognized key(s) in object: 'eslint'
 *   next.config.ts(17,3): error TS2353: ... 'eslint' does not exist in type 'NextConfig'
 *
 * and FAILED the type check. The key is gone because the bundled lint pass is
 * gone: there is nothing to switch off, so §8.7's requirement holds
 * structurally in this version and `npm run lint` is the only linter. The
 * option is left out rather than re-added in some other spelling.
 *
 * `typescript.ignoreBuildErrors` is deliberately NOT set. `npx tsc --noEmit` is
 * its own gate, and letting the build typecheck as well costs nothing and
 * covers the generated route types that a bare `tsc` run would not see. That is
 * also what caught the mistake above.
 *
 * `agentRules: false` stops `next dev` writing an `AGENTS.md` into the
 * repository root. MEASURED: the first `next dev` run of this slice printed
 * "✓ Generated AGENTS.md for AI agents" and created the file, which is an
 * untracked root document this project did not ask for and does not own.
 *
 * `poweredByHeader: false` is INERT under `output: 'export'` — there is no
 * server to send a header. It is kept because `next dev` still serves one, and
 * removing it would silently reintroduce the header to the only process that
 * can emit it.
 */

/**
 * The GitHub Pages project-page prefix: the repository name, leading slash, no
 * trailing slash. One constant, because `basePath` and `assetPrefix` must
 * never disagree and a custom-domain move has to change both at once.
 */
const PAGES_BASE_PATH = '/statesman-os'

const nextConfig: NextConfig = {
  output: 'export',
  basePath: PAGES_BASE_PATH,
  assetPrefix: PAGES_BASE_PATH,
  trailingSlash: true,
  poweredByHeader: false,
  agentRules: false,
}

export default nextConfig
