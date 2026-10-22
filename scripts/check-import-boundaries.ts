/**
 * check-import-boundaries.ts — AST import-boundary gate (canon §6.1, §8.7).
 *
 * Four rules, all enforced on the RESOLVED module path rather than on the
 * specifier string:
 *
 *   R1  pg-outside-db                the `pg` package may be imported only from
 *                                    files under DB_DIR_REL
 *   R2  pool-outside-db              DB_DIR_REL/pool.ts may be imported only
 *                                    from within DB_DIR_REL, except for the
 *                                    four named symbols in
 *                                    POOL_TEST_ONLY_IMPORTS, which tests/ and
 *                                    scripts/ may import BY NAME. See the long
 *                                    note on that constant.
 *   R3  with-migrator-outside-tests  `withMigrator` may be imported only from
 *                                    files under tests/ or scripts/ — whether it
 *                                    is named, or reached through a whole-module
 *                                    alias.
 *   R4  opaque-specifier             a `require()` / `import()` whose argument is
 *                                    not a string literal cannot be checked at
 *                                    all, so outside DB_DIR_REL it is itself
 *                                    the violation.
 *
 * ── WHERE DB_DIR_REL POINTS, AND WHY IT MOVED (ADR-0015) ─────────────────────
 *
 * It was `src/server/db`. ADR-0015 made the application a static export talking
 * to Supabase from the browser, so there is no server process and no
 * server-side pool; the former data boundary now lives in
 * `tests/support/scoped-pg/`, where the integration harness still needs a
 * driver to issue arbitrary SQL as a chosen role. The RULE is unchanged — `pg`
 * is importable from exactly one directory and nowhere else — and it is
 * strictly stronger in effect than before, because that directory is no longer
 * under `src/` at all, so no production file can import the driver even inside
 * the permitted zone.
 *
 * Every rule derives its paths from DB_DIR_SEGMENTS below, INCLUDING the two
 * textual fallback patterns and the selftest mirror. That is deliberate: the
 * previous version hard-coded `server/db` into those fallbacks, so re-pointing
 * the constant alone would have left the fallback leg matching a directory that
 * no longer exists — a rule that still reported "OK" while checking nothing for
 * any specifier the resolver could not resolve.
 *
 * WHY THE COMPILER API AND NOT A LINT RULE OR A GREP (canon §6.1):
 *   - `no-restricted-imports` matches the specifier STRING, not the resolved
 *     path, so `../db/pool` walks straight through a recursive glob anchored at
 *     server/db/pool. R2 therefore resolves every specifier through the real
 *     TypeScript module resolver (tsconfig `paths` and all) and compares file
 *     identity.
 *   - `grep -F 'new Pool('` is evaded by one alias (`import { Pool as P }`), and
 *     `grep -F "'pg'"` is evaded by `await import('p' + 'g')` or by a deep path
 *     such as `../../node_modules/pg/lib`. R1 therefore matches the resolved
 *     package directory as well as the specifier.
 *
 * Every module-loading form the language offers is walked, not just the common
 * one: static `import`, re-exporting `export … from`, `export * as ns from`,
 * `import x = require()`, CommonJS `require()`, dynamic `import()` and the
 * `import('pg')` type node.
 *
 * ── THREE EVASIONS MEASURED ON THIS TREE, AND NOW CLOSED ──────────────────────
 *
 * Each was reproduced as a fixture against the previous revision of this file,
 * which exited 0 on all three; each was then confirmed to EXECUTE, because a
 * hole that cannot be exploited is a typo rather than a hole. `--selftest` keeps
 * all three as permanent positive controls.
 *
 * (a) NON-LITERAL SPECIFIER — `const n = 'p' + 'g'; await import(n)`, and a
 *     template specifier such as await import of "${BASE}/db/pool". The previous
 *     revision read the first argument with `isStringLiteralLike` and, when that
 *     failed, pushed NOTHING: the reference vanished and the file scanned clean.
 *     This was live in the tree — tests/evidence/verify-db.mts reached
 *     `acquireAppClient` through a template specifier and the gate never saw it.
 *     An unresolvable specifier is precisely how one evades a resolver-based
 *     rule, so R4 now treats it as the violation. Carve-out: inside
 *     tests/support/scoped-pg/ all four rules permit everything, so an opaque specifier
 *     there can hide nothing and is allowed.
 *
 * (b) WHOLE-MODULE ALIASING — `import * as db from '…/server/db'` followed by
 *     `db.withMigrator(…)`; likewise `const db = await import('…/server/db')`,
 *     `export * from '…/server/db'` and `export * as db from '…/server/db'`.
 *     R3 is name-based, and NONE of these forms writes the identifier anywhere,
 *     so `names` came back empty and R3 never fired. Measured: the namespace
 *     object really does carry `withMigrator` as a callable function. Refs now
 *     carry `wholeModule`, and R3 fires on it for any module inside the db
 *     directory. R2's allowance also refuses it, because a namespace object
 *     reaches every export, `acquireMigratorClient` included.
 *
 * (c) CASE-VARIANT SPECIFIER — '…/src/server/db/Pool' and 'PG'. Both rules
 *     compared paths and package names case-SENSITIVELY, while APFS on this
 *     machine is case-INSENSITIVE. Measured: importing '…/db/Pool' returns the
 *     real module with all seven private exports, and importing 'PG' returns the
 *     real `Pool` constructor. A glob or a regex anchored on `db/pool` walks
 *     straight past `db/Pool`. Every path and package comparison below now folds
 *     case; see `samePathish`.
 *
 * ANTI-VACUOUS-PASS CONTROL: a checker that reaches no files exits 0 and looks
 * like a pass. Scanning zero files is therefore exit 2, not exit 0, unless
 * --allow-empty is passed explicitly.
 *
 * POSITIVE CONTROL: `--selftest` builds a mirrored mini-tree in a scratch
 * directory, plants one fixture per evasion form plus negative controls in the
 * permitted zones, and asserts the EXACT set of rule ids per fixture — not an
 * exit code (canon §8.6: five fixtures asserting only `code === 2` let a checker
 * that returns 0/2 pass seven of ten). It then deletes the mirror. A checker
 * with no positive control is not a gate.
 *
 * Usage:
 *   tsx scripts/check-import-boundaries.ts [options] [path …]
 *
 *   path …           files or directories to scan. Default: src tests scripts
 *                    (relative to the repository root).
 *   --root <dir>     repository root used to anchor the rule directories.
 *                    Default: the parent of this script's directory.
 *   --selftest       run the fixture suite described above instead of scanning.
 *   --keep           with --selftest, leave the mirror on disk for inspection.
 *   --allow-empty    exit 0 instead of 2 when no file was scanned.
 *   --quiet          print violations and the summary line only.
 *
 * Exit codes:  0 clean · 1 violations found · 2 usage error, nothing scanned, or
 *              a self-test fixture whose outcome did not match its expectation.
 */

