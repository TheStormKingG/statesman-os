/**
 * Unit: the Zod input validators at the data boundary.
 *
 * Four things, none of which needs a database:
 *
 *   1. `z.guid()` NOT `z.uuid()`, with a regression control. Zod 4's `z.uuid()`
 *      enforces the RFC 9562 version nibble `[1-8]` and variant nibble
 *      `[89abAB]`, so it REJECTS this project's own identifiers — the seeded
 *      users, every sentinel, every probe id. Postgres's `uuid` type accepts any
 *      8-4-4-4-12 hex string, which makes `z.uuid()` STRICTER THAN THE COLUMN:
 *      it rejects values the database considers legal, and the rejection then
 *      looks like a database rule that does not exist. `z.guid()` is the shape
 *      that matches the column.
 *
 *   2. Confidence bounds, mirroring `smallint check (confidence between 0 and
 *      100)`: -1 and 101 rejected, 0 and 100 accepted. The boundary values
 *      themselves, because an off-by-one in `.min`/`.max` is invisible to a test
 *      that only tries 50 and 500.
 *
 *   3. The milestone literal union rejecting an unknown milestone BEFORE SQL is
 *      reached. This is an ordering claim, not just a rejection claim: ST012
 *      from the database is mapped to a 500 precisely because the TypeScript
 *      union is supposed to make it unreachable. If validation ran after the
 *      call, a bad milestone would be a database round trip reported as a server
 *      fault.
 *
 *   4. Nothing stricter than the column. `forecast`, `horizon` and `rationale`
 *      are `text not null` with no length or content check, so a non-empty
 *      string of any size must parse.
 *
 * ── How the product functions are driven without a database ───────────────────
 *
 * `revisionInputSchema` and `stampInputSchema` are module-private, so there is
 * nothing to import and assert against directly — and that is the right design:
 * a test that imported the schema would not prove the schema is wired into the
 * call. These tests therefore drive the exported functions, `submitDecision`,
 * `appendRevision` and `stampMilestone`, against a stub client that records
 * whether it was reached and throws a distinctive error if it was. Validation is
 * synchronous and runs before the first `queryOne`, so:
 *
 *     invalid input -> ZodError, and the stub records ZERO calls
 *     valid input   -> SqlReachedError, and the stub records exactly one
 *
 * The second half is the positive control for the first: the same stub, the same
 * function, the same await, with only the input differing. Without it, "a
 * ZodError was thrown" is indistinguishable from "the stub is unreachable and
 * every input fails for some unrelated reason".
 *
 * `UserScopedClient` is branded with a non-exported `unique symbol` and canon
 * §6.1 bans `as UserScopedClient` in an AST lint rule, so the stub cannot be
 * cast into the brand and is passed with `@ts-expect-error` instead. That
 * suppression is itself a control: if the brand is ever removed from the type,
 * the expected error disappears, the directive becomes unused, and
 * `tsc --noEmit` fails.
 */
