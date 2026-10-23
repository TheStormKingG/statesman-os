# Mutation testing — the gate that enforces canon §8

**Status:** in use. `scripts/mutation-check.sh`, registry under `mutations/`.
**Canon:** §8 "Test doctrine — no gate without a control".

> **A test that cannot be made to fail has not been shown to work.** — canon §8

That sentence is the project's governing rule for tests, and until this gate existed
nothing enforced it. This document explains what the gate does, why each of its parts is
there, and the standing rule it imposes on new security work.

---

## 1. Why this exists

An adversarial pass through this repository took eight security guards, mutated **one at a
time**, and re-ran the integration suite. Every one of the eight left the suite **green at
44/44**:

| # | Guard mutated | Result then |
|---|---|---|
| M1 | `decision_revision` tenancy `WITH CHECK` weakened | green — and the forgery was *proved exploitable* |
| M2 | `withUser`'s eager `app.require_user_id()` probe replaced by a local object | green |
| M3 | `assertUnprivilegedOnce()` deleted from `withUser` | green |
| M4 | the `DISCARD ALL` block deleted (canon §7.6 **release blocker**) | green |
| M5 | posture rule 3 OWNERSHIP made unmatchable | green |
| M6 | posture rule 7 NO TRUNCATE made unreachable | green |
| M7 | `queryAffectingOne`'s `rowCount !== 1` assertion disabled | green |
| M8 | posture rules 9 SENTINELS and 10 NOT NULL (then absent entirely) | green |

A guard whose removal leaves the suite green is not protecting anything the suite can see.
Finding that out by hand, once, is a report. Finding it out on every run is a gate.

Note what the table does **not** say. Several of those guards were measured to work
perfectly in production — the eager probe does reject a mismatched context, `DISCARD ALL`
does clear a planted GUC on a reused backend. The defect was never the guard. It was the
absence of a test that could notice the guard disappearing.

---

## 2. What one run does

```
scripts/mutation-check.sh
```

1. **Self-tests the applier.** Nine checks over synthetic mutations, four of which require
   the applier to report a negative. See §6.
2. **Validates the whole registry** before building anything, printing each edit's
   find/replace byte count.
3. **Runs the BASELINE**: an unmutated mirror, which must come back green with at least
   one test. Nothing below is interpretable until it does.
4. **For each mutation**: build a mirror, apply exactly one mutation, build that mirror's
   own template database, run the integration suite, require a non-zero exit **and** that
   every test the mutation names is among the failures, then destroy the mirror.
5. **Reports a verdict table** and exits 0, 1 or 2.

Useful flags:

| Flag | Effect |
|---|---|
| `--list` | print the registry and exit |
| `--only M5,MS1` | baseline plus just those ids |
| `--baseline-only` | prove the mirror mechanism, run no mutation |
| `--keep` | leave the mirrors on disk for inspection |
| `--as-caught` | treat every selected mutation as `expect: caught`; a verification aid, never CI |

Environment: `MUTATION_TEMPLATE_DB` (default `statesman_mut_tpl`) and `MUTATION_DIR`
(default `mutations/`). `MUTATION_DIR` swaps the registry only — the applier and the
reporter parser always come from `mutations/lib/`, because an alternate registry must not
be able to bring its own instrument.

Exit status: **0** gate passed, **1** gate failed, **2** the harness itself is broken (bad
usage, missing tooling, a red baseline, a mutation that would not apply).

Runtime on this machine: roughly 8 seconds per suite run, so the full registry takes a
couple of minutes.

---

## 3. The verdicts

| Verdict | Meaning | Gate |
|---|---|---|
| `CAUGHT` | marked `caught`; suite red; **every** named test failed | pass |
| `ESCAPED` | marked `caught`; suite **green** | **FAIL** |
| `MISATTRIBUTED` | marked `caught`; suite red but a named test did not fail | **FAIL** |
| `NOT-APPLIED` | the mutation did not land (stale or ambiguous target) | **FAIL** |
| `BROKEN-REPORT` | the reporter output could not be parsed | **FAIL** |
| `UNCAUGHT` | marked `uncaught`; suite green — a known, declared gap | pass, listed |
| `PROMOTABLE` | marked `uncaught` but every named test failed — a control has landed | pass, **flip it to `caught`** |
| `UNATTRIBUTED` | marked `uncaught`; suite red on something else | pass with a **warning** |

