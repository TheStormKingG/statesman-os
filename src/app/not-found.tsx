import Link from 'next/link'
import type { Metadata } from 'next'

/**
 * Our own 404, replacing Next's built-in error page.
 *
 * ── WHY THIS EXISTS, AND IT IS NOT COSMETIC ─────────────────────────────────
 * ADR-0020 delivers the CSP as a `<meta http-equiv>` tag, because GitHub Pages
 * serves static files and sets no response headers. A meta-delivered CSP can
 * cover `<script>` and `<style>` ELEMENTS by sha256 hash, but an inline `style`
 * ATTRIBUTE in markup is not coverable by an element hash: it needs
 * `'unsafe-hashes'` or `'unsafe-inline'`, both of which widen the policy.
 *
 * Next's default error page emits four inline `style` attributes and one
 * `<style>` element into `out/404.html`, `out/404/index.html` and
 * `out/_not-found/index.html`. Measured before this file existed:
 *
 *     out/404.html   4 style attrs, 1 inline style element
 *
 * None of it is ours, and keeping it would have forced `style-src` open for the
 * whole site to accommodate a page nobody styles. Replacing the page removes the
 * markup instead, so `style-src 'self'` needs no hash and no exception. The
 * product pages already contribute none: they render client-side, and React
 * applies `style={{...}}` through CSSOM, which CSP does not govern.
 *
 * So: no inline styles here, ever. `scripts/check-csp.mjs` fails the build if any
 * emitted HTML carries a `style` attribute, which is what keeps this true rather
 * than merely intended.
 */
export const metadata: Metadata = {
  title: 'Page not found — STATESMAN OS',
}

export default function NotFound() {
  return (
    <main className="page" id="main">
      <p className="eyebrow">404</p>
      <h1>That page does not exist</h1>
      <p className="lede">
        The address is wrong, or it points at a surface this build does not have yet. Several
        parts of the product — Challenge Review, Reflection and the Development Plan — have no
        screen at all, deliberately, and nothing here invents one.
      </p>
      <p>
        <Link className="button button--primary" href="/today/">
          Go to Today
        </Link>
      </p>
    </main>
  )
}