import ts from 'typescript'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import type { Dirent } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'

// ---------------------------------------------------------------- rule config

/** Packages that hand out a Postgres connection. `pg-pool` exports `Pool`
 *  directly and `pg-protocol` speaks the wire protocol, so restricting the
 *  string 'pg' alone would leave a one-word evasion. Lower-case by convention:
 *  every comparison against this list folds case first (evasion (c)). */
const PG_PACKAGES: readonly string[] = [
  'pg',
  'pg-pool',
  'pg-protocol',
  'pg-native',
  'pg-cursor',
  'pg-query-stream',
]

/**
 * THE ONE DIRECTORY THE DRIVER MAY BE IMPORTED FROM, as path segments.
 *
 * Segments rather than a joined string because three other things are derived
 * from it: the POSIX specifier form the selftest fixtures use, and the two
 * textual fallback patterns below. See the header for why it moved out of
 * `src/`.
 */
const DB_DIR_SEGMENTS: readonly string[] = ['tests', 'support', 'scoped-pg']
const DB_DIR_REL = path.join(...DB_DIR_SEGMENTS)
/** The same directory as a module specifier fragment: always `/`, never `\`. */
const DB_DIR_POSIX = DB_DIR_SEGMENTS.join('/')

/**
 * The specifier a selftest fixture uses to reach DB_DIR_REL inside the mirror.
 *
 * Every offending fixture sits one level below the mirror root (`app/x.ts`,
 * `tests/x.ts`, `scripts/x.ts`), so one prefix serves all of them. Derived, not
 * written out, so the fixtures cannot go on referencing a directory the rules
 * no longer point at — which would turn 24 positive controls into 24 imports of
 * a module that does not exist, every one of them "clean".
 */
const FX_DB = `../${DB_DIR_POSIX}`
const POOL_BASENAMES: readonly string[] = ['pool.ts', 'pool.tsx', 'pool.mts', 'pool.cts', 'pool.js']

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Progressive trailing suffixes of DB_DIR_SEGMENTS, longest first:
 * `tests/support/scoped-pg`, `support/scoped-pg`, `scoped-pg`.
 *
 * The textual fallbacks match ANY of these at a path boundary, which is exactly
 * what the hard-coded `(?:src/)?server/db` did for the old location: a
 * specifier naming the directory from any depth is caught, while a bare
 * `./pool` — writable only from inside the directory, the permitted case — is
 * not.
 */
const DB_DIR_SUFFIX_ALTERNATION = DB_DIR_SEGMENTS.map((_, i) =>
  escapeForRegExp(DB_DIR_SEGMENTS.slice(i).join('/')),
).join('|')

/** Fallback for "this specifier names DB_DIR_REL/pool". */
const POOL_SPECIFIER_FALLBACK = new RegExp(
  `(?:^|/)(?:${DB_DIR_SUFFIX_ALTERNATION})/pool$`,
  'i',
)

/** Fallback for "this specifier names DB_DIR_REL, or one module inside it". */
const DB_DIR_SPECIFIER_FALLBACK = new RegExp(
  `(?:^|/)(?:${DB_DIR_SUFFIX_ALTERNATION})(?:/[A-Za-z0-9_.$-]+)?$`,
  'i',
)
const MIGRATOR_EXPORT = 'withMigrator'

/** Consumers of `withMigrator`. `tests/support/scoped-pg` is included because the db module
 *  assembles its own public surface there — `index.ts` re-exporting `withMigrator`
 *  from `./scoped` IS the canon's "only withUser and withMigrator are exported from
 *  the db module", not a leak. The boundary this rule defends is who may *consume*
 *  the migrator connection. */
const MIGRATOR_ALLOWED_RELS: readonly string[] = ['tests', 'scripts', DB_DIR_REL]

/* ────────────────────────────────────────────────────────────────────────────
 * R2's allowance, and why it is keyed on SYMBOLS rather than on a file.
 *
 * THE CONTRADICTION THIS RESOLVES. tests/support/scoped-pg/index.ts documents its own
 * contract as: "NOT exported: … `closePools` and
 * `resetPrivilegeAssertionCacheForTests`, which test setup imports from `./pool`
 * directly." R2 was gated on `!inDbDir` alone, so it flagged exactly the import
 * the module's own contract prescribes, and `npm run boundaries` was RED on the
 * committed tree. One of the two sides had to move.
 *
 * WHAT R2 ACTUALLY DEFENDS. Per canon §6.1 and pool.ts's own header: no code
 * outside tests/support/scoped-pg/ may obtain a connection OUTSIDE a scoped transaction,
 * so `withUser`'s identity / statement_timeout / DISCARD ALL discipline cannot
 * be sidestepped. The invariant that carries that is narrower than "nobody may
 * name this file": it is **outside tests/support/scoped-pg/ nobody may CONSTRUCT a pool.**
 * The `Pool` class never leaves the directory, because R1 keeps `pg` inside it,
 * so a test can at most borrow a connection the module itself already made.
 *
 * WHY A SYMBOL LIST AND NOT A SANCTIONED test-only MODULE. A file-shaped
 * allowance ("R2 permits tests/support/scoped-pg/testing.ts from anywhere") is wider and,
 * worse, widens SILENTLY: the next helper somebody adds to that file is
 * permitted with no review, and it sits inside the private directory where the
 * Pool is in scope. A symbol list is enumerable, the enumeration IS the review,
 * and adding a symbol turns the gate red until someone edits this constant on
 * purpose. A file would also force `assertUnprivilegedOnce` and
 * `acquireAppClient` — production symbols that `scoped.ts` calls on every
 * request — into a module named "test-only", which is a lie about their role.
 *
 * WHY THESE FOUR, EACH WITH ITS OWN REASON:
 *   closePools                            test teardown and process shutdown. It
 *                                         CLOSES pools; it cannot open one.
 *                                         Named in index.ts's contract.
 *   resetPrivilegeAssertionCacheForTests   clears the cached role verdict so a
 *                                         positive control can re-run the guard.
 *                                         The name itself declares test-only.
 *                                         Named in index.ts's contract.
 *   assertUnprivilegedOnce                 the guard itself. Canon §8's positive
 *                                         control for it — point APP_DATABASE_URL
 *                                         at statesman_migrator and require
 *                                         rejection — can only be written by
 *                                         calling it. It hands out nothing.
 *   acquireAppClient                       the raw statesman_app connection. The
 *                                         canon §8.2 paired controls that must
 *                                         observe 28000 (no context), 42501 (a
 *                                         denied milestone write) and a clean
 *                                         pooled backend are facts ABOUT THE
 *                                         ABSENCE of withUser: V6 and V18 make
 *                                         them unobservable through it, because
 *                                         withUser sets the very GUC under test.
 *                                         statesman_app owns nothing and has no
 *                                         BYPASSRLS (V1, V4), so this is the
 *                                         LEAST privileged connection in the
 *                                         system — with no context set it sees
 *                                         nothing and raises.
 *
 * WHAT STAYS FORBIDDEN EVERYWHERE OUTSIDE tests/support/scoped-pg/:
 *   acquireMigratorClient  a statesman_owner-member connection, which bypasses
 *                          RLS by OWNERSHIP (V4) and is the forgery vector. The
 *                          only sanctioned route is `withMigrator`, which
 *                          carries the NEXT_RUNTIME and identity-context guards
 *                          a raw client has not got. R3 already grants tests/
 *                          and scripts/ the guarded wrapper; this is the same
 *                          trade, drawn at the guarded entry point.
 *   statementTimeoutMs, assertNotRequestRuntime, and anything else — internal;
 *                          no consumer outside the directory.
 *
 * The allowance applies ONLY when all four hold: the importing file is under
 * tests/ or scripts/; the reference is a NAMED-binding form (never a namespace,
 * default, `import x = require()`, bare, or non-destructured dynamic import,
 * each of which reaches every export); it names at least one symbol; and EVERY
 * symbol it names is on the list. One bad name poisons the whole reference.
 * ──────────────────────────────────────────────────────────────────────────── */
