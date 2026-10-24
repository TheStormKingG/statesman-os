/* global console, process, URL */
// Following the convention in mutations/lib/vitest-summary.mjs: the flat config gives
// *.mjs no Node globals, so these would trip no-undef and break `npm run lint`.
/**
 * scripts/csp.mjs — the Content-Security-Policy for a static export, as a
 * `<meta http-equiv>` tag with per-file sha256 hashes.
 *
 * ===========================================================================
 * WHY A META TAG AND WHY HASHES. READ BEFORE CHANGING THE POLICY.
 * ===========================================================================
 * ADR-0015 put this app on GitHub Pages, which serves static files and sets no
 * response headers. `next.config.ts` says so itself: `poweredByHeader: false` is
 * "INERT under `output: 'export'` — there is no server to send a header". So the
 * plan's instruction to set the CSP in `next.config.ts` has no mechanism, and the
 * only delivery left is `<meta http-equiv="Content-Security-Policy">`.
 *
 * Next 16.4.2 emits THREE inline `<script>` elements per page for its hydration
 * bootstrap. A nonce requires a server to mint one per response, so the choice
 * was `'unsafe-inline'` — which disables script-src against exactly the stored
 * XSS this policy exists for — or sha256 hashes computed per build. Hashes were
 * chosen. They are per FILE, because the inline payload differs per page.
 *
 * WHAT A META-DELIVERED CSP CANNOT DO, recorded rather than glossed:
 *   * `frame-ancestors`, `report-uri`/`report-to` and `sandbox` are IGNORED in a
 *     meta tag. Clickjacking therefore has no control on this host at all
 *     (residual R-23), and there is no violation reporting.
 *   * `X-Content-Type-Options`, `Strict-Transport-Security` and
 *     `Permissions-Policy` have no meta form whatsoever.
 * Only `Referrer-Policy` has a real equivalent, `<meta name="referrer">`, which
 * is emitted alongside.
 *
 * An inline `style` ATTRIBUTE is not coverable by an element hash — it needs
 * `'unsafe-hashes'` or `'unsafe-inline'`. Rather than widen `style-src` for the
 * whole site, `src/app/not-found.tsx` replaced Next's default error page, which
 * was the only source of them. `check` fails if any reappear.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const META_MARK = 'http-equiv="Content-Security-Policy"'

/** Inline `<script>` elements: no `src` attribute. */
const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g
const INLINE_STYLE_EL = /<style[^>]*>([\s\S]*?)<\/style>/g
const STYLE_ATTR = /\sstyle="[^"]*"/g