import { readFileSync, readdirSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { MILESTONES, appendRevision, stampMilestone, submitDecision } from '../support/scoped-pg'
import type { MigratorClient, RevisionInput, SqlParams } from '../support/scoped-pg'
import { UnauthenticatedError } from '../support/scoped-pg/errors'
import { enterIdentityContext, resolveSession } from '../support/scoped-pg/session'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/* ------------------------------------------------------------------ *
 * The project's real identifiers
 * ------------------------------------------------------------------ */

/**
 * Taken from `supabase/migrations/20261021140600_sentinels.sql`,
 * `tests/integration/support/sentinels.ts` and
 * `tests/integration/state-machine.test.ts`. Every one of them
 * has a `0` version nibble, which is exactly why `z.uuid()` cannot be used.
 */
const REAL_IDENTIFIERS = [
  'aaaaaaaa-0000-0000-0000-000000000001', // seeded user A
  'bbbbbbbb-0000-0000-0000-000000000002', // seeded user B
  '00000000-0000-0000-0000-00000000dead', // sentinel user
  '00000000-0000-0000-0000-00000000dec1', // sentinel decision
  '00000000-0000-0000-0000-00000000dec2', // sentinel revision
  '00000000-0000-0000-0000-00000000dec3', // sentinel idempotency token
  '00000000-0000-0000-0000-00000000beef', // the foreign identity in denial tests
  '00000000-0000-0000-0000-0000000c0de0', // state-machine probe user
  '00000000-0000-0000-0000-0000000c0dec', // state-machine probe decision
] as const

/** A textbook RFC 9562 v4 uuid: version nibble 4, variant nibble 9. */
const RFC_CONFORMING = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

/* ------------------------------------------------------------------ *
 * The stub client
 * ------------------------------------------------------------------ */

/** Thrown by the stub, so "SQL was reached" is an observation and not a guess. */
class SqlReachedError extends Error {
  constructor(readonly sql: string) {
    super(`stub client reached: ${sql}`)
    this.name = 'SqlReachedError'
  }
}

interface Reached {
  readonly sql: string
  readonly params: SqlParams | undefined
}

/**
 * A client that never answers. Typed as `MigratorClient` — the UNBRANDED shape —
 * because the brand has no runtime value and no constructor outside `withUser`.
 */
function stubClient(): { client: MigratorClient; reached: Reached[] } {
  const reached: Reached[] = []
  function record(sql: string, params?: SqlParams): never {
    reached.push({ sql, params })
    throw new SqlReachedError(sql)
  }
  return {
    client: {
      userId: REAL_IDENTIFIERS[0],
      query: (sql: string, params?: SqlParams) => record(sql, params),
      queryOne: (sql: string, params?: SqlParams) => record(sql, params),
      queryAffectingOne: (sql: string, params?: SqlParams) => record(sql, params),
    },
    reached,
  }
}

/** A revision input every field of which is legal. The baseline to perturb. */
function validRevision(overrides: Partial<RevisionInput> = {}): RevisionInput {
  return {
    decisionId: '00000000-0000-0000-0000-00000000dec1',
    idempotencyToken: '00000000-0000-0000-0000-00000000dec3',
    content: { note: 'a decision' },
    confidence: 50,
    forecast: 'the measure holds for two quarters',
    horizon: '2026-Q4',
    rationale: 'because the cost curve inverts',
    ...overrides,
  }
}

/**
 * Call `submitDecision` with the stub and report WHERE it stopped.
 *
 * `'validated'` means a ZodError was raised and the client was never touched;
 * `'reached-sql'` means validation passed and the call got as far as the query.
 */
async function submitOutcome(
  input: RevisionInput,
): Promise<{ stop: 'validated' | 'reached-sql' | 'other'; calls: number; error: unknown }> {
  const { client, reached } = stubClient()
  try {
    // @ts-expect-error UserScopedClient is branded and may only be produced by
    // withUser(); canon §6.1 bans the cast that would launder a stub into it.
    // This directive becoming unused means the brand was removed.
    await submitDecision(client, input)
    return { stop: 'other', calls: reached.length, error: undefined }
  } catch (error: unknown) {
    if (error instanceof SqlReachedError) return { stop: 'reached-sql', calls: reached.length, error }
    if (error instanceof z.ZodError) return { stop: 'validated', calls: reached.length, error }
    return { stop: 'other', calls: reached.length, error }
  }
}

async function stampOutcome(
  milestone: string,
  decisionId = '00000000-0000-0000-0000-00000000dec1',
): Promise<{ stop: 'validated' | 'reached-sql' | 'other'; calls: number; params: SqlParams | undefined }> {
  const { client, reached } = stubClient()
  try {
    // @ts-expect-error the stub is not a withUser-produced UserScopedClient, and
    // `milestone` is deliberately a plain string so an unknown value can be
    // offered at all — the literal union is the thing under test.
    await stampMilestone(client, { decisionId, milestone })
    return { stop: 'other', calls: reached.length, params: reached[0]?.params }
  } catch (error: unknown) {
    const stop =
      error instanceof SqlReachedError ? 'reached-sql' : error instanceof z.ZodError ? 'validated' : 'other'
    return { stop, calls: reached.length, params: reached[0]?.params }
  }
}

/* ------------------------------------------------------------------ *
 * 1. z.guid(), not z.uuid()
 * ------------------------------------------------------------------ */

describe('identifiers use z.guid(), not z.uuid()', () => {
  it('accepts every real project identifier through enterIdentityContext', async () => {
    for (const id of REAL_IDENTIFIERS) {
      const seen = await enterIdentityContext(id, async () => (await resolveSession()).userId)
      expect(seen, `${id} was rejected by the identity validator`).toBe(id.toLowerCase())
    }
  })

  it('REGRESSION: z.uuid() would reject these very identifiers', () => {
    // The reason `z.guid()` is not a stylistic choice. If someone "tidies" guid
    // back to uuid, every seeded identity in this project stops validating —
    // the sentinels, the fixtures, and the rows the denial tests depend on.
    for (const id of REAL_IDENTIFIERS) {
      expect(
        z.uuid().safeParse(id).success,
        `z.uuid() now ACCEPTS ${id}. Zod's RFC 9562 enforcement changed, so the ` +
          'comment in tests/support/scoped-pg/session.ts needs re-measuring — but this is ' +
          'still not permission to swap guid for uuid without re-running it.',
      ).toBe(false)
      expect(
        z.guid().safeParse(id).success,
        `z.guid() REJECTED ${id}, so the project's own identifiers no longer validate`,
      ).toBe(true)
    }

    // POSITIVE CONTROL for both validators. A conforming uuid must pass BOTH, or
    // the assertions above are satisfied by a `z.uuid()` that rejects everything
    // and a `z.guid()` that accepts everything.
    expect(z.uuid().safeParse(RFC_CONFORMING).success).toBe(true)
    expect(z.guid().safeParse(RFC_CONFORMING).success).toBe(true)

    // And `z.guid()` is not merely `z.string()`: it still rejects non-uuid text.
    expect(z.guid().safeParse('not-a-uuid').success).toBe(false)
    expect(z.guid().safeParse('').success).toBe(false)
    expect(z.guid().safeParse('aaaaaaaa-0000-0000-0000-00000000000').success).toBe(false)
  })

  it('REGRESSION: no z.uuid() call exists anywhere under src/', () => {
    // The assertion above proves `z.uuid()` is the wrong validator. This one
    // proves the wrong validator is not in use. Both are needed: the first
    // explains why, the second is what actually catches the edit.
    //
    // MEASURED, and the reason this walks the AST rather than grepping: a
    // regex over the file text reported the two files that are now
    // `tests/support/scoped-pg/scoped.ts` and
    // `tests/support/scoped-pg/session.ts` as offenders on the first run. Both
    // mentions are in COMMENTS explaining why z.uuid() is not used — the
    // comment that documents the rule tripped the check that enforces it.
    // `ts.createSourceFile` sees call expressions and not prose, which is the
    // same argument scripts/check-import-boundaries.ts makes for itself.
    //
    // ADR-0015 NOTE: those two files left `src/` with the rest of the former
    // server data boundary, so `src/` is now the production tree alone and the
    // only `.guid()` calls under it are in `src/lib/supabase/**`. The positive
    // control below is therefore load-bearing in a new way: if the Supabase
    // data layer is ever deleted or stops validating identifiers, this test
    // fails rather than passing over an empty scan.
    // The validators moved out of `src/` during the Supabase port (ADR-0015): the
    // pg-based scoped access now lives under tests/support/scoped-pg/. Scanning only
    // `src/` therefore found no `.guid()` call at all, and this test's own
    // anti-vacuity assertion fired rather than reporting a clean pass over nothing —
    // which is the behaviour that makes it worth having. Scan both roots.
    const sources = [
      ...typescriptFilesUnder(join(REPO_ROOT, 'src')),
      ...typescriptFilesUnder(join(REPO_ROOT, 'tests', 'support', 'scoped-pg')),
    ]
    expect(sources.length, 'no source files were scanned, so this check proves nothing').toBeGreaterThan(0)

    const offenders: string[] = []
    let guidCalls = 0
    for (const file of sources) {
      const called = methodCallsIn(file)
      if (called.has('uuid')) offenders.push(file)
      guidCalls += called.has('guid') ? 1 : 0
    }

    expect(
      offenders,
      "z.uuid() rejects this project's identifiers (0 version nibble) and is stricter " +
        'than the uuid column it feeds. Use z.guid().',
    ).toEqual([])

    // POSITIVE CONTROL for the walker. If the files were not parsed, or the walk
    // cannot reach a call expression, "no offenders" is vacuous. At least one
    // file must contain a `.guid()` call — the same node shape, matched.
    expect(
      guidCalls,
      'the walker found no .guid() call either, so it is not parsing the source files ' +
        'or it cannot reach a real call expression',
    ).toBeGreaterThan(0)
  })

  it('rejects a non-identifier offered as an identity, SYNCHRONOUSLY', () => {
    // The throw is synchronous even though the callback is async: the validation
    // runs before `identityStorage.run` is reached, so no promise is created.
    // That matters — a caller who writes `void enterIdentityContext(bad, fn)`
    // still gets the error rather than an unhandled rejection, and a test that
    // awaited a rejection here would pass for the wrong reason. Asserted in the
    // shape the function actually has.
    for (const bad of ['not-a-uuid', '', 'aaaaaaaa-0000-0000-0000-00000000000', '  ']) {
      expect(
        () => {
          void enterIdentityContext(bad, () => Promise.resolve('unreachable'))
        },
        `'${bad}' was accepted as an identity`,
      ).toThrow(UnauthenticatedError)
    }

    // POSITIVE CONTROL: the same call shape with a real identifier does NOT
    // throw, so the rejections above are attributable to the value.
    expect(() => {
      void enterIdentityContext(REAL_IDENTIFIERS[0], () => Promise.resolve('reached'))
    }).not.toThrow()
  })

  it('rejects a malformed decision id before SQL is reached', async () => {
    const bad = await submitOutcome(validRevision({ decisionId: 'not-a-uuid' }))
    expect(bad.stop).toBe('validated')
    expect(bad.calls).toBe(0)

    const badToken = await submitOutcome(validRevision({ idempotencyToken: '123' }))
    expect(badToken.stop).toBe('validated')
    expect(badToken.calls).toBe(0)
  })
})

/* ------------------------------------------------------------------ *
 * 2. Confidence bounds
 * ------------------------------------------------------------------ */

describe('confidence mirrors `smallint check (confidence between 0 and 100)`', () => {
  it('rejects -1 and 101, accepts 0 and 100', async () => {
    for (const confidence of [-1, 101]) {
      const out = await submitOutcome(validRevision({ confidence }))
      expect(out.stop, `confidence ${String(confidence)} was not rejected`).toBe('validated')
      expect(
        out.calls,
        `confidence ${String(confidence)} reached the database; the check constraint ` +
          'would have raised 23514 and the boundary would report it as a unique/unknown fault',
      ).toBe(0)
    }

    // THE POSITIVE CONTROL for the two assertions above, and the half that an
    // off-by-one actually breaks. The SAME call with the boundary values must get
    // all the way to the query — so the rejections are attributable to the bound
    // and not to a validator that rejects everything.
    for (const confidence of [0, 100]) {
      const out = await submitOutcome(validRevision({ confidence }))
      expect(
        out.stop,
        `confidence ${String(confidence)} is legal for the column but the validator ` +
          'rejected it. A validator stricter than its column rejects values the database ' +
          'considers legal, and the rejection looks like a database rule that does not exist.',
      ).toBe('reached-sql')
      expect(out.calls).toBe(1)
    }
  })

  it('rejects a non-integer and a non-number confidence', async () => {
    for (const confidence of [50.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = await submitOutcome(validRevision({ confidence }))
      expect(out.stop, `confidence ${String(confidence)} was not rejected`).toBe('validated')
      expect(out.calls).toBe(0)
    }
  })

  it('imposes NOTHING on forecast, horizon and rationale beyond the column', async () => {
    // `text not null`, no length or content check. A 10 000-character rationale
    // and a one-character horizon are both legal, so both must parse.
    const out = await submitOutcome(
      validRevision({ rationale: 'x'.repeat(10_000), horizon: 'y', forecast: 'z' }),
    )
    expect(out.stop).toBe('reached-sql')
  })

  it('applies the same validator to appendRevision', async () => {
    // `appendRevision` and `submitDecision` share `definerArgs`, so a bound
    // enforced on one is enforced on both — asserted rather than assumed,
    // because sharing is an implementation detail that can change.
    const { client, reached } = stubClient()
    await expect(
      // @ts-expect-error the stub is not a withUser-produced UserScopedClient.
      appendRevision(client, validRevision({ confidence: 101 })),
    ).rejects.toThrow(z.ZodError)
    expect(reached.length).toBe(0)

    const ok = stubClient()
    await expect(
      // @ts-expect-error the stub is not a withUser-produced UserScopedClient.
      appendRevision(ok.client, validRevision({ confidence: 100 })),
    ).rejects.toThrow(SqlReachedError)
    expect(ok.reached.length).toBe(1)
  })
})

/* ------------------------------------------------------------------ *
 * 3. The milestone literal union
 * ------------------------------------------------------------------ */

describe('the milestone union rejects an unknown milestone before SQL', () => {
  it('is exactly the four names app.stamp_milestone accepts', () => {
    // Written out rather than derived from MILESTONES, so a fifth name added to
    // the TypeScript union without a matching migration fails here.
    expect([...MILESTONES]).toEqual(['challenged', 'reflected', 'action_recorded', 'closed'])
    // `submitted` is NOT a milestone: `submitted_at` is stamped by
    // app.submit_decision, not by stamp_milestone. A union that accepted it would
    // offer a path to a state change the lifecycle function owns.
    expect([...MILESTONES]).not.toContain('submitted')
  })

  it('stops an unknown milestone at the validator, with zero database calls', async () => {
    for (const milestone of ['approved', 'CLOSED', 'closed ', '', 'drop table decision']) {
      const out = await stampOutcome(milestone)
      expect(out.stop, `milestone '${milestone}' was not rejected`).toBe('validated')
      expect(
        out.calls,
        `milestone '${milestone}' reached the database. ST012 is mapped to a 500 ` +
          'precisely because the union is supposed to make it unreachable; if validation ' +
          'runs after the call, bad input is reported as a server fault.',
      ).toBe(0)
    }
  })

  it('POSITIVE CONTROL: each legal milestone does reach SQL, as its own parameter', async () => {
    // Same function, same stub, same await — only the milestone differs. Without
    // this, the rejections above are satisfied by a `stampMilestone` that throws
    // for every input, and the ordering claim would be unproven.
    for (const milestone of MILESTONES) {
      const out = await stampOutcome(milestone)
      expect(out.stop, `legal milestone '${milestone}' did not reach SQL`).toBe('reached-sql')
      expect(out.calls).toBe(1)
      // The name travels as a bound parameter, not as SQL text.
      expect(out.params?.[1]).toBe(milestone)
    }
  })

  it('validates the decision id on the same call', async () => {
    const out = await stampOutcome('closed', 'not-a-uuid')
    expect(out.stop).toBe('validated')
    expect(out.calls).toBe(0)
  })
})

/* ------------------------------------------------------------------ *

 * ------------------------------------------------------------------ */

/**
 * The names of every method CALLED in `file`, read from the TypeScript AST.
 *
 * `z.uuid()` and `z.string().uuid()` both land here as a `CallExpression` whose
 * callee is a `PropertyAccessExpression` named `uuid`, so both spellings are
 * caught. Comments and string literals are not call expressions and cannot
 * contribute, which is the whole reason this is a parse and not a grep.
 */
function methodCallsIn(file: string): Set<string> {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ES2023,
    true,
  )
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      names.add(node.expression.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return names
}

/** Every `.ts`/`.tsx` under `dir`, recursively. */
function typescriptFilesUnder(dir: string): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...typescriptFilesUnder(full))
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) found.push(full)
  }
  return found
}