const POOL_TEST_ONLY_IMPORTS: readonly string[] = [
  'closePools',
  'resetPrivilegeAssertionCacheForTests',
  'assertUnprivilegedOnce',
  'acquireAppClient',
]

/** Zones the R2 allowance applies in. Deliberately NOT including DB_DIR_REL:
 *  inside the db directory R2 does not apply at all. */
const POOL_ALLOWANCE_RELS: readonly string[] = ['tests', 'scripts']

/** A control on the control. These names must never appear in
 *  POOL_TEST_ONLY_IMPORTS, whatever a later edit intends. Checked by --selftest,
 *  so widening the allowance to cover the migrator connection or the pool
 *  constructor fails with exit 2 instead of passing quietly. */
const POOL_NEVER_ALLOWED: readonly string[] = ['acquireMigratorClient', 'Pool', 'default']

const SCAN_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts']
const SKIP_DIRS: readonly string[] = [
  'node_modules',
  '.next',
  '.git',
  'dist',
  'build',
  'coverage',
  'reports',
  '.turbo',
  '.vercel',
]

type RuleId =
  | 'pg-outside-db'
  | 'pool-outside-db'
  | 'with-migrator-outside-tests'
  | 'opaque-specifier'

const RULE_COUNT = 4

interface Violation {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly rule: RuleId
  readonly message: string
}

type RefKind =
  | 'import'
  | 'export-from'
  | 'import-equals'
  | 'require'
  | 'dynamic-import'
  | 'import-type'

interface ModuleRef {
  /** `undefined` when the specifier is not a string literal: the ref is opaque. */
  readonly specifier: string | undefined
  /** Source text of the specifier expression, for an opaque ref's message. */
  readonly rawText: string
  readonly kind: RefKind
  readonly line: number
  readonly column: number
  /** Identifiers this reference pulls out of the module (named imports,
   *  re-exported names, destructured require/await-import bindings and
   *  property reads off a load call). */
  readonly names: readonly string[]
  /** True when the reference hands the surrounding code the WHOLE module
   *  namespace — a default or `* as` import, `export *`, `export * as`,
   *  `import x = require()`, or a dynamic import bound to a plain identifier.
   *  Every export is then reachable by property access without the identifier
   *  ever being written, which is evasion (b). */
  readonly wholeModule: boolean
}

// ------------------------------------------------------------------ cli parse