`uncaught` is what keeps this a ledger rather than a wall. Most guards in this repo had no
control when the gate was written; a gate that refused all work until they did would have
been switched off within a day. An `uncaught` row is a declared, visible debt with a
`todo:` naming the missing test. A `caught` row is a promise the gate enforces.

`UNATTRIBUTED` is a warning and not a failure on purpose: for a mutation that admits it
has no control, an unexpected red says the ledger is out of date, not that the build is
broken. For a `caught` mutation the same situation is `MISATTRIBUTED` and fails hard.

---

## 4. Why each hard requirement is there

Each one is a bug that has already happened in this project.

**A green baseline, first.** Without it a broken harness reports *every* mutation as
caught. A prior version of exactly this kind of script treated any non-zero exit as
"detected" and would have reported success on all six mutations it ran while testing
nothing. Observed: with `TEST_ADMIN_ROLE` pointed at a role that does not exist, the
baseline comes back `exit=1 tests=0` — non-zero while executing nothing, the precise
shape that a status-only harness reads as a catch. The gate exits 2 and applies no
mutation.

**Name the test, and require all of them.** "Something failed" is not evidence that the
right thing failed. `expect-test:` is a list and *every* entry must appear among the
failures: M8 hollows out posture rules 9 and 10 together and has three controls, so
matching any one of them would let the other two rot. M3 names both the
membership-privileged role (V3) and the attribute-privileged one (V1), because a guard
checking attributes alone rejects the second and admits the first. M7 names the
zero-rows *and* the many-rows case, because `if (false)` admits both and a control that
tested only zero would pass against `rowCount < 1`.

**Pass the config explicitly.** `--config vitest.integration.config.ts`, always. Without
it there is no `globalSetup`, so no template is built and the harness role guard never
runs; the suite then collects nothing and exits non-zero, which a status-only harness
reads as "caught".

**Never pipe a command whose status matters.** A pipeline reports the *last* stage, so
`cmd | tail` hides `cmd`'s failure. This has already occurred twice here. In
`mutation-check.sh` the suite runs as `( cd … && vitest … ) > log 2>&1` — a redirection,
not a pipe — so `$?` is vitest's own status. The only pipes in the file parse a string
that was already captured, and each is marked with a comment.

**Assert the mutation applied.** A stale mutation leaves the mirror unmutated, and the
resulting green suite would be reported as "no control" for a guard that was never
touched. `mutations/lib/mutation.mjs` requires the target text to be present *exactly*
`count` times and reads the result back from disk; anything else is `NOT-APPLIED`.

**Clean up on failure too.** An `EXIT` trap drops the mutation template and every
`statesman_test_w%` database that appeared *during* this run — never one that existed
before it, which would belong to somebody else.

### Two deliberate departures from the obvious implementation

**Not unified diffs.** `/usr/bin/patch` here is `patch 2.0-12u11-Apple`, not GNU patch:
lenient about fuzz and unreliable at creating a file from a `/dev/null` hunk. Worse, a
diff carries line numbers, and several agents edit `src/` and `migrations/`
concurrently — a hunk that applies cleanly today applies with fuzz tomorrow and against
the wrong code the day after. Fuzz is exactly the failure this gate exists to prevent. So
a mutation is a set of **literal** find/replace edits with a required occurrence count: no
fuzz, no context matching, no line numbers.

**`package.json` is copied, not symlinked.** Vite — which vitest runs on — resolves its
project root by walking up for a `package.json` and taking its **real** path. A symlinked
`package.json` can therefore make the *real repository* the root, which would silently run
the unmutated suite while the harness reported on a mutated mirror: every mutation would
read as uncaught and the whole report would be worthless. `node_modules` stays a symlink;
it is only resolved through, never rooted from.

