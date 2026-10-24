/**
 * The scanner behind `tests/unit/no-server-surface.test.ts`.
 *
 * WHY THIS EXISTS. Canon §12.1 item 1 requires CSRF origin verification on
 * every state-changing Server Action and Route Handler. ADR-0015 moved the app
 * to a static export talking to Supabase from the browser, which removed the
 * server request boundary that control was defined against: there is no Server
 * Action, no Route Handler, no middleware and no ambient cookie, so the control
 * has no referent. ADR-0019 retires it and makes this the replacement.
 *
 * The premise "there is no server surface" is true today and ONE FILE away from
 * false. A single `route.ts`, a `'use server'` directive or a `src/middleware.ts`
 * would reintroduce a request boundary carrying an ambient credential, and the
 * retired control would silently become necessary again. So the premise is
 * ENFORCED rather than believed, and the enforcement is what ADR-0019 trades for
 * the retirement.
 *
 * It is deliberately NOT a rule inside `scripts/check-import-boundaries.ts`:
 * that checker reasons over the import graph, and these are filesystem and
 * config properties, not import properties.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export type FindingKind =
  | 'use-server-directive'
  | 'route-handler'
  | 'middleware'
  | 'config-not-static-export'

export interface Finding {
  readonly kind: FindingKind
  /** Repo-relative, POSIX-separated, so assertions are platform-independent. */
  readonly file: string
  /** Why this file is a server surface. Asserted, not just counted — see ADR-0019. */
  readonly reason: string
}

const SCAN_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'] as const
const SKIP_DIRS = ['node_modules', '.next', '.git', 'out', 'coverage', 'reports'] as const
const ROUTE_BASENAMES = ['route.ts', 'route.tsx', 'route.js', 'route.mjs'] as const

/**
 * `'use server'` or `"use server"` as a DIRECTIVE — first statement of a file or
 * function body — not the same text inside a comment or a string used in prose.
 *
 * Anchored to a line that contains only the directive and an optional semicolon.
 * A `// 'use server'` comment and a sentence mentioning 'use server' therefore do
 * not match, which matters because this repository's own documentation and this
 * very file discuss the directive by name.
 */
const USE_SERVER_DIRECTIVE = /^\s*(['"])use server\1\s*;?\s*$/m

function walk(dir: string, out: string[]): void {
  // `string[]`, not `ReturnType<typeof readdirSync>`: that resolves to the Dirent
  // overload and fails `tsc --strict`, which the tests cannot catch because
  // Vitest transpiles without typechecking.
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if ((SKIP_DIRS as readonly string[]).includes(name)) continue
    const full = join(dir, name)
    let isDir: boolean
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    if (isDir) walk(full, out)
    else out.push(full)
  }
}

function toPosix(p: string): string {
  return p.split(sep).join('/')
}

/**
 * Scan `root` for anything that would constitute a server request boundary.
 *
 * `configPath` is read textually rather than imported: the claim being checked
 * is about what the committed config SAYS, and importing a Next config executes
 * it. A missing config file is itself a finding, because "no config" is not
 * evidence of a static export.
 */
export function findServerSurface(root: string, configRelPath = 'next.config.ts'): Finding[] {
  const findings: Finding[] = []

  const files: string[] = []
  walk(root, files)

  for (const full of files) {
    const rel = toPosix(relative(root, full))
    const base = rel.split('/').pop() ?? ''

    if (rel === 'src/middleware.ts' || rel === 'middleware.ts') {
      findings.push({
        kind: 'middleware',
        file: rel,
        reason: 'Next middleware runs on a server for every matched request, which is a request boundary.',
      })
      continue
    }

    if ((ROUTE_BASENAMES as readonly string[]).includes(base) && rel.includes('app/')) {
      findings.push({
        kind: 'route-handler',
        file: rel,
        reason: 'A Route Handler under app/ is a server-side HTTP endpoint.',
      })
      continue
    }

    if (!SCAN_EXTENSIONS.some((e) => base.endsWith(e))) continue
    // Skip this scanner and its own test: both name the directive in prose.
    if (rel.startsWith('tests/unit/support/server-surface') || rel.startsWith('tests/unit/no-server-surface')) continue

    let text: string
    try {
      text = readFileSync(full, 'utf8')
    } catch {
      continue
    }
    if (USE_SERVER_DIRECTIVE.test(text)) {
      findings.push({
        kind: 'use-server-directive',
        file: rel,
        reason: "A 'use server' directive marks a Server Action, which is invoked over an HTTP request.",
      })
    }
  }

  let config: string
  try {
    config = readFileSync(join(root, configRelPath), 'utf8')
  } catch {
    findings.push({
      kind: 'config-not-static-export',
      file: configRelPath,
      reason: 'The config could not be read, so a static export is unproven. Absence is not evidence.',
    })
    return findings
  }
  if (!/output:\s*['"]export['"]/.test(config)) {
    findings.push({
      kind: 'config-not-static-export',
      file: configRelPath,
      reason: "No `output: 'export'`, so the build may emit a server runtime.",
    })
  }

  return findings
}