interface Options {
  readonly root: string
  readonly targets: readonly string[]
  readonly allowEmpty: boolean
  readonly quiet: boolean
  readonly selftest: boolean
  readonly keep: boolean
}

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): Options {
  const here = path.dirname(fileURLToPath(import.meta.url))
  let root = path.resolve(here, '..')
  const targets: string[] = []
  let allowEmpty = false
  let quiet = false
  let selftest = false
  let keep = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg === '--root') {
      const value = argv[i + 1]
      if (value === undefined) throw new UsageError('--root needs a directory')
      root = path.resolve(value)
      i += 1
    } else if (arg.startsWith('--root=')) {
      root = path.resolve(arg.slice('--root='.length))
    } else if (arg === '--allow-empty') {
      allowEmpty = true
    } else if (arg === '--quiet') {
      quiet = true
    } else if (arg === '--selftest') {
      selftest = true
    } else if (arg === '--keep') {
      keep = true
    } else if (arg === '-h' || arg === '--help') {
      throw new UsageError('help')
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option: ${arg}`)
    } else {
      targets.push(path.resolve(arg))
    }
  }

  if (!existsSync(root)) throw new UsageError(`--root does not exist: ${root}`)
  const resolvedTargets =
    targets.length > 0 ? targets : ['src', 'tests', 'scripts'].map((d) => path.join(root, d))

  return { root, targets: resolvedTargets, allowEmpty, quiet, selftest, keep }
}

// -------------------------------------------------------------- file discovery

function collectFiles(targets: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  const visitDir = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.includes(entry.name)) continue
        visitDir(full)
      } else if (entry.isFile() && SCAN_EXTENSIONS.includes(path.extname(entry.name))) {
        if (!seen.has(full)) {
          seen.add(full)
          out.push(full)
        }
      }
    }
  }

  for (const target of targets) {
    if (!existsSync(target)) continue
    if (statSync(target).isDirectory()) {
      visitDir(target)
    } else if (!seen.has(target)) {
      seen.add(target)
      out.push(target)
    }
  }

  out.sort()
  return out
}

// ------------------------------------------------------------ module resolution

function loadCompilerOptions(root: string): ts.CompilerOptions {
  const configPath = path.join(root, 'tsconfig.json')
  const fallback: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
  }
  if (!existsSync(configPath)) return fallback

  // `ts.sys.readFile` is passed through a wrapper rather than handed over as a
  // bare method reference, so it keeps its receiver.
  const read = ts.readConfigFile(configPath, (fileName: string) => ts.sys.readFile(fileName))
  if (read.error !== undefined || read.config === undefined) return fallback
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root, undefined, configPath)
  return parsed.options
}

function makeResolver(
  options: ts.CompilerOptions,
): (specifier: string, containingFile: string) => string | undefined {
  const cache = ts.createModuleResolutionCache(process.cwd(), (f) => f, options)
  return (specifier, containingFile) => {
    try {
      const resolved = ts.resolveModuleName(specifier, containingFile, options, ts.sys, cache)
      const name = resolved.resolvedModule?.resolvedFileName
      return name === undefined ? undefined : path.normalize(name)
    } catch {
      return undefined
    }
  }
}

// ------------------------------------------------------------------ ast walker

function stringLiteralText(node: ts.Node | undefined): string | undefined {
  if (node !== undefined && ts.isStringLiteralLike(node)) return node.text
  return undefined
}

function namesFromNamedBindings(bindings: ts.NamedImportBindings | undefined): string[] {
  if (bindings === undefined || !ts.isNamedImports(bindings)) return []
  return bindings.elements.map((el) => (el.propertyName ?? el.name).text)
}

function namesFromBindingPattern(name: ts.BindingName): string[] {
  if (!ts.isObjectBindingPattern(name)) return []
  const out: string[] = []
  for (const element of name.elements) {
    const source = element.propertyName ?? element.name
    if (ts.isIdentifier(source)) out.push(source.text)
  }
  return out
}

/** The nearest ancestor of a load call that is not just a wrapper. Climbing
 *  through `await`, parentheses, `as` and `!` makes every spelling of
 *  `await import(…)` land on the same surrounding node. Returns the wrapper that
 *  is the chosen parent's direct child as well, so callers can tell which of the
 *  parent's slots the call sits in. */
function effectiveParent(call: ts.Node): { parent: ts.Node; child: ts.Node } | undefined {
  let cursor: ts.Node = call
  for (;;) {
    const parent: ts.Node | undefined = cursor.parent
    if (parent === undefined) return undefined
    if (
      ts.isAwaitExpression(parent) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isNonNullExpression(parent)
    ) {
      cursor = parent
      continue
    }
    return { parent, child: cursor }
  }
}

/** Identifiers a `require(…)` / `await import(…)` call expression hands to the
 *  surrounding code: `const { withMigrator } = require(…)`,
 *  `const { withMigrator } = await import(…)`, `(await import(…)).withMigrator`
 *  and `require(…).withMigrator`. */
function namesFromLoadCall(call: ts.CallExpression): string[] {
  const names: string[] = []
  const found = effectiveParent(call)
  if (found === undefined) return names
  const { parent, child } = found

  if (ts.isPropertyAccessExpression(parent) && parent.expression === child) {
    names.push(parent.name.text)
  } else if (ts.isElementAccessExpression(parent) && parent.expression === child) {
    const literal = stringLiteralText(parent.argumentExpression)
    if (literal !== undefined) names.push(literal)
  } else if (ts.isVariableDeclaration(parent) && parent.initializer === child) {
    names.push(...namesFromBindingPattern(parent.name))
  }

  return names
}

/** Evasion (b) for load calls: the module object is bound whole, or handed to
 *  something this checker cannot follow. A bare `await import('x')` STATEMENT
 *  binds nothing, so it is not whole-module. */
function loadCallIsWholeModule(call: ts.CallExpression, names: readonly string[]): boolean {
  if (names.length > 0) return false
  const found = effectiveParent(call)
  if (found === undefined) return false
  if (ts.isExpressionStatement(found.parent)) return false
  return true
}

function collectRefs(sourceFile: ts.SourceFile): ModuleRef[] {
  const refs: ModuleRef[] = []

  const at = (node: ts.Node): { line: number; column: number } => {
    const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    return { line: pos.line + 1, column: pos.character + 1 }
  }

  const push = (
    node: ts.Node,
    specifier: string | undefined,
    rawText: string,
    kind: RefKind,
    names: readonly string[],
    wholeModule: boolean,
  ): void => {
    const { line, column } = at(node)
    refs.push({ specifier, rawText, kind, line, column, names, wholeModule })
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      const bindings = clause?.namedBindings
      const wholeModule =
        clause !== undefined &&
        (clause.name !== undefined || (bindings !== undefined && ts.isNamespaceImport(bindings)))
      push(
        node,
        stringLiteralText(node.moduleSpecifier),
        node.moduleSpecifier.getText(sourceFile),
        'import',
        namesFromNamedBindings(bindings),
        wholeModule,
      )
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const clause = node.exportClause
      const names =
        clause !== undefined && ts.isNamedExports(clause)
          ? clause.elements.map((el) => (el.propertyName ?? el.name).text)
          : []
      // `export * from 'm'` (no clause) and `export * as ns from 'm'` both
      // re-expose every export of m under a new surface — evasion (b).
      const wholeModule = clause === undefined || ts.isNamespaceExport(clause)
      push(
        node,
        stringLiteralText(node.moduleSpecifier),
        node.moduleSpecifier.getText(sourceFile),
        'export-from',
        names,
        wholeModule,
      )
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const expr = node.moduleReference.expression
      push(node, stringLiteralText(expr), expr.getText(sourceFile), 'import-equals', [], true)
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument
      const specifier =
        ts.isLiteralTypeNode(arg) && ts.isStringLiteralLike(arg.literal)
          ? arg.literal.text
          : undefined
      // A type position has no runtime value, so it can never CALL withMigrator.
      push(node, specifier, arg.getText(sourceFile), 'import-type', [], false)
    } else if (ts.isCallExpression(node)) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword
      if (isRequire || isDynamic) {
        const arg = node.arguments[0]
        const names = namesFromLoadCall(node)
        push(
          node,
          stringLiteralText(arg),
          arg === undefined ? '<no argument>' : arg.getText(sourceFile),
          isDynamic ? 'dynamic-import' : 'require',
          names,
          loadCallIsWholeModule(node, names),
        )
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return refs
}

// ----------------------------------------------------------------- rule checks

/* Path and package comparison folds case — evasion (c).
 *
 * MEASURED on this machine (APFS, case-insensitive):
 *   import('…/src/server/db/Pool')  ->  resolves, and returns all seven private
 *                                       exports, acquireMigratorClient included
 *   import('PG')                    ->  resolves, and returns the real Pool
 *                                       constructor
 * so a one-character change walked through both R1 and R2 while running
 * perfectly. Folding case can in principle over-match on a case-SENSITIVE
 * filesystem, where `Pool.ts` and `pool.ts` could be two different files; that
 * direction is a false VIOLATION on a boundary gate, which is the safe way to be
 * wrong, and such an import would not resolve on this machine anyway. */
function samePathish(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function isUnder(target: string, dir: string): boolean {
  const rel = path.relative(dir.toLowerCase(), target.toLowerCase())
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Package name owning a resolved path, read from its LAST node_modules
 *  segment, so `a/node_modules/b/node_modules/pg/lib/index.js` reports `pg`. */
function packageOfResolved(resolved: string): string | undefined {
  const parts = resolved.split(path.sep)
  let last = -1
  for (let i = 0; i < parts.length; i += 1) if (parts[i] === 'node_modules') last = i
  if (last < 0) return undefined
  const first = parts[last + 1]
  if (first === undefined) return undefined
  if (first.startsWith('@')) {
    const second = parts[last + 2]
    return second === undefined ? undefined : `${first}/${second}`
  }
  return first
}

function pgPackageFor(specifier: string, resolved: string | undefined): string | undefined {
  const spec = specifier.toLowerCase()
  for (const pkg of PG_PACKAGES) {
    if (spec === pkg || spec.startsWith(`${pkg}/`)) return pkg
  }
  if (resolved !== undefined) {
    const owner = packageOfResolved(resolved)?.toLowerCase()
    if (owner !== undefined && PG_PACKAGES.includes(owner)) return owner
  }
  return undefined
}

function stripModuleExtension(specifier: string): string {
  return specifier.replace(/\.(?:[cm]?tsx?|[cm]?js)$/i, '')
}

/** True when the specifier names the private pool module.
 *
 *  Resolution is authoritative. The textual fallback exists because the module
 *  may not be on disk yet (the gate must be live before the code it guards),
 *  and because an unresolvable specifier would otherwise pass silently. A bare
 *  `./pool` is deliberately NOT matched by the fallback: it can only be written
 *  from inside the same directory, which is the permitted case. Both legs fold
 *  case (evasion (c)). */
function isPoolModule(
  specifier: string,
  resolved: string | undefined,
  poolFiles: readonly string[],
): boolean {
  if (resolved !== undefined && poolFiles.some((p) => samePathish(p, resolved))) return true
  return POOL_SPECIFIER_FALLBACK.test(stripModuleExtension(specifier))
}

/** True when the specifier names ANY module inside DB_DIR_REL — the surface
 *  through which `withMigrator` is reachable by property access (evasion (b)). */
function isDbDirModule(specifier: string, resolved: string | undefined, dbDir: string): boolean {
  if (resolved !== undefined) return isUnder(resolved, dbDir)
  return DB_DIR_SPECIFIER_FALLBACK.test(stripModuleExtension(specifier))
}

function checkFile(
  file: string,
  root: string,
  resolve: (specifier: string, containingFile: string) => string | undefined,
  poolFiles: readonly string[],
): Violation[] {
  const text = readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const refs = collectRefs(sourceFile)
  const violations: Violation[] = []

  const dbDir = path.join(root, DB_DIR_REL)
  const inDbDir = isUnder(file, dbDir)
  const inMigratorZone = MIGRATOR_ALLOWED_RELS.map((rel) => path.join(root, rel)).some((dir) =>
    isUnder(file, dir),
  )
  const inPoolAllowanceZone = POOL_ALLOWANCE_RELS.map((rel) => path.join(root, rel)).some((dir) =>
    isUnder(file, dir),
  )

  for (const ref of refs) {
    // R4 — an opaque specifier, checked FIRST because nothing else can be.
    if (ref.specifier === undefined) {
      // Inside tests/support/scoped-pg/ all four rules permit everything, so an opaque
      // specifier there cannot hide a violation of any of them.
      if (!inDbDir) {
        violations.push({
          file,
          line: ref.line,
          column: ref.column,
          rule: 'opaque-specifier',
          message:
            `${ref.kind} with a non-literal specifier \`${ref.rawText}\` — this checker ` +
            `resolves specifiers, so an expression it cannot evaluate is exactly how the pg ` +
            `and pool boundaries are evaded (for instance 'p' + 'g', or a template). Write a ` +
            `string literal, or go through withUser/withMigrator.`,
        })
      }
      continue
    }

    const resolved = resolve(ref.specifier, file)

    // R1 — the pg package only from tests/support/scoped-pg/
    const pgPkg = pgPackageFor(ref.specifier, resolved)
    if (pgPkg !== undefined && !inDbDir) {
      violations.push({
        file,
        line: ref.line,
        column: ref.column,
        rule: 'pg-outside-db',
        message:
          `${ref.kind} of '${ref.specifier}' (package '${pgPkg}') — the pg driver may be ` +
          `imported only from ${DB_DIR_REL}/. Go through withUser/withMigrator instead.`,
      })
    }

    // R2 — the private pool module only from within tests/support/scoped-pg/, plus the
    // narrow named-symbol allowance for tests/ and scripts/ documented above.
    const pool = isPoolModule(ref.specifier, resolved, poolFiles)
    if (pool && !inDbDir) {
      const namedOnly = !ref.wholeModule && ref.names.length > 0
      const disallowed = ref.names.filter((n) => !POOL_TEST_ONLY_IMPORTS.includes(n))
      const allowed = inPoolAllowanceZone && namedOnly && disallowed.length === 0
      if (!allowed) {
        const how =
          resolved !== undefined && poolFiles.some((p) => samePathish(p, resolved))
            ? 'resolved'
            : 'by specifier shape'
        const why = !inPoolAllowanceZone
          ? `only ${POOL_ALLOWANCE_RELS.join('/ and ')}/ may import it at all`
          : !namedOnly
            ? 'the allowance covers NAMED imports only, and this form hands over the whole ' +
              'module, acquireMigratorClient included'
            : `it imports ${disallowed.map((n) => `'${n}'`).join(', ')}, which is not on the ` +
              `allowance`
        violations.push({
          file,
          line: ref.line,
          column: ref.column,
          rule: 'pool-outside-db',
          message:
            `${ref.kind} of '${ref.specifier}' (${how}) — ${DB_DIR_REL}/pool.ts is ` +
            `module-private: ${why}. tests/ and scripts/ may import exactly ` +
            `{ ${POOL_TEST_ONLY_IMPORTS.join(', ')} } by name; POOL_TEST_ONLY_IMPORTS in ` +
            `scripts/check-import-boundaries.ts carries the reason for each one.`,
        })
      }
    }

    // R3 — withMigrator only from tests/ and scripts/ (or re-exported inside the
    // db module). Two legs: the identifier is named, OR the whole module is
    // aliased so the identifier never has to be written (evasion (b)). pool.ts
    // is excluded from the second leg because R2 already owns it under a
    // stricter rule, and double-reporting one import is noise.
    const namesMigrator = ref.names.includes(MIGRATOR_EXPORT)
    const launders = ref.wholeModule && !pool && isDbDirModule(ref.specifier, resolved, dbDir)
    if ((namesMigrator || launders) && !inMigratorZone) {
      const via = namesMigrator
        ? `${ref.kind} of '${MIGRATOR_EXPORT}' from '${ref.specifier}'`
        : `${ref.kind} of the WHOLE module '${ref.specifier}', whose namespace carries ` +
          `'${MIGRATOR_EXPORT}' as a callable property — the identifier never appears, so a ` +
          `name-based rule cannot see it`
      violations.push({
        file,
        line: ref.line,
        column: ref.column,
        rule: 'with-migrator-outside-tests',
        message:
          `${via} — the migrator connection is a member of statesman_owner and is not ` +
          `subject to RLS. It may be imported only from tests/ or scripts/ (or re-exported ` +
          `within ${DB_DIR_REL}/, which is the db module's own public surface).`,
      })
    }
  }

  return violations
}