export function sha256(text) {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`
}

export function htmlFiles(root) {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.html')) out.push(full)
    }
  }
  walk(root)
  return out.sort()
}

/**
 * The directive map. THIS FUNCTION IS THE OWNER of the policy: `MASTER_PROMPT.md`
 * §8 says only "content-security and other relevant headers" and enumerates
 * none, so ADR-0020 defines it here and nowhere else.
 *
 * Every origin is derived or 'self' — measured, not assumed: the built HTML
 * references zero external URLs, and the only external origin anywhere in the
 * bundle is the Supabase project read from NEXT_PUBLIC_SUPABASE_URL.
 */
export function policy({ scriptHashes, styleHashes, supabaseOrigin }) {
  const d = [
    ["default-src", ["'none'"]],
    ["script-src", ["'self'", ...scriptHashes]],
    ["style-src", ["'self'", ...styleHashes]],
    ["img-src", ["'self'"]],
    ["font-src", ["'self'"]],
    ["connect-src", ["'self'", supabaseOrigin]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'none'"]],
    ["object-src", ["'none'"]],
    ["manifest-src", ["'self'"]],
  ]
  return d.map(([k, v]) => `${k} ${v.join(' ')}`).join('; ')
}

function supabaseOriginOrDie() {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (raw === undefined || raw === '') {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL is absent, so connect-src cannot be derived. Refusing to emit a ' +
        'policy that would block every database call: a CSP guessed from a default is worse than ' +
        'none, because it fails at runtime in the browser and not here.',
    )
  }
  return new URL(raw).origin
}

export function inject(root) {
  const origin = supabaseOriginOrDie()
  const touched = []
  for (const file of htmlFiles(root)) {
    let html = readFileSync(file, 'utf8')
    if (html.includes(META_MARK)) continue // idempotent: a re-run must not stack tags

    const scriptHashes = [...html.matchAll(INLINE_SCRIPT)].map((m) => sha256(m[1]))
    const styleHashes = [...html.matchAll(INLINE_STYLE_EL)].map((m) => sha256(m[1]))
    const content = policy({ scriptHashes, styleHashes, supabaseOrigin: origin })

    const tags =
      `<meta http-equiv="Content-Security-Policy" content="${content}">` +
      `<meta name="referrer" content="strict-origin-when-cross-origin">`

    // Immediately after <head>: a CSP must precede the content it governs.
    const at = html.indexOf('<head>')
    if (at === -1) throw new Error(`${file}: no <head> to inject into`)
    html = html.slice(0, at + '<head>'.length) + tags + html.slice(at + '<head>'.length)
    writeFileSync(file, html)
    touched.push({ file, scripts: scriptHashes.length, styles: styleHashes.length })
  }
  return touched
}

/** Returns a list of problems. Empty means the artefact is good. */
export function check(root) {
  const origin = supabaseOriginOrDie()
  const problems = []
  const files = htmlFiles(root)
  if (files.length === 0) problems.push('no HTML files found: nothing was checked, which is not a pass')

  for (const file of files) {
    const html = readFileSync(file, 'utf8')
    if (!html.includes(META_MARK)) {
      problems.push(`${file}: no CSP meta tag`)
      continue
    }
    const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/)
    if (meta === null) {
      problems.push(`${file}: CSP meta tag present but unparseable`)
      continue
    }
    const content = meta[1]

    // Every inline script must have its hash in script-src, or it will be blocked
    // in the browser. This is the leg that catches a stale artefact.
    for (const m of html.matchAll(INLINE_SCRIPT)) {
      const h = sha256(m[1])
      if (!content.includes(h.slice(1, -1))) {
        problems.push(`${file}: inline <script> has no matching hash in script-src (${h})`)
      }
    }
    for (const m of html.matchAll(INLINE_STYLE_EL)) {
      const h = sha256(m[1])
      if (!content.includes(h.slice(1, -1))) {
        problems.push(`${file}: inline <style> has no matching hash in style-src (${h})`)
      }
    }
    // An inline style ATTRIBUTE cannot be covered by an element hash at all.
    const attrs = [...html.matchAll(STYLE_ATTR)]
    if (attrs.length > 0) {
      problems.push(
        `${file}: ${String(attrs.length)} inline style attribute(s). An element hash cannot cover ` +
          "these; covering them needs 'unsafe-hashes' or 'unsafe-inline', which widens style-src " +
          'for the whole site. Remove the attribute instead (see src/app/not-found.tsx).',
      )
    }
    if (!content.includes("script-src 'self' 'sha256-")) {
      problems.push(`${file}: script-src carries no hash, so the policy is not doing its job`)
    }
    if (content.includes("'unsafe-inline'") || content.includes("'unsafe-eval'")) {
      problems.push(`${file}: policy contains an unsafe-* keyword`)
    }
    if (!content.includes(`connect-src 'self' ${origin}`)) {
      problems.push(`${file}: connect-src does not admit ${origin}`)
    }
  }
  return problems
}

const mode = process.argv[2]
const root = process.argv[3] ?? 'out'
if (mode === 'inject') {
  const touched = inject(root)
  for (const t of touched) {
    console.log(`  ${t.file}  ${String(t.scripts)} script hash(es), ${String(t.styles)} style hash(es)`)
  }
  console.log(`CSP injected into ${String(touched.length)} file(s) under ${root}/`)
} else if (mode === 'check') {
  const problems = check(root)
  if (problems.length > 0) {
    console.error('CSP CHECK FAILED:')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  console.log(`CSP OK across ${String(htmlFiles(root).length)} file(s) under ${root}/`)
} else if (mode !== undefined) {
  console.error(`usage: node scripts/csp.mjs <inject|check> [root]`)
  process.exit(2)
}
