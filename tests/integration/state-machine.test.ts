/**
 * [INV-03] Decision state machine — the generated column, the trigger guard, and the
 * SQLSTATE namespace they raise through.
 *
 * Canon §4.4 and V28/V29/V13. Three gates, each with a control that can make it fail:
 *
 *   1. The 32-combination meta-test. `state` is GENERATED ALWAYS AS
 *      app.derive_decision_state(...) STORED, and the BEFORE UPDATE guard derives the
 *      PROSPECTIVE state by calling the same function on NEW's timestamps. One definition
 *      serves both, which is the whole point of V29 — so the gate that matters is that
 *      the column and the function cannot drift, over every one of the 2^5 combinations
 *      of the five milestone timestamps being null or non-null.
 *
 *   2. `NEW.state` is NULL inside a BEFORE UPDATE trigger on a generated column (V28).
 *      This is the fact that made the original design inert: a transition trigger written
 *      the obvious way compares against NULL on every transition and therefore permits
 *      everything or rejects everything. It is reproduced here with a probe trigger, and
 *      the shipped guard's source is asserted not to reference NEW.state at all.
 *
 *   3. Every custom SQLSTATE round-trips UPPERCASE. A lowercase code silently resolves to
 *      42704 undefined_object (V13), so a call site that typed `'st010'` would raise an
 *      error the API maps to nothing. Verified once, here, rather than trusted at each
 *      call site.
 *
 * ── Why the owner path, and why everything is rolled back ─────────────────────────────
 *
 * statesman_app holds `GRANT UPDATE (draft_payload)` on decision and nothing else (§4.6b),
 * so it cannot write a milestone timestamp at all — a direct `update decision set
 * submitted_at = now()` raises 42501. Seeding rows with arbitrary milestone combinations
 * is therefore owner work, and under FORCE the owner is subject to the tenancy policy too
 * (V8), so the FORCE bracket has to be opened and closed exactly as the seed migration
 * does it. Every statement here runs inside one transaction that is rolled back, so the
 * bracket is restored by the rollback as well as explicitly, and the worker's sentinel
 * invariant — exactly one row per protected table (V18) — survives this file. Both are
 * asserted after the fact against pg_class and against the row count, because "the
 * rollback probably worked" is not a measurement.
 *
 * ── Tagging ───────────────────────────────────────────────────────────────────────────
 *
 * requirements-traceability.md §2 requires structural tags in a side channel the reporter
 * reads, NOT in test titles, because `it.each` interpolates its parameters into the title
 * and title matching then silently finds nothing. No reporter and no tagging helper exist
 * yet, so the tag below is a literal in a STATIC describe title and no `it.each` is used
 * anywhere in this file — the one shape that cannot be rewritten by interpolation. When
 * the tagging helper lands, these tags move to it.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { appQuery, ensureWorkerDatabase, ownerQuery, parseBoolean } from './support/db'
import { SENTINEL_USER_ID } from './support/sentinels'

// ---------------------------------------------------------------------------
// Fixture identities. Distinct from the sentinel ids in support/sentinels.ts, so a leak
// out of a rolled-back transaction is attributable rather than mistaken for the seed.
// ---------------------------------------------------------------------------

const PROBE_USER_ID = '00000000-0000-0000-0000-0000000c0de0'
const PROBE_USER_EMAIL = 'state-machine-probe@statesman.invalid' // .invalid, RFC 2606
const PROBE_DECISION_ID = '00000000-0000-0000-0000-0000000c0dec'

/** Not a valid argon2 encoding, so this fixture account can never authenticate. */
const UNUSABLE_HASH = '!not-a-hash:state-machine-probe-cannot-authenticate'

// ---------------------------------------------------------------------------
// psql row plumbing. Rows are LABELLED rather than positional: psql prints nothing for
// DDL and for a `do` block, so a row index is a function of which statements happened to
// be silent. A label survives that.
// ---------------------------------------------------------------------------

function rowsLabelled(rows: readonly string[][], label: string): string[][] {
  return rows.filter((r) => r[0] === label)
}

function oneRowLabelled(rows: readonly string[][], label: string): string[] {
  const found = rowsLabelled(rows, label)
  const first = found[0]
  if (found.length !== 1 || first === undefined) {
    throw new Error(`expected exactly one '${label}' row, got ${found.length}`)
  }
  return first
}