---

## 5. Adding a mutation

Create `mutations/<ID>-<slug>.mut`. Ids beginning `MS` run first (they are the harness's
own positive controls); `M<digit>` ids follow.

```
# Free-form comment. Say what the guard protects, which verified fact (V-number) or canon
# clause makes it load-bearing, and — if it was ever exploited — what was proved.
id: M9
title: one line, present tense, naming the edit
expect: caught
expect-test: a substring of the failing test's full name
expect-test: another, if the mutation disables more than one rule
proves: what a CAUGHT verdict here establishes

file: supabase/migrations/20261021140500_verify_security_posture.sql
count: 1
@@FIND
  the exact text to remove, byte for byte
@@REPLACE
  what to put in its place
@@END
```

Rules:

- `expect-test:` is **repeatable and all entries must match.** The substring is matched
  against vitest's `fullName` (describe titles joined to the test title). The literal
  `#abort` means "the run produced no test results at all" — use it only when the expected
  catcher *is* the harness aborting, e.g. the global role guard.
- `count:` defaults to 1 and is the number of occurrences the `FIND` text must have.
  Include enough surrounding text to be unambiguous: `with check (user_id =
  app.require_user_id());` appears twice in `0003`, so M1's `FIND` carries the whole
  `create policy` statement.
- `expect: uncaught` requires a `todo:` naming the test that is missing. `expect: caught`
  must not carry one.
- `negative-control: true` declares the entry a control over **the gate** rather than over
  the code, and waives **only** the catcher-specificity check below. `true` is the only
  accepted value — there is no `false`, omit the header — because a value the parser does
  not recognise must be an error and never a silent `false`. It is refused outright in the
  shipped `mutations/` registry, on every run whatever `MUTATION_DIR` says, so a live
  mutation can never buy its way out of specificity with a header. Only
  `mutations/negative-controls/` may carry it.
- `new-file: <path>` + `@@CONTENT … @@END` creates a file that must not already exist —
  used for a mutation that adds a migration.
- Paths are mirror-relative. `..` is refused.
- The mirror is never type-checked or linted, so a mutation may leave an unused import or
  a type error behind. vitest transpiles with esbuild, which strips types without checking
  them. Do not add dead-code cleanups to a mutation: the smaller the edit, the sharper the
  attribution.

Then **run it** (`--only M9`) and read the verdict. A mutation you have not run is a
claim, not a control.

---

## 6. Proving the gate can fail

The governing rule applies to this harness too, so the gate's own failure paths have been
observed red rather than assumed.

**This table is an execution record, not a standing property of the code.** Every row is
a verdict observed on a date, from the harness as it stood that day. A gate inserted
*upstream* of the stage a row describes invalidates that row silently — the run stops
earlier than the row's subject, so the row is neither confirmed nor contradicted, and
nothing fails. Re-run the two commands below whenever the harness itself is edited, and
re-date the table. Treating it as a property is how it went stale the first time
(§6.1).

**As of 2026-10-23**, on `fix/mutation-negative-controls`:

