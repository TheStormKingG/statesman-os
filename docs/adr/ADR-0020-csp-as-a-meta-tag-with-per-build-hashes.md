# ADR-0020 — The CSP is a `<meta>` tag with per-build sha256 hashes, and this is its directive map

**Status:** Accepted, implemented
**Date:** 2026-10-24
**Relates to:** ADR-0015 (static export on GitHub Pages), canon §12.1 item 3, `T-44`, `T-45`,
residual `R-16`, residual `R-23`, `docs/transport-blind-spots.md`.

## Context

Canon §12.1 item 3 puts stored-XSS rendering through one escaping component **plus a CSP** into
P0 scope, and `CLAUDE.md` is blunt about why it is load-bearing rather than defence in depth:
the `freeText` factory does not reject HTML metacharacters, so there is one layer, not two.

`docs/implementation-plan.md` task 6.6 says the CSP "and the other headers of
`MASTER_PROMPT.md` §8 are set in `next.config.ts`", and its RED test asserts a **response
header** deep-equals an expected map. Both presuppose a server.

**There is none, and the config says so itself.** `next.config.ts:107` sets
`output: 'export'`, and its own comment at line 93 records that `poweredByHeader: false` is
"INERT under `output: 'export'` — there is no server to send a header". `pages.yml` uploads
`out/` and publishes it with `actions/deploy-pages`; neither configures a response header, and
no `_headers`, `static.json`, `vercel.json` or `netlify.toml` exists (and `_headers` is a
Cloudflare/Netlify convention, not a GitHub Pages one).

There was also no owner for the policy's **content**. `MASTER_PROMPT.md` §8 says only "strict
input schemas, escaped rendering, content-security and other relevant headers" and enumerates
nothing, and ADR-0015 is silent on headers. A blocking gate whose expected value lives nowhere
is passed at discretion, so this ADR defines the map.

## Decision

Deliver the CSP as `<meta http-equiv="Content-Security-Policy">`, injected into every emitted
HTML file after the build by `scripts/csp.mjs`, with **sha256 hashes computed per file**.

Next 16.4.2 emits three inline `<script>` elements per page for hydration. A nonce needs a
server to mint one per response, so the two available options were:

* **`script-src 'unsafe-inline'`** — which disables `script-src` against exactly the injected
  script this policy exists to stop. Rejected.
* **sha256 hashes per build.** Chosen. The inline payload differs per page, so hashes are
  per file, which means this is a build step rather than a config key.

### The directive map

`scripts/csp.mjs`'s `policy()` is the single owner. Every value is `'self'`, `'none'` or a
derived hash — **measured, not assumed**: the built HTML references zero external URLs, and the
only external origin anywhere in the bundle is the Supabase project, read from
`NEXT_PUBLIC_SUPABASE_URL`.

```
default-src 'none'; script-src 'self' <3 sha256 hashes>; style-src 'self'; img-src 'self';
font-src 'self'; connect-src 'self' https://<project>.supabase.co; base-uri 'none';
form-action 'none'; object-src 'none'; manifest-src 'self'
```

`connect-src` is build-generated because the origin is a build-time inlined value. The injector
**refuses to emit a policy at all** if `NEXT_PUBLIC_SUPABASE_URL` is absent, rather than
guessing a default: a wrong `connect-src` fails in the user's browser, not in CI.

### `style-src 'self'` with no hash and no exception, which took a change to earn

An inline `style` **attribute** cannot be covered by an element hash; covering one needs
`'unsafe-hashes'` or `'unsafe-inline'`, either of which widens `style-src` for the whole site.
Measured before this change, Next's default error page contributed the only ones:

```
out/404.html              4 style attrs, 1 inline <style>
out/404/index.html        4 style attrs, 1 inline <style>
out/_not-found/index.html 4 style attrs, 1 inline <style>
```

None of it was ours. Rather than widen the policy for a page nobody styles,
`src/app/not-found.tsx` replaces that page. Measured after:

```
all 7 emitted files       0 style attrs, 0 inline <style>
```

The product pages contribute none either, and for a reason worth recording: they render
client-side, and React applies `style={{…}}` through CSSOM, which CSP does not govern. Only
attributes present in markup are subject to `style-src`.

`scripts/csp.mjs check` fails if any style attribute reappears, so this stays true rather than
merely intended.

## The policy was proven not to break the app, not assumed safe

A CSP that blocks the application is worse than none. Measured by serving the real artefact over
HTTP and loading it in a browser:

* **Zero console messages.** A blocked inline script reports "Refused to execute inline script";
  none appeared.
* **14 scripts loaded**, 3 inline and 11 chunks.
* **Positive proof of hydration:** `grep -c 'Sign in' out/today/index.html` → **0**, while the
  browser showed the sign-in form. The form exists only after client-side React runs, so the
  inline bootstrap executed under the policy. "No errors" alone would not have shown this — a
  dead page also logs nothing.

## What this platform cannot do, recorded as obligations rather than dropped

A meta-delivered CSP **ignores** `frame-ancestors`, `report-uri`/`report-to` and `sandbox`. And
`X-Content-Type-Options`, `Strict-Transport-Security` and `Permissions-Policy` have **no meta
form at all**.

So, on GitHub Pages:

* **Clickjacking has no control.** Residual `R-23` (ADR-0019) — not unbuilt, *not buildable*
  without changing where this is hosted.
* **There is no violation reporting**, so a policy that silently breaks a future page will be
  discovered by a user, not by telemetry.
* **MIME-sniffing protection and HSTS are unavailable** — residual `R-25`.

Only `Referrer-Policy` has a real equivalent, and `<meta name="referrer"
content="strict-origin-when-cross-origin">` is emitted alongside the policy.

## Consequences

* Two npm scripts, `csp:inject` and `csp:check`, and two `pages.yml` steps between the build and
  the export audit, so the audit and the upload both see the artefact that ships. They are
  **separate steps on purpose**: a step that writes its own output and then blesses it cannot
  fail.
* `csp:check` is not a `gates.sh` gate, because it needs a build and a build needs
  `NEXT_PUBLIC_*`, while `gates.sh` must keep working offline with no credentials. It is listed
  in that script's out-of-band notice, alongside `verify-rest-exposure.sh`.
* The injector is **idempotent**: a file already carrying the meta tag is skipped, so a re-run
  cannot stack tags or invalidate hashes.
* **A claim about the deployed site is only settled by measuring the deployed site**
  (observation 0510). The CI gate proves the artefact is correct when it leaves the runner; it
  does not prove what GitHub Pages serves. The live check after deployment is recorded in the
  commit that performs it.