// ----------------------------------------------------------------- scan driver

interface ScanResult {
  readonly files: readonly string[]
  readonly violations: readonly Violation[]
}

function scanTree(root: string, targets: readonly string[]): ScanResult {
  const files = collectFiles(targets)
  const compilerOptions = loadCompilerOptions(root)
  const resolve = makeResolver(compilerOptions)
  const poolFiles = POOL_BASENAMES.map((base) => path.normalize(path.join(root, DB_DIR_REL, base)))

  const violations: Violation[] = []
  for (const file of files) {
    violations.push(...checkFile(file, root, resolve, poolFiles))
  }
  return { files, violations }
}

function printViolations(violations: readonly Violation[], root: string, fileCount: number): void {
  const sorted = [...violations].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
  )
  process.stderr.write('\ncheck-import-boundaries: BOUNDARY VIOLATIONS\n\n')
  for (const v of sorted) {
    const shown =
      path.isAbsolute(v.file) && isUnder(v.file, root) ? path.relative(root, v.file) : v.file
    process.stderr.write(`  ${shown}:${v.line}:${v.column}  [${v.rule}]\n      ${v.message}\n`)
  }
  const offending = new Set(sorted.map((v) => v.file)).size
  process.stderr.write(
    `\n  ${String(sorted.length)} violation(s) in ${String(offending)} file(s) of ` +
      `${String(fileCount)} scanned\n`,
  )
}