function cell(row: readonly string[], index: number, what: string): string {
  const value = row[index]
  if (value === undefined) {
    throw new Error(`${what}: column ${index} is absent from the psql row`)
  }
  return value
}

// ---------------------------------------------------------------------------
// The oracle. A SECOND expression of canon §4.4's rule, in a different language from the
// SQL function, so that editing one and not the other is a test failure. Copying the SQL
// would make this an identity and the gate would be unable to fail.
// ---------------------------------------------------------------------------

interface MilestoneFlags {
  readonly submitted: boolean
  readonly challenged: boolean
  readonly reflected: boolean
  readonly action: boolean
  readonly closed: boolean
}

function expectedState(f: MilestoneFlags): string {
  if (f.closed) return 'reviewed_closed'
  if (f.action) return 'action_recorded'
  if (f.reflected) return 'reflected'
  if (f.challenged) return 'challenged'
  if (f.submitted) return 'submitted'
  return 'draft'
}

/** bit 0 submitted, 1 challenged, 2 reflected, 3 action_recorded, 4 closed. */
function flagsOf(combo: number): MilestoneFlags {
  return {
    submitted: (combo & 1) !== 0,
    challenged: (combo & 2) !== 0,
    reflected: (combo & 4) !== 0,
    action: (combo & 8) !== 0,
    closed: (combo & 16) !== 0,
  }
}

/**
 * How many of the 32 combinations the argument-permuted call must disagree on.
 *
 * The permutation swaps the submitted and closed arguments. `closed` dominates the CASE
 * and `submitted` is its last branch, so the two calls differ exactly when precisely one
 * of those two timestamps is set — 2 * 2^3 = 16 of the 32 rows. Derived from the rule,
 * not read off the output, so a change in the rule breaks this number too.
 */
const PERMUTED_DISAGREEMENTS = 16

// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Clone the worker database inside the hook, which has the 120 s budget. Leaving it to
  // the first `it` would charge CREATE DATABASE ... TEMPLATE against the 30 s test
  // timeout, and a timeout there reads as a failing invariant rather than a slow clone.
  await ensureWorkerDatabase()
}, 120_000)