| Control | Observed |
|---|---|
| applier self-test (`mutations/lib/selftest.mjs`) | **14/14 pass**; with the `readBlock` off-by-one reintroduced, **5 of 9 fail, exit 2**; with check 11's subject broken, **1 fails, exit 2** |
| `mutations/negative-controls/MS7` — comment-only edit claiming `caught` | **ESCAPED**, suite green at 143/143, gate **exit 1** |
| `mutations/negative-controls/MS8` — genuinely red, wrong catcher named | **MISATTRIBUTED**, suite red with 1 failure (posture rule 4's control), gate **exit 1** |
| `mutations/negative-controls/MS9` — `FIND` text that no longer exists | **NOT-APPLIED** (`contains the FIND text 0 time(s)`), gate **exit 1** |
| `mutations/negative-controls/waiver-control/M99` — an undeclared entry carrying MS7's own catcher string | **SPEC FAIL**, gate **exit 2**. Run together with the three declared controls in one scratch registry: **SPEC FAIL for M99 only**, the three **SPEC WAIVED**, gate **exit 2** |
| a `negative-control: true` planted on a live `mutations/` entry | refused by name at `assert-shipped`, gate **exit 2**, before the lock or any database work |
| red baseline (`TEST_ADMIN_ROLE=no_such_bootstrap_role`) | `exit=1 tests=0`, **BASELINE IS NOT GREEN**, gate **exit 2**, no mutation applied |

```
MUTATION_DIR=mutations/negative-controls scripts/mutation-check.sh                # must exit 1
MUTATION_DIR=mutations/negative-controls/waiver-control scripts/mutation-check.sh # must exit 2
TEST_ADMIN_ROLE=no_such_bootstrap_role scripts/mutation-check.sh                  # must exit 2
```

The first proves the gate still emits `ESCAPED`, `MISATTRIBUTED` and `NOT-APPLIED`. The
second proves the waiver is **selective**: `M99` carries MS7's catcher string verbatim and
no `negative-control:` header, so it must still fail specificity. Both halves are needed —
a waiver that exempted every entry would make the first command pass and look identical.
`M99` sits in a subdirectory because `registry()` globs non-recursively: filed beside the
three controls it would be swept into their run and make it exit 2 at the specificity stage
instead of exit 1 with three verdicts.

A default run shows the other end of this: with no declared control in `mutations/`, the
specificity line prints its unwaived form — `CATCHERS SPECIFIC — every expect-test resolves
to exactly one baseline test`, byte-identical to before the waiver existed.

The negative controls live in `mutations/negative-controls/`, which `registry()` does not
glob. They ship so the gate's teeth stay re-provable; they never run in CI, because a
mutation that is deliberately not caught would fail it forever.

### 6.1 Why the controls carry `negative-control: true`

The three controls are built from the one property a registry-validation gate is most
likely to police: a catcher that does not name a live test. MS7's purpose *is* to claim a
control that does not exist, and MS9 expects never to be applied, so requiring it to name
a live test is incoherent by construction.

So when the catcher-specificity check was added — correctly, closing a real false-`CAUGHT`
hole — all three controls failed it, and they failed it *before* the verdict stage. The
command documented above stopped exiting 1 with three verdicts and started exiting 2 with
three `SPEC FAIL` lines and no verdict at all. **The harness's ability to emit any
non-`CAUGHT` verdict had no executable proof**, and nothing announced it: the controls are
deliberately outside CI, so the one population that could detect the regression is the one
population no scheduled run touches. Meanwhile `36 of 36 CAUGHT` kept reading as total
strength.

`negative-control: true` is the declared exemption. It waives **only** catcher
specificity; the entry still applies, still runs, and still has to produce its recorded
verdict. Three properties make it safe:

- **Declared on the entry, not inferred from the directory.** A path can change and an
  exemption that travels with one is invisible to anyone reading the entry.
- **Refused in the shipped registry**, checked on every run whatever `MUTATION_DIR` says.
  A live mutation cannot buy its way out of specificity with a header, which would hand
  the false-`CAUGHT` hole back one entry at a time.
- **Counted and printed when exercised.** A silent exemption and a working check produce
  identical output, so the run states how many entries were waived.

The general rule, for the next gate added here: **a well-formedness check over a set of
test specifications will tend to reject that set's own negative controls**, because being
ill-formed in one specific dimension is what those controls are *for*. Run any new
validation gate against `mutations/negative-controls/` before shipping it.

*Recorded as observation 0486.*

**The applier's self-test earns its place.** `readBlock` originally advanced past a marker
it was already past. The effect was invisible from outside: every single-line `@@REPLACE`
block came out **empty** and every multi-line one lost its **first line**, so mutations
applied a *corrupted* edit. The suite went red for the wrong reason, and the gate's first
full run reported `MISATTRIBUTED` and `UNATTRIBUTED` across the board with no way to say
why. The checks now assert exact bytes for both shapes, and six of the fourteen require
the applier to refuse: an absent `FIND`, an ambiguous `FIND`, an `uncaught` entry with no
`todo:`, a path escaping the mirror, a `negative-control:` value other than `true`, and a
declared control sitting in the shipped registry. The self-test prints a **counted**
total: it read a hardcoded `9/9` while fourteen checks ran, which is the same defect the
harness exists to catch one level up — a summary that cannot disagree with the work it
summarises is not a measurement.

---

## 7. The standing rule

> **A new security guard ships with a mutation proving its control bites.**

Concretely, when you add a check — an RLS predicate, a posture rule, a runtime assertion,
a trigger — you add three things, not one:

1. the guard;
2. a test that fails when the guard is violated;
3. a mutation in `mutations/` that removes the guard, naming that test, and a run showing
   the verdict is `CAUGHT`.

Point 3 is not bureaucracy. Points 1 and 2 were present for all six controlled posture
rules and for the whole tenancy suite, and the adversarial pass still found eight guards
with no control at all — including a `WITH CHECK` whose weakening was *proved exploitable*
and a release blocker named in canon §7.6. A test that exists is not a test that bites.

Corollaries:

- **Never delete a mutation to make the gate pass.** Flip it to `expect: uncaught` with a
  `todo:`, which is visible, or fix the test.
- **A `PROMOTABLE` verdict is a chore, not a pass.** Someone wrote the control; record it
  by flipping the row to `caught` and dropping the `todo:`.
- **A `NOT-APPLIED` verdict is never a flake.** It means the code moved. Re-point the
  mutation at the guard's new text in the same change that moved it.

---

## 8. Where it belongs in CI

Canon §8.7 fixes the order: `tsc` → `eslint` → format → import boundaries → unit →
integration → build → E2E + axe → audit → secret scan → `trace:check`.

The mutation gate goes **immediately after integration**. It is meaningless before
(it runs the integration suite itself, and needs a green baseline) and it costs about as
much as the integration suite times the number of mutations, which is why it belongs in
the slow lane rather than in a pre-commit hook.

Two notes for whoever wires it in — both files are outside this document's scope:

- `scripts/gates.sh` keeps its step list in `STEPS`; adding `mutation` there needs a
  matching `describe`/`run` branch.
- a `"mutation": "bash scripts/mutation-check.sh"` entry in `package.json` would make it
  `npm run mutation`.

---

## 9. Known constraints

- **Do not run two integration suites at once.**
  `tests/integration/support/global-setup.ts` sweeps *every* database matching
  `statesman_test_w%` at startup, including another run's, so two concurrent suites
  destroy each other's worker databases. The gate takes a lock directory so two
  *mutation* runs cannot overlap, and warns when worker databases already exist — but it
  cannot stop a plain `npm run test:integration` in another terminal.
- **The mirror lives in `$TMPDIR`** and is removed unless `--keep` is passed. Mirrors are
  a few megabytes each (`node_modules` is a symlink).
- **The gate needs the bootstrap superuser**, like `scripts/db-template.sh`:
  `statesman_owner`, `statesman_migrator` and `statesman_app` all have
  `rolcreatedb = false`, so `CREATE DATABASE … TEMPLATE` runs as the macOS login role via
  `pg_hba trust`. Override with `TEST_ADMIN_ROLE`.
- **`LC_ALL` is exported** by the script (V27) — the postmaster aborts without it on this
  macOS build.
- **`mutations/lib/*.mjs` carry a `/* global process */` banner.** `eslint.config.mjs`
  applies only `eslint.configs.recommended` to `**/*.mjs` and declares no Node globals, so
  `process` would otherwise trip `no-undef` and break `npm run lint` for the whole repo.
  Declaring it locally keeps the fix inside `mutations/` rather than editing a shared
  config these files do not own; adding Node globals to that config would be the tidier
  fix if someone owns it.