// -------------------------------------------------------------------- selftest

interface Fixture {
  /** Path inside the mirror. Its directory decides which zone it is in. */
  readonly rel: string
  readonly code: string
  /** The EXACT multiset of rule ids this fixture must produce. */
  readonly expect: readonly RuleId[]
  readonly why: string
}

const SELFTEST_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2023',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      noEmit: true,
      baseUrl: '.',
    },
    include: ['**/*.ts'],
  },
  null,
  2,
)

/** Stand-ins for the two real modules, so specifiers RESOLVE inside the mirror
 *  and the resolution leg of each rule is exercised rather than only the textual
 *  fallback. The export lists mirror the real files. */
const SELFTEST_POOL_STUB = [
  'export function statementTimeoutMs(): number { return 5000 }',
  'export async function acquireAppClient(): Promise<unknown> { return {} }',
  'export async function acquireMigratorClient(): Promise<unknown> { return {} }',
  'export async function closePools(): Promise<void> {}',
  'export async function assertUnprivilegedOnce(): Promise<void> {}',
  'export function resetPrivilegeAssertionCacheForTests(): void {}',
  'export function assertNotRequestRuntime(_op: string): void {}',
  '',
].join('\n')

const SELFTEST_INDEX_STUB = [
  'export async function withUser<T>(fn: () => Promise<T>): Promise<T> { return fn() }',
  'export async function withMigrator<T>(_id: string, fn: () => Promise<T>): Promise<T> {',
  '  return fn()',
  '}',
  '',
].join('\n')

