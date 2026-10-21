// eslint.config.mjs — flat config for typescript-eslint (canon §8.7: eslint is its
// own CI step; `next build` may not lint).
//
// ────────────────────────────────────────────────────────────────────────────────
// STATUS: THIS CONFIG HAS NEVER BEEN EXECUTED.
//
// Neither `eslint` nor `typescript-eslint` nor `@eslint/js` is installed in
// node_modules. The environment is frozen, so they were NOT installed. Until they
// are, `npm run lint` cannot run and `scripts/gates.sh` reports the lint step as
// NOT RUN (exit 127) — which is a gate FAILURE, never a pass (canon §8.6:
// "Unexecuted is NOT RUN, never PASSED").
//
// To make it runnable:
//   npm i -D eslint@9 typescript-eslint@8 @eslint/js@9
//
// The flat-config shapes used below (`tseslint.config()`, per-entry `extends`,
// `parserOptions.projectService`) are the typescript-eslint v8 / eslint v9 API.
// Per canon O4 those names must be read back from the installed release before
// this file is trusted — they are written here from the documented API, not from
// a command run against installed tooling.
// ────────────────────────────────────────────────────────────────────────────────

import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

// ────────────────────────────────────────────────────────────────────────────────
// Selectors and import rules are named here, once, so the narrowed overrides
// further down can RESTATE a rule rather than switch it off. An override that
// says `'no-restricted-syntax': 'off'` silently drops the SQL-interpolation and
// `unknown`-laundering bans along with the one selector it meant to relax.
// ────────────────────────────────────────────────────────────────────────────────

/** Canon §6.1: asserting a brand erases the guard the branded type provides. */
const BRAND_ASSERTION_SELECTORS = [
  {
    selector: 'TSAsExpression > TSTypeReference > Identifier[name="AuthenticatedSession"]',
    message:
      'AuthenticatedSession may only be produced inside requireSession(). ' +
      'Asserting the brand erases the guard (canon §6.1).',
  },
  {
    selector: 'TSAsExpression > TSTypeReference > Identifier[name="UserScopedClient"]',
    message:
      'UserScopedClient may only be produced inside withUser(). ' +
      'Asserting the brand erases the guard (canon §6.1).',
  },
]

/**
 * These two apply EVERYWHERE, including in the modules that mint the brands.
 * Neither has a legitimate exception anywhere in the codebase.
 */
const UNIVERSAL_SYNTAX_SELECTORS = [
  {
    // `as unknown as X` launders any brand or any type. Same hole, two steps.
    selector: 'TSAsExpression > TSAsExpression > TSUnknownKeyword',
    message:
      'Double assertion through `unknown` launders a branded type. ' +
      'Produce the value through its constructor function instead.',
  },
  {
    // Canon §6.1 rule 4: zero interpolated values in SQL. A template literal
    // with a substitution handed to .query() is string-built SQL.
    selector: 'CallExpression[callee.property.name="query"] > TemplateLiteral[expressions.length>0]',
    message:
      'Never string-interpolate into SQL. Use $1-style parameters, and set ' +
      'statement_timeout via set_config($1,$2,true) with a Zod-validated integer.',
  },
]

/** The driver ban. Canon §6.1: `pg` may be imported only from src/server/db/. */
const PG_DRIVER_PATHS = [
  {
    name: 'pg',
    message: 'The pg driver may be imported only from src/server/db/. Use withUser/withMigrator.',
  },
  {
    name: 'pg-pool',
    message: 'pg-pool exports Pool directly. Same boundary as pg (src/server/db/ only).',
  },
]

