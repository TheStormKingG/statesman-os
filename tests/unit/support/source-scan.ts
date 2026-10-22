/**
 * Shared primitives for the SOURCE GATES — the unit tests that read the
 * repository's own text looking for a forbidden construct.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * `stripComments` was written for `no-unscoped-counts.test.ts` and the next
 * source gate needed it verbatim. Copying it would have produced two definitions
 * of "what counts as code rather than prose", free to drift — and the drift
 * would be silent in the worst direction: one gate quietly flagging its own
 * documentation while the other does not. The same argument the canon makes for
 * ONE `app.derive_decision_state()` serving both the generated column and the
 * trigger applies to a detector shared by two gates.
 *
 * Moved here unchanged, including the comment recording the measurement that
 * made it necessary.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

export function collect(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collect(p))
    else if (entry.name.endsWith('.ts')) out.push(p)
  }
  return out
}

/**
 * Blank out comment bodies, preserving offsets and newlines so reported line numbers
 * stay correct.
 *
 * This is not cosmetic. The first version of this detector flagged three sites that were
 * all PROSE inside comments explaining this very bug — including the comment in
 * state-machine.test.ts that documents the fix. A detector that flags its own
 * documentation trains people to add opt-out markers to silence it, which is how a gate
 * decays into noise.
 */
export function stripComments(source: string): string {
  let out = ''
  let i = 0
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'tmpl' = 'code'
  while (i < source.length) {
    const c = source[i] ?? ''
    const next = source[i + 1] ?? ''
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; out += '  '; i += 2; continue }
      if (c === '/' && next === '*') { state = 'block'; out += '  '; i += 2; continue }
      if (c === "'") state = 'single'
      else if (c === '"') state = 'double'
      else if (c === '`') state = 'tmpl'
      out += c; i += 1; continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n' } else out += ' '
      i += 1; continue
    }
    if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; out += '  '; i += 2; continue }
      out += c === '\n' ? '\n' : ' '
      i += 1; continue
    }
    // inside a string or template: copy verbatim, exit on the closing quote
    if ((state === 'single' && c === "'") || (state === 'double' && c === '"') || (state === 'tmpl' && c === '`')) {
      state = 'code'
    } else if (c === '\\') {
      out += c; i += 1
      out += source[i] ?? ''; i += 1; continue
    }
    out += c; i += 1
  }
  return out
}

/**
 * The SQL counterpart. Blanks out `--` line comments, C-style block comments and the
 * bodies of dollar-quoted strings' comments, preserving offsets and newlines so reported
 * line numbers stay correct. (The block-comment delimiters are not written out here: a
 * literal closing delimiter inside this very comment would terminate it, which is the kind
 * of joke that costs twenty minutes.)
 *
 * WHY THIS IS NEEDED SEPARATELY. `stripComments` above is JavaScript-aware and does not know
 * `--`. The migration set is roughly half prose, and much of that prose NAMES the very
 * constructs the source gates forbid — the composite-score prohibition is quoted verbatim in
 * several files. A detector that flagged its own documentation would train whoever hit it to
 * add opt-out markers, which is how a gate decays into noise.
 *
 * SINGLE-QUOTED STRINGS ARE TRACKED, and that is not fussiness about correctness for its own
 * sake. If `--` inside a string literal were treated as a comment, everything after it on
 * that line would be blanked, and a banned identifier later on the line would be MISSED.
 * Missing a violation is the unsafe direction for a prohibition gate, so the lexer knows
 * about strings specifically to avoid it.
 *
 * KNOWN LIMIT, stated rather than discovered: dollar-quoted bodies are treated as code, so a
 * `--` comment inside a plpgsql function body IS stripped (correct), but a dollar-quoted
 * string used as DATA would have its contents scanned (conservative — it can only produce a
 * false positive, never a miss).
 */
export function stripSqlComments(source: string): string {
  let out = ''
  let i = 0
  let state: 'code' | 'line' | 'block' | 'single' = 'code'
  while (i < source.length) {
    const c = source[i] ?? ''
    const next = source[i + 1] ?? ''
    if (state === 'code') {
      if (c === '-' && next === '-') { state = 'line'; out += '  '; i += 2; continue }
      if (c === '/' && next === '*') { state = 'block'; out += '  '; i += 2; continue }
      if (c === "'") { state = 'single'; out += c; i += 1; continue }
      out += c; i += 1; continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n' } else out += ' '
      i += 1; continue
    }
    if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; out += '  '; i += 2; continue }
      out += c === '\n' ? '\n' : ' '
      i += 1; continue
    }
    // inside a single-quoted string: copy verbatim; '' is an escaped quote
    if (c === "'" && next === "'") { out += c; i += 1; out += next; i += 1; continue }
    if (c === "'") { state = 'code' }
    out += c; i += 1
  }
  return out
}

/** Collect files with any of the given extensions, recursively. */
export function collectWithExtensions(dir: string, extensions: readonly string[]): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectWithExtensions(p, extensions))
    else if (extensions.some((e) => entry.name.endsWith(e))) out.push(p)
  }
  return out
}