function selftestFixtures(): readonly Fixture[] {
  // The template-specifier fixture is assembled by concatenation so this file
  // needs no nested template escapes.
  const tick = '`'
  const templateSpecifier =
    `const B = '${FX_DB}'\n` + `export const m = await import(${tick}\${B}/pool${tick})\n`

  return [
    // ── evasion (a): a specifier this checker cannot evaluate ────────────────
    {
      rel: 'app/opaque-concat.ts',
      code: "const n = 'p' + 'g'\nexport const m = await import(n)\n",
      expect: ['opaque-specifier'],
      why: 'evasion (a): string concatenation hid the pg import entirely',
    },
    {
      rel: 'app/opaque-template.ts',
      code: templateSpecifier,
      expect: ['opaque-specifier'],
      why: 'evasion (a) exactly as it was live in tests/evidence/verify-db.mts',
    },
    {
      rel: 'app/opaque-require-variable.ts',
      code: "const n = 'pg'\nexport const m: unknown = require(n)\n",
      expect: ['opaque-specifier'],
      why: 'evasion (a) through CommonJS require',
    },
    {
      rel: 'app/opaque-spread-argument.ts',
      code: "const a: [string] = ['pg']\nexport const m = await import(...a)\n",
      expect: ['opaque-specifier'],
      why: 'evasion (a) with a spread, so arguments[0] is not a literal node',
    },

    // ── evasion (b): the module is aliased whole ─────────────────────────────
    {
      rel: 'app/launder-namespace.ts',
      code: `import * as db from '${FX_DB}'\nexport const w = db.withMigrator\n`,
      expect: ['with-migrator-outside-tests'],
      why: 'evasion (b): `import * as` never writes the identifier',
    },
    {
      rel: 'app/launder-default.ts',
      code: `import db from '${FX_DB}'\nexport const w = db\n`,
      expect: ['with-migrator-outside-tests'],
      why: 'evasion (b): a default binding carries the module object',
    },
    {
      rel: 'app/launder-dynamic.ts',
      code: `const db = await import('${FX_DB}')\nexport const w = db.withMigrator\n`,
      expect: ['with-migrator-outside-tests'],
      why: 'evasion (b): a dynamic import bound to a plain identifier',
    },
    {
      rel: 'app/launder-star-export.ts',
      code: `export * from '${FX_DB}'\n`,
      expect: ['with-migrator-outside-tests'],
      why: 'evasion (b): `export *` re-exposes withMigrator under a new surface',
    },
    {
      rel: 'app/launder-namespace-export.ts',
      code: `export * as db from '${FX_DB}'\n`,
      expect: ['with-migrator-outside-tests'],
      why: 'evasion (b): `export * as ns` does the same through a namespace',
    },
    {
      rel: 'app/launder-import-equals.ts',
      code: `import db = require('${FX_DB}')\nexport const w = db\n`,
      expect: ['with-migrator-outside-tests'],
      why: 'evasion (b): `import x = require()` carries the whole module',
    },

    // ── evasion (c): case-variant specifiers, which resolve on APFS ──────────
    {
      rel: 'app/case-pool.ts',
      code:
        `import { acquireMigratorClient } from '${FX_DB}/Pool'\n` +
        'export const a = acquireMigratorClient\n',
      expect: ['pool-outside-db'],
      why: 'evasion (c): db/Pool resolves on a case-insensitive filesystem',
    },
    {
      rel: 'app/case-pg.ts',
      code: "import { Pool } from 'PG'\nexport const p = Pool\n",
      expect: ['pg-outside-db'],
      why: "evasion (c): importing 'PG' returns the real Pool constructor",
    },

    // ── R1 forms that already worked, kept so a regression is visible ───────
    {
      rel: 'app/pg-bare.ts',
      code: "import { Pool } from 'pg'\nexport const p = Pool\n",
      expect: ['pg-outside-db'],
      why: 'R1 baseline',
    },
    {
      rel: 'app/pg-aliased-constructor.ts',
      code: "import { Pool as P } from 'pg'\nexport const p = P\n",
      expect: ['pg-outside-db'],
      why: 'R1: the alias a grep for `new Pool(` would miss',
    },
    {
      rel: 'app/pg-subpath.ts',
      code: "import pg from 'pg/lib'\nexport const p = pg\n",
      expect: ['pg-outside-db'],
      why: 'R1: a deep subpath of the package',
    },
    {
      rel: 'app/pg-sibling-package.ts',
      code: "import Pool from 'pg-pool'\nexport const p = Pool\n",
      expect: ['pg-outside-db'],
      why: 'R1: pg-pool exports Pool directly',
    },
    {
      rel: 'app/pg-deep-relative.ts',
      code: "import { Pool } from '../node_modules/pg/lib/index.js'\nexport const p = Pool\n",
      expect: ['pg-outside-db'],
      why: 'R1: resolved-package match rather than specifier match',
    },

    // ── R2 and R3 baselines ─────────────────────────────────────────────────
    {
      rel: 'app/pool-relative.ts',
      code: `import { closePools } from '${FX_DB}/pool'\nexport const c = closePools\n`,
      expect: ['pool-outside-db'],
      why: 'R2: the allowance does NOT extend outside tests/ and scripts/',
    },
    {
      rel: 'app/pool-namespace.ts',
      code: `import * as p from '${FX_DB}/pool'\nexport const c = p\n`,
      expect: ['pool-outside-db'],
      why: 'R2: whole-module import of the pool',
    },
    {
      rel: 'app/migrator-named.ts',
      code: `import { withMigrator } from '${FX_DB}'\nexport const w = withMigrator\n`,
      expect: ['with-migrator-outside-tests'],
      why: 'R3 baseline',
    },
    {
      rel: 'app/migrator-aliased.ts',
      code: `import { withMigrator as wm } from '${FX_DB}'\nexport const w = wm\n`,
      expect: ['with-migrator-outside-tests'],
      why: 'R3: the alias keeps the original name in propertyName',
    },
    {
      rel: 'app/migrator-require-property.ts',
      code: `export const w: unknown = require('${FX_DB}').withMigrator\n`,
      expect: ['with-migrator-outside-tests'],
      why: 'R3: a property read off require()',
    },

    // ── negative controls outside every zone ────────────────────────────────
    {
      rel: 'app/clean.ts',
      code: "import { join } from 'node:path'\nexport const j = join\n",
      expect: [],
      why: 'negative control: an ordinary import must stay silent',
    },
    {
      rel: 'app/clean-public-surface.ts',
      code: `import { withUser } from '${FX_DB}'\nexport const u = withUser\n`,
      expect: [],
      why: 'negative control: withUser is the sanctioned entry point',
    },
    {
      rel: 'app/clean-side-effect-import.ts',
      code: `import '${FX_DB}'\nexport {}\n`,
      expect: [],
      why: 'negative control: a bare import binds nothing, so it launders nothing',
    },

    // ── the R2 allowance, in the zones it applies to ────────────────────────
    {
      rel: 'tests/pool-teardown-allowed.ts',
      code:
        `import { closePools, resetPrivilegeAssertionCacheForTests } from '${FX_DB}/pool'\n` +
        'export const t = [closePools, resetPrivilegeAssertionCacheForTests]\n',
      expect: [],
      why: 'THE ALLOWANCE: exactly the import tests/support/scoped-pg/index.ts prescribes',
    },
    {
      rel: 'tests/pool-guard-allowed.ts',
      code:
        `import { assertUnprivilegedOnce } from '${FX_DB}/pool'\n` +
        'export const g = assertUnprivilegedOnce\n',
      expect: [],
      why: 'THE ALLOWANCE: the role guard, needed to write its positive control',
    },
    {
      rel: 'scripts/pool-acquire-app-allowed.ts',
      code:
        `import { acquireAppClient } from '${FX_DB}/pool'\n` +
        'export const a = acquireAppClient\n',
      expect: [],
      why: 'THE ALLOWANCE: in scripts/ too, for the 28000 / 42501 paired controls',
    },
    {
      rel: 'tests/migrator-allowed.ts',
      code: `import { withMigrator } from '${FX_DB}'\nexport const w = withMigrator\n`,
      expect: [],
      why: 'R3 zone: tests/ may consume the migrator wrapper',
    },

    // ── the allowance is NARROW: these stay red inside tests/ ───────────────
    {
      rel: 'tests/pg-still-denied.ts',
      code: "import { Pool } from 'pg'\nexport const p = Pool\n",
      expect: ['pg-outside-db'],
      why: 'NARROWNESS: a general `import { Pool }` from tests/ still fails',
    },
    {
      rel: 'tests/pool-constructor-denied.ts',
      code: `import { Pool } from '${FX_DB}/pool'\nexport const p = Pool\n`,
      expect: ['pool-outside-db'],
      why: 'NARROWNESS: Pool is not on the allowance, whatever module it comes from',
    },
    {
      rel: 'tests/pool-migrator-client-denied.ts',
      code:
        `import { acquireMigratorClient } from '${FX_DB}/pool'\n` +
        'export const a = acquireMigratorClient\n',
      expect: ['pool-outside-db'],
      why: 'NARROWNESS: the RLS-bypassing connection stays behind withMigrator',
    },
    {
      rel: 'tests/pool-namespace-denied.ts',
      code: `import * as p from '${FX_DB}/pool'\nexport const c = p\n`,
      expect: ['pool-outside-db'],
      why: 'NARROWNESS: a namespace object reaches every export, so it is refused',
    },
    {
      rel: 'tests/pool-mixed-denied.ts',
      code:
        `import { closePools, acquireMigratorClient } from '${FX_DB}/pool'\n` +
        'export const m = [closePools, acquireMigratorClient]\n',
      expect: ['pool-outside-db'],
      why: 'NARROWNESS: one name off the allowance poisons the whole reference',
    },
    {
      rel: 'tests/pool-case-denied.ts',
      code:
        `import { acquireMigratorClient } from '${FX_DB}/POOL'\n` +
        'export const a = acquireMigratorClient\n',
      expect: ['pool-outside-db'],
      why: 'NARROWNESS: the allowance is not a way around the case fold',
    },
    {
      rel: 'tests/opaque-denied.ts',
      code: `const n = '${FX_DB}/pool'\nexport const m = await import(n)\n`,
      expect: ['opaque-specifier'],
      why: 'NARROWNESS: tests/ get no exemption from R4',
    },

    // ── negative controls INSIDE the permitted directory ────────────────────
    {
      rel: `${DB_DIR_POSIX}/permitted.ts`,
      code:
        "import { Pool } from 'pg'\n" +
        "import { acquireMigratorClient } from './pool'\n" +
        "import { withMigrator } from './index'\n" +
        'export const all = [Pool, acquireMigratorClient, withMigrator]\n',
      expect: [],
      why: 'negative control: all four rules permit tests/support/scoped-pg/ itself',
    },
    {
      rel: `${DB_DIR_POSIX}/opaque-permitted.ts`,
      code: "const n = 'pg'\nexport const m = await import(n)\n",
      expect: [],
      why: "negative control: R4's documented carve-out inside the db directory",
    },
  ]
}

