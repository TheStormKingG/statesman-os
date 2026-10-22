import type { NextConfig } from 'next'

/**
 * Minimal Next configuration for the development shell.
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
 */
/**
 * `agentRules: false` stops `next dev` writing an `AGENTS.md` into the
 * repository root. MEASURED: the first `next dev` run of this slice printed
 * "✓ Generated AGENTS.md for AI agents" and created the file, which is an
 * untracked root document this project did not ask for and does not own. Turned
 * off so the tree stays as the repository defines it.
 */
const nextConfig: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
}

export default nextConfig