/** The module-private pool. Canon §6.1: only withUser/withMigrator leave the db module. */
const POOL_PRIVACY_PATTERNS = [
  {
    group: ['**/server/db/pool', '**/server/db/pool.*'],
    message: 'src/server/db/pool.ts is module-private. Only withUser and withMigrator are exported.',
  },
]

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'dist/**',
      'build/**',
      'coverage/**',
      'reports/**',
      'playwright-report/**',
      'test-results/**',
      'next-env.d.ts',
    ],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    rules: {
      // ── Canon §6.1: the branded types are erasable with one assertion, so the
      // assertion itself is banned. This is the AST check the canon requires;
      // a type cannot defend itself against `as`.
      'no-restricted-syntax': ['error', ...BRAND_ASSERTION_SELECTORS, ...UNIVERSAL_SYNTAX_SELECTORS],

      // `no-restricted-imports` matches the SPECIFIER STRING, not the resolved path,
      // so `../db/pool` walks straight through the second pattern below. It is kept
      // only as a fast first signal in the editor. The enforcing gate is
      // `npm run boundaries` (scripts/check-import-boundaries.ts), which resolves
      // every specifier through the TypeScript module resolver. Canon §6.1 states
      // explicitly that neither mechanism is sufficient alone.
      'no-restricted-imports': [
        'error',
        { paths: PG_DRIVER_PATHS, patterns: POOL_PRIVACY_PATTERNS },
      ],

      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-param-reassign': 'error',
      'prefer-const': 'error',
    },
  },

  {
    // ── src/server/db/ IS the module that owns the driver and the pool.
    //
    // The `pg` ban says in its own message that the driver "may be imported only
    // from src/server/db/", but it was applied to every file including that
    // directory, so pool.ts and scoped.ts were reported for doing the one thing
    // the rule exists to permit. The boundary is unchanged for everyone else.
    //
    // The pool-privacy pattern is lifted here for the same reason: `pool.ts` is
    // inside this module, and `scoped.ts` reaching it is the module's own
    // internals, not a leak. The enforcing gate for both remains
    // `npm run boundaries`, which resolves specifiers rather than matching strings.
    files: ['src/server/db/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },

  {
    // ── The designated test-setup importer of the module-private pool.
    //
    // `closePools` and `resetPrivilegeAssertionCacheForTests` are deliberately not
    // re-exported by src/server/db/index.ts, and pool.ts's own doc comment
    // prescribes that test setup import them from `./pool` directly. This file is
    // the single place in tests/ that does so.
    //
    // `pg` STAYS BANNED here, which is the point of restating the rule instead of
    // switching it off: this module talks to Postgres through psql precisely so
    // that the driver boundary has no hole in tests/, and that is worth keeping
    // mechanically enforced.
    files: ['tests/integration/support/db.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: PG_DRIVER_PATHS }],
    },
  },

  {
    // ── The two sole mint sites for the branded types.
    //
    // Both brands are declared `declare const … : unique symbol`, which has NO
    // runtime value. There is therefore no way to construct a value of the branded
    // type other than an assertion, so the mint itself cannot satisfy a blanket ban
    // on that assertion — and a brand that can never be minted makes the guarded
    // API unusable. Canon §6.1 names these two functions as the only producers, and
    // each mint carries an `AST-ALLOW(brand-mint)` comment.
    //
    // RESIDUAL GAP, stated plainly: within these two files a SECOND brand assertion
    // would no longer be flagged. eslint selectors cannot say "only as the
    // initialiser of this one declaration", so the containment here is the file
    // list, not the rule. The `unknown`-laundering and SQL-interpolation bans are
    // restated below and remain active in both files.
    files: ['src/server/session/resolve.ts', 'src/server/db/scoped.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...UNIVERSAL_SYNTAX_SELECTORS],
    },
  },

  {
    // Gate scripts, migrations tooling and tests print to stdout by design, and
    // they are the only places allowed to touch the migrator connection.
    files: ['scripts/**/*.ts', 'tests/**/*.ts', '*.config.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },

  {
    // Config files and plain JS carry no type information.
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  {
    // ── tests/evidence/*.mts — outside the typed project, by construction.
    //
    // These are standalone evidence scripts run directly with tsx. They are not in
    // tsconfig.json's `include`, and putting them there adds 7 implicit-any errors
    // to `tsc --noEmit` (measured), so that is a separate piece of work.
    //
    // Previously each of these three files produced a single PARSING ERROR — "was
    // not found by the project service" — which meant NO rule ran on them at all.
    // Giving them an inferred program instead surfaced 76 errors, essentially all
    // `no-unsafe-*`: the scripts reach their subjects through `await import(...)`,
    // so every value in them is `any` and the type-aware rules have nothing real to
    // check. Type-aware rules are therefore off for these files and the syntactic
    // rules now run, where before nothing did. This is narrower than the `ignores`
    // list, which would have kept them unchecked.
    files: ['tests/evidence/**/*.mts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
)