describe('[INV-03] state is derived by one function used twice (canon 4.4, V29)', () => {
  it('agrees with the stored generated column across all 32 milestone combinations', async () => {
    const rows = await ownerQuery(
      `begin;
       alter table public.decision no force row level security;   -- V8 bracket OPEN

       insert into public.app_user (id, email, password_hash, algo_ver)
       values (:'uid', :'email', :'hash', 1);

       -- One row per combination. The timestamps are distinct per milestone so a row
       -- that came back with the wrong columns populated is visible, not merely "set".
       insert into public.decision
         (user_id, draft_payload, submitted_at, challenged_at, reflected_at,
          action_recorded_at, closed_at)
       select :'uid'::uuid,
              jsonb_build_object('combo', i),
              case when (i &  1) <> 0 then '2026-01-02T00:00:00Z'::timestamptz end,
              case when (i &  2) <> 0 then '2026-01-03T00:00:00Z'::timestamptz end,
              case when (i &  4) <> 0 then '2026-01-04T00:00:00Z'::timestamptz end,
              case when (i &  8) <> 0 then '2026-01-05T00:00:00Z'::timestamptz end,
              case when (i & 16) <> 0 then '2026-01-06T00:00:00Z'::timestamptz end
         from generate_series(0, 31) as g(i);

       select 'combo',
              draft_payload->>'combo',
              state::text,
              app.derive_decision_state(submitted_at, challenged_at, reflected_at,
                                        action_recorded_at, closed_at)::text,
              -- Deliberately permuted arguments: submitted and closed swapped. This is
              -- the positive control for the comparison itself (see below).
              app.derive_decision_state(closed_at, challenged_at, reflected_at,
                                        action_recorded_at, submitted_at)::text,
              (submitted_at       is not null)::text,
              (challenged_at      is not null)::text,
              (reflected_at       is not null)::text,
              (action_recorded_at is not null)::text,
              (closed_at          is not null)::text
         from public.decision
        where user_id = :'uid'::uuid
        order by (draft_payload->>'combo')::integer;

       alter table public.decision force row level security;      -- V8 bracket CLOSED
       rollback;`,
      { uid: PROBE_USER_ID, email: PROBE_USER_EMAIL, hash: UNUSABLE_HASH },
    )

    const combos = rowsLabelled(rows, 'combo')
    expect(combos).toHaveLength(32)

    const seen = new Set<number>()
    const stateCounts = new Map<string, number>()
    let permutedDisagreements = 0

    for (const row of combos) {
      const comboText = cell(row, 1, 'combo index')
      const combo = Number.parseInt(comboText, 10)
      expect(Number.isInteger(combo), `combo index '${comboText}' is not an integer`).toBe(
        true,
      )
      expect(seen.has(combo), `combination ${comboText} came back twice`).toBe(false)
      seen.add(combo)

      const stored = cell(row, 2, `combo ${comboText} stored state`)
      const derived = cell(row, 3, `combo ${comboText} derived state`)
      const permuted = cell(row, 4, `combo ${comboText} permuted state`)
      const actual: MilestoneFlags = {
        submitted: parseBoolean(row[5], `combo ${comboText} submitted_at`),
        challenged: parseBoolean(row[6], `combo ${comboText} challenged_at`),
        reflected: parseBoolean(row[7], `combo ${comboText} reflected_at`),
        action: parseBoolean(row[8], `combo ${comboText} action_recorded_at`),
        closed: parseBoolean(row[9], `combo ${comboText} closed_at`),
      }

      // Leg 0. The row holds the combination we asked for. Without this the whole
      // meta-test is satisfiable by 32 identical draft rows: `stored === derived` would
      // hold trivially, every assertion below would pass, and nothing would have been
      // enumerated. The enumeration is the test, so the enumeration needs checking.
      expect(actual, `combination ${comboText} was not inserted as requested`).toEqual(
        flagsOf(combo),
      )

      // Leg 1. The divergence gate required by canon §4.4: the stored column and the
      // function must agree. They are the same definition (V29), so this fails only if
      // the column was computed under a different definition than the one installed now —
      // which is exactly the drift it exists to catch.
      expect(
        derived,
        `combination ${comboText}: generated column says '${stored}' but ` +
          `app.derive_decision_state() says '${derived}' — the column and the trigger ` +
          'guard have drifted apart (V29)',
      ).toBe(stored)

      // Leg 2. The correctness gate. Both of the above could agree on a wrong answer.
      expect(
        stored,
        `combination ${comboText} (${JSON.stringify(actual)}): expected ` +
          `'${expectedState(actual)}', got '${stored}'`,
      ).toBe(expectedState(actual))

      if (permuted !== stored) permutedDisagreements += 1
      stateCounts.set(stored, (stateCounts.get(stored) ?? 0) + 1)
    }

    // Every combination exactly once.
    expect([...seen].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 32 }, (_unused, i) => i),
    )

    // THE POSITIVE CONTROL for legs 1 and 2. `stored === derived` is an equality between
    // two values that come back on the same row from the same statement; if the plumbing
    // silently handed back the same string twice, or the comparison were inert, every
    // combination would pass and the gate could not fail. The permuted call is the same
    // function on the same row with two arguments swapped, so it MUST disagree on
    // precisely the 16 combinations where exactly one of submitted_at/closed_at is set.
    // A run where this is 0 means the comparison is not measuring anything.
    expect(
      permutedDisagreements,
      'the argument-permuted derivation agreed with the stored column on ' +
        `${String(32 - permutedDisagreements)} of 32 combinations — the comparison in ` +
        'legs 1 and 2 cannot distinguish a wrong derivation from a right one, so those ' +
        'assertions prove nothing',
    ).toBe(PERMUTED_DISAGREEMENTS)

    // Structural check on the enumeration: each state must appear exactly as often as
    // the rule implies. draft needs all five null; submitted needs submitted set and the
    // four later ones null; closed_at alone dominates 16 rows. If these counts are wrong
    // the 32 rows are not the 32 combinations.
    expect(Object.fromEntries([...stateCounts].sort())).toEqual({
      action_recorded: 8,
      challenged: 2,
      draft: 1,
      reflected: 4,
      reviewed_closed: 16,
      submitted: 1,
    })
  })

  it('left the FORCE bracket closed and the sentinel row count untouched', async () => {
    // The previous test opened `no force` on a table whose RLS is the basis of every
    // tenancy assertion in this worker (isolate: false — one database per worker PROCESS,
    // shared by every file in it). Leaving it open would not fail anything locally and
    // would quietly make the rest of the run vacuous, so it is asserted from the catalog,
    // which is readable regardless of RLS. The rollback is also asserted to have
    // discarded the fixture rows, and the sentinel to have survived them.
    //
    // ── WHY THESE COUNTS ARE SCOPED AND NOT A WHOLE-TABLE COUNT ──────────────────────
    //
    // This leg used to read `select count(*) from public.decision` and require 1. That
    // is a WHOLE-TABLE claim inside a database `vitest.integration.config.ts`
    // deliberately SHARES between every test file in the worker process (`isolate:
    // false`, one clone per worker PROCESS, not per file). It therefore measured which
    // sibling files had run first, not anything about this file: reproduced at
    // `--maxWorkers=1` as expected 1, got 13, and spontaneously in a normal run as 20,
    // while this file passes 5/5 alone. boundary-guards.test.ts already prints the
    // diagnosis on stderr — "public.decision still holds 10 rows: the sentinel plus 9
    // row(s) left by ANOTHER test file in this worker".
    //
    // The whole-table count was conflating two independent claims, which is why it could
    // not be rescued as written. They are now separate cells, each scoped to rows whose
    // owner this file knows:
    //
    //   - the SENTINEL survived this file's fixture. Still exactly 1, because canon §4.8
    //     rule 9 is one sentinel per protected table (V18), and every denial assertion in
    //     the worker rests on that row existing. This is the half of the old assertion
    //     that carried real coverage: a fixture that deleted or duplicated the sentinel
    //     damages the whole worker and no probe-scoped count can see it.
    //   - this file's PROBE rows are gone, i.e. the rollback worked.
    //
    // Switching the config to `isolate: true` would also have made the old count
    // determinate, and was rejected: per-file isolation is the harness contract other
    // agents' files are written against, and changing it here would silently re-point
    // every one of them at a fresh clone.
    const rows = await ownerQuery(
      `select 'rls', c.relrowsecurity::text, c.relforcerowsecurity::text
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'decision';
       alter table public.decision no force row level security;
       select 'rows',
              (select count(*)::text from public.decision where user_id = :'sentinel'::uuid),
              (select count(*)::text from public.decision where user_id = :'uid'::uuid),
              (select count(*)::text from public.app_user where id = :'uid'::uuid);
       alter table public.decision force row level security;`,
      { uid: PROBE_USER_ID, sentinel: SENTINEL_USER_ID },
    )

    const rls = oneRowLabelled(rows, 'rls')
    expect(parseBoolean(rls[1], 'decision.relrowsecurity')).toBe(true)
    expect(parseBoolean(rls[2], 'decision.relforcerowsecurity')).toBe(true)

    const counts = oneRowLabelled(rows, 'rows')
    expect(
      cell(counts, 1, 'sentinel decision rows'),
      `public.decision must still hold exactly one row owned by ${SENTINEL_USER_ID}. ` +
        'This file brackets FORCE off and writes to the table; damaging the sentinel ' +
        'would leave every denial assertion in this worker satisfiable by an empty ' +
        'table (V18) without failing anything here.',
    ).toBe('1')
    expect(
      cell(counts, 2, 'probe decision rows'),
      'a rolled-back fixture left decision rows behind',
    ).toBe('0')
    expect(
      cell(counts, 3, 'probe app_user rows'),
      'a rolled-back fixture left an app_user row behind',
    ).toBe('0')
  })
})

