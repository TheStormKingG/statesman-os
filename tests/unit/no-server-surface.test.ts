/**
 * THE REPLACEMENT CONTROL FOR THE RETIRED CSRF ORIGIN VERIFICATION (ADR-0019).
 *
 * Canon §12.1 item 1 requires origin verification on every state-changing Server
 * Action and Route Handler. ADR-0015 deleted the thing it was defined against.
 * Retiring a P0 control is only honest if its PRECONDITION is enforced rather
 * than assumed, because the precondition is one file away from false: add a
 * `route.ts`, a `'use server'` directive or a `src/middleware.ts` and a request
 * boundary carrying an ambient credential exists again, at which point the
 * retired control is needed and nothing would say so.
 *
 * This is that enforcement. It is what ADR-0019 trades for the retirement.
 *
 * ── THE POSITIVE CONTROL ASSERTS THE MECHANISM, NOT THE VERDICT ─────────────
 * A control whose expected result is a failure is satisfied by every cause of
 * that failure, including its own rot: a scanner that crashed, scanned nothing,
 * or matched on the wrong thing would all produce "findings exist". So the
 * second test asserts WHICH file was flagged and WHY, per kind — four distinct
 * mechanisms, each named.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { findServerSurface } from './support/server-surface'

const REPO_ROOT = resolve(__dirname, '..', '..')

describe('ADR-0019: the app has no server request boundary', () => {
  it('finds no server surface anywhere in this repository', () => {
    const findings = findServerSurface(REPO_ROOT)
    // Printed rather than only counted: a failure must say what appeared.
    expect(findings.map((f) => `${f.kind} @ ${f.file}`)).toStrictEqual([])
  })

  describe('POSITIVE CONTROL — the scanner reports each mechanism it claims to detect', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'statesman-server-surface-'))

    mkdirSync(join(fixture, 'src', 'app', 'api'), { recursive: true })
    mkdirSync(join(fixture, 'src', 'lib'), { recursive: true })
    // 1. a Server Action, as a real directive on its own line
    writeFileSync(
      join(fixture, 'src', 'lib', 'actions.ts'),
      "'use server'\n\nexport async function submit(): Promise<void> {}\n",
    )
    // 2. a Route Handler under app/
    writeFileSync(
      join(fixture, 'src', 'app', 'api', 'route.ts'),
      'export function POST(): Response { return new Response(null) }\n',
    )
    // 3. middleware
    writeFileSync(join(fixture, 'src', 'middleware.ts'), 'export function middleware(): void {}\n')
    // 4. a config that does NOT pin a static export
    writeFileSync(join(fixture, 'next.config.ts'), 'export default { reactStrictMode: true }\n')

    afterAll(() => {
      rmSync(fixture, { recursive: true, force: true })
    })

    const findings = findServerSurface(fixture)
    const byKind = new Map(findings.map((f) => [f.kind, f]))

    it('detects all four kinds and nothing else', () => {
      expect([...byKind.keys()].sort()).toStrictEqual([
        'config-not-static-export',
        'middleware',
        'route-handler',
        'use-server-directive',
      ])
      expect(findings).toHaveLength(4)
    })

    it("attributes the 'use server' directive to the right file, with a reason", () => {
      const f = byKind.get('use-server-directive')
      expect(f?.file).toBe('src/lib/actions.ts')
      expect(f?.reason).toContain('Server Action')
    })

    it('attributes the Route Handler to the right file, with a reason', () => {
      const f = byKind.get('route-handler')
      expect(f?.file).toBe('src/app/api/route.ts')
      expect(f?.reason).toContain('HTTP endpoint')
    })

    it('attributes the middleware to the right file, with a reason', () => {
      const f = byKind.get('middleware')
      expect(f?.file).toBe('src/middleware.ts')
      expect(f?.reason).toContain('request boundary')
    })

    it("reports a config that does not pin output: 'export'", () => {
      const f = byKind.get('config-not-static-export')
      expect(f?.file).toBe('next.config.ts')
      expect(f?.reason).toContain('server runtime')
    })
  })

  /**
   * A directive is a statement, not a substring. Without this, a comment or a
   * sentence naming the directive would flag a file — and this repository's own
   * plan and threat model discuss `'use server'` by name, so the check would
   * fire on prose and then be loosened until it fired on nothing.
   */
  it('does not flag prose or comments that merely name the directive', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'statesman-prose-'))
    mkdirSync(join(fixture, 'src'), { recursive: true })
    writeFileSync(
      join(fixture, 'src', 'notes.ts'),
      "// A Server Action is marked with 'use server' at the top of the file.\n" +
        'export const DIRECTIVE = "use server" as const\n',
    )
    writeFileSync(join(fixture, 'next.config.ts'), "export default { output: 'export' }\n")
    try {
      expect(findServerSurface(fixture)).toStrictEqual([])
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