function buildSelftestMirror(mirror: string, root: string): void {
  rmSync(mirror, { recursive: true, force: true })
  const mirrorDbDir = path.join(mirror, DB_DIR_REL)
  mkdirSync(mirrorDbDir, { recursive: true })

  writeFileSync(path.join(mirror, 'tsconfig.json'), `${SELFTEST_TSCONFIG}\n`)
  writeFileSync(path.join(mirrorDbDir, 'pool.ts'), SELFTEST_POOL_STUB)
  writeFileSync(path.join(mirrorDbDir, 'index.ts'), SELFTEST_INDEX_STUB)

  // Symlinked, not copied: 'pg' and 'pg-pool' must resolve from inside the
  // mirror so R1's resolved-package leg is genuinely exercised.
  const nodeModules = path.join(root, 'node_modules')
  if (existsSync(nodeModules)) {
    symlinkSync(nodeModules, path.join(mirror, 'node_modules'), 'dir')
  }

  for (const fixture of selftestFixtures()) {
    const full = path.join(mirror, fixture.rel)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, fixture.code)
  }
}

function runSelftest(root: string, keep: boolean): number {
  // A control on the control: the allowance must never swallow the symbols the
  // boundary exists to keep out.
  const leaked = POOL_TEST_ONLY_IMPORTS.filter((n) => POOL_NEVER_ALLOWED.includes(n))
  if (leaked.length > 0) {
    process.stderr.write(
      `check-import-boundaries --selftest: POOL_TEST_ONLY_IMPORTS contains ` +
        `${leaked.join(', ')}, which POOL_NEVER_ALLOWED forbids. The R2 allowance has been ` +
        `widened to cover the connection handout it exists to refuse.\n`,
    )
    return 2
  }

  const fixtures = selftestFixtures()
  const offending = fixtures.filter((f) => f.expect.length > 0).length
  const clean = fixtures.filter((f) => f.expect.length === 0).length
  if (offending === 0 || clean === 0) {
    process.stderr.write(
      'check-import-boundaries --selftest: the fixture set needs both offending and clean ' +
        'fixtures, or it cannot tell a working checker from one that flags everything.\n',
    )
    return 2
  }

  const mirror = path.join(root, '.boundary-selftest')
  let result: ScanResult
  try {
    buildSelftestMirror(mirror, root)
    result = scanTree(mirror, [mirror])
  } finally {
    if (!keep) rmSync(mirror, { recursive: true, force: true })
  }

  const byFile = new Map<string, RuleId[]>()
  for (const v of result.violations) {
    const rel = path.relative(mirror, v.file)
    const list = byFile.get(rel)
    if (list === undefined) byFile.set(rel, [v.rule])
    else list.push(v.rule)
  }

  const sortRules = (rules: readonly RuleId[]): string => [...rules].sort().join(',') || '(none)'

  let failed = 0
  process.stdout.write(
    `check-import-boundaries --selftest: mirror at ${path.relative(root, mirror)}/, ` +
      `${String(result.files.length)} file(s) scanned, ${String(fixtures.length)} fixture(s), ` +
      `${String(offending)} offending / ${String(clean)} clean\n\n`,
  )
  process.stdout.write(`  ${'RESULT'.padEnd(6)}  ${'FIXTURE'.padEnd(44)}  EXPECTED -> ACTUAL\n`)
  for (const fixture of fixtures) {
    const actual = byFile.get(fixture.rel) ?? []
    const want = sortRules(fixture.expect)
    const got = sortRules(actual)
    const ok = want === got
    if (!ok) failed += 1
    process.stdout.write(
      `  ${(ok ? 'ok' : 'FAIL').padEnd(6)}  ${fixture.rel.padEnd(44)}  ${want} -> ${got}\n`,
    )
    if (!ok) process.stdout.write(`          ${fixture.why}\n`)
  }

  // A violation against a file no fixture claims means the mirror's own
  // scaffolding tripped a rule, which would make the whole run meaningless.
  const known = new Set(fixtures.map((f) => f.rel))
  for (const f of [...byFile.keys()].filter((k) => !known.has(k))) {
    failed += 1
    process.stdout.write(
      `  ${'FAIL'.padEnd(6)}  ${f.padEnd(44)}  (none) -> ${sortRules(byFile.get(f) ?? [])}\n`,
    )
    process.stdout.write('          unexpected violation in a mirror scaffold file\n')
  }

  if (failed === 0) {
    process.stdout.write(
      `\ncheck-import-boundaries --selftest: OK — all ${String(fixtures.length)} fixture(s) ` +
        `produced exactly their expected rule set.\n`,
    )
    return 0
  }
  process.stderr.write(
    `\ncheck-import-boundaries --selftest: ${String(failed)} fixture(s) did not match. The ` +
      `checker is not enforcing what this file claims it enforces.\n`,
  )
  return 2
}

// ------------------------------------------------------------------------ main

function main(): number {
  let options: Options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    if (error instanceof UsageError) {
      if (error.message !== 'help') {
        process.stderr.write(`check-import-boundaries: ${error.message}\n`)
      }
      process.stderr.write(
        'usage: tsx scripts/check-import-boundaries.ts [--root <dir>] [--selftest [--keep]] ' +
          '[--allow-empty] [--quiet] [path …]\n',
      )
      return 2
    }
    throw error
  }

  const { root, targets, allowEmpty, quiet, selftest, keep } = options

  if (selftest) return runSelftest(root, keep)

  const files = collectFiles(targets)
  if (files.length === 0) {
    const message =
      'check-import-boundaries: scanned 0 files — a checker that reaches no code cannot gate it.\n' +
      `  roots: ${targets.join(', ')}\n` +
      '  pass --allow-empty if an empty scan is genuinely expected here.\n'
    if (!allowEmpty) {
      process.stderr.write(message)
      return 2
    }
    process.stdout.write(
      message.replace('check-import-boundaries:', 'check-import-boundaries [--allow-empty]:'),
    )
    return 0
  }

  const { violations } = scanTree(root, targets)

  if (!quiet) {
    process.stdout.write(
      `check-import-boundaries: ${String(files.length)} file(s) scanned under ${targets
        .map((t) => path.relative(root, t) || t)
        .join(', ')}; ${String(RULE_COUNT)} rules enforced\n`,
    )
  }

  if (violations.length === 0) {
    process.stdout.write('check-import-boundaries: OK — no boundary violations\n')
    return 0
  }

  printViolations(violations, root, files.length)
  return 1
}

process.exitCode = main()