describe('[INV-03] NEW.state is NULL in BEFORE UPDATE on a generated column (V28)', () => {
  it('a probe trigger sees NULL before and the real value after', async () => {
    // The probe records what it saw into transaction-local GUCs rather than raising,
    // because an exception would abort the transaction and take the evidence with it.
    // `set_config(..., true)` here is safe from V17 — that fact is about a function
    // carrying a SET clause, and these settings are read inside the same transaction and
    // discarded by its rollback, which is asserted in the next test.
    const rows = await ownerQuery(
      `begin;
       alter table public.decision no force row level security;

       insert into public.app_user (id, email, password_hash, algo_ver)
       values (:'uid', :'email', :'hash', 1);
       insert into public.decision (id, user_id) values (:'did', :'uid');

       create function app.probe_generated_state() returns trigger
         language plpgsql set search_path = pg_catalog as $probe$
       begin
         perform set_config('probe.' || lower(TG_WHEN) || '_ran', 'yes', true);
         perform set_config('probe.' || lower(TG_WHEN) || '_old_state',
                            coalesce(OLD.state::text, '<NULL>'), true);
         perform set_config('probe.' || lower(TG_WHEN) || '_new_state',
                            coalesce(NEW.state::text, '<NULL>'), true);
         return NEW;
       end $probe$;

       -- Named so they sort around the shipped triggers (decision_touch_draft,
       -- decision_transition), which fire in name order.
       create trigger aaa_probe_before before update on public.decision
         for each row execute function app.probe_generated_state();
       create trigger zzz_probe_after  after  update on public.decision
         for each row execute function app.probe_generated_state();

       -- A LEGAL transition (draft -> submitted), so the shipped guard permits it and the
       -- statement completes. An illegal one would abort and the GUCs would be unreadable.
       update public.decision set submitted_at = '2026-02-01T00:00:00Z'::timestamptz
        where id = :'did';

       select 'probe',
              coalesce(current_setting('probe.before_ran',       true), '<unset>'),
              coalesce(current_setting('probe.before_old_state', true), '<unset>'),
              coalesce(current_setting('probe.before_new_state', true), '<unset>'),
              coalesce(current_setting('probe.after_ran',        true), '<unset>'),
              coalesce(current_setting('probe.after_old_state',  true), '<unset>'),
              coalesce(current_setting('probe.after_new_state',  true), '<unset>'),
              (select state::text from public.decision where id = :'did');

       drop trigger aaa_probe_before on public.decision;
       drop trigger zzz_probe_after  on public.decision;
       drop function app.probe_generated_state();
       alter table public.decision force row level security;
       rollback;`,
      {
        uid: PROBE_USER_ID,
        email: PROBE_USER_EMAIL,
        hash: UNUSABLE_HASH,
        did: PROBE_DECISION_ID,
      },
    )

    const p = oneRowLabelled(rows, 'probe')

    // The instrument ran at all. Without this leg, "NEW.state was NULL" is
    // indistinguishable from "the trigger never fired and the GUC was never set".
    expect(cell(p, 1, 'before_ran'), 'the BEFORE UPDATE probe never fired').toBe('yes')
    expect(cell(p, 4, 'after_ran'), 'the AFTER UPDATE probe never fired').toBe('yes')

    // V28, the fact that made the original design inert.
    expect(cell(p, 2, 'before_old_state')).toBe('draft')
    expect(
      cell(p, 3, 'before_new_state'),
      'NEW.state was readable in BEFORE UPDATE. If that is now true on this cluster, ' +
        'the reasoning behind the prospective-state derivation changed and canon 4.4 ' +
        'needs revisiting — it does not mean the guard may read NEW.state.',
    ).toBe('<NULL>')

    // THE POSITIVE CONTROL. The same probe function, the same GUC mechanism, the same
    // row, the same statement — only the firing time differs. AFTER reports the real
    // value, so a NULL in BEFORE is attributable to the generated column's evaluation
    // order and not to a probe that cannot read `state` at all.
    expect(cell(p, 5, 'after_old_state')).toBe('draft')
    expect(
      cell(p, 6, 'after_new_state'),
      'the AFTER UPDATE probe could not read state either, so the BEFORE NULL above is ' +
        'evidence about the probe rather than about generated columns',
    ).toBe('submitted')

    // And the update really did transition the row.
    expect(cell(p, 7, 'stored state after update')).toBe('submitted')
  })

  it('the shipped transition guard does not reference NEW.state', async () => {
    // The regression guard proper. The test above establishes the hazard; this one
    // asserts the shipped code avoids it, by reading the installed definition out of the
    // catalog rather than the file on disk — the database is what runs.
    const rows = await ownerQuery(
      `select 'def',
              replace(replace(
                pg_get_functiondef('app.guard_decision_transition()'::regprocedure),
                E'\\n', ' '), '|', '/');`,
    )
    const definition = cell(oneRowLabelled(rows, 'def'), 1, 'guard definition')

    expect(
      /\bNEW\s*\.\s*state\b/i.test(definition),
      'app.guard_decision_transition() references NEW.state, which is NULL in a BEFORE ' +
        'UPDATE trigger on a generated column (V28). Every transition then compares ' +
        'against NULL, so the guard permits everything or rejects everything.',
    ).toBe(false)

    // POSITIVE CONTROL for the pattern and for the retrieval. `OLD.state` IS read by the
    // guard — it is the left-hand side of the whitelist comparison — so a pattern of the
    // same shape must match. Without this, an empty or truncated `definition` would
    // satisfy the assertion above and the check could never fail.
    expect(
      /\bOLD\s*\.\s*state\b/i.test(definition),
      'the guard definition does not mention OLD.state, so either the retrieval returned ' +
        'nothing useful or the pattern above cannot match anything',
    ).toBe(true)

    // The guard must derive the prospective state from NEW's timestamps (V29), i.e. it
    // reads NEW's milestone columns and calls the shared function.
    expect(/\bNEW\s*\.\s*submitted_at\b/i.test(definition)).toBe(true)
    expect(/app\.derive_decision_state\s*\(/i.test(definition)).toBe(true)
  })
})

describe('[INV-03] custom SQLSTATEs round-trip uppercase (V13)', () => {
  /** Canon §4.4 / the error map. ALL UPPERCASE, every one of them. */
  const UPPERCASE_CODES = [
    'ST001', // append-only violation
    'ST002', // illegal state transition
    'ST003', // submitted draft is frozen
    'ST005', // row count was not 1
    'ST010', // not a submittable draft
    'ST011', // not a submitted decision
    'ST012', // unknown milestone
    'ST099', // security posture failed
  ] as const

  /**
   * The lowercase spellings are the NEGATIVE CONTROL and the point of V13: a lowercase
   * custom SQLSTATE does not fail loudly, it silently resolves to 42704
   * undefined_object. If these ever round-tripped as typed, the uppercase assertions
   * above would be vacuous — case would not matter and the rule would be arbitrary.
   */
  const LOWERCASE_CONTROL = ['st001', 'st010'] as const
  const UNDEFINED_OBJECT = '42704'

  it('every code raises as itself, and a lowercase code silently becomes 42704', async () => {
    const probes = [...UPPERCASE_CODES, ...LOWERCASE_CONTROL]

    // Run as statesman_app: these codes exist to reach the application through this
    // connection, so the round trip is measured on the role that will see them.
    // The code list is handed over through a transaction-local GUC rather than being
    // interpolated into the `do` body. psql performs :'var' substitution everywhere
    // EXCEPT inside quoted strings, and a `do $probe$ ... $probe$` body is a
    // dollar-quoted string — a `:'codes'` written in there would reach the server
    // verbatim and raise a syntax error. set_config takes the value as a parameter, so
    // nothing is concatenated into SQL text either way.
    const rows = await appQuery(
      `begin;
       select set_config('probe.request', :'codes', true);
       do $probe$
       declare codes text[] := string_to_array(current_setting('probe.request'), ',');
               c text; got text; acc text := '';
       begin
         foreach c in array codes loop
           begin
             raise exception 'sqlstate round-trip probe' using errcode = c;
             got := 'NO_RAISE';
           exception when others then
             got := sqlstate;
           end;
           acc := acc || c || '=' || got || ';';
         end loop;
         perform set_config('probe.codes', acc, true);
       end $probe$;
       select 'codes', coalesce(current_setting('probe.codes', true), '<unset>');
       rollback;`,
      { codes: probes.join(',') },
    )

    const observed = new Map<string, string>()
    for (const pair of cell(oneRowLabelled(rows, 'codes'), 1, 'round-trip result')
      .split(';')
      .filter((s) => s.length > 0)) {
      const [requested, got] = pair.split('=')
      if (requested === undefined || got === undefined) {
        throw new Error(`malformed round-trip pair '${pair}'`)
      }
      observed.set(requested, got)
    }

    // Every probe reported something. `NO_RAISE` would mean the raise did not happen and
    // the exception handler never ran, which would make the whole table meaningless.
    expect([...observed.keys()].sort()).toEqual([...probes].sort())
    expect(
      [...observed.values()].filter((v) => v === 'NO_RAISE'),
      'at least one probe did not raise at all, so its reported code is not a round trip',
    ).toEqual([])

    for (const code of UPPERCASE_CODES) {
      expect(
        observed.get(code),
        `raise ... using errcode = '${code}' came back as ` +
          `'${String(observed.get(code))}'. A code that does not round-trip is mapped to ` +
          'no application error at all.',
      ).toBe(code)
    }

    for (const code of LOWERCASE_CONTROL) {
      expect(
        observed.get(code),
        `the lowercase control '${code}' round-tripped as ` +
          `'${String(observed.get(code))}' instead of ${UNDEFINED_OBJECT}. V13 no longer ` +
          'holds on this cluster, which means the uppercase assertions above are not ' +
          'testing case sensitivity.',
      ).toBe(UNDEFINED_OBJECT)
    }
  })
})
