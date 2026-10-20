# ADR-0010: Two-artefact traceability

**Status:** Accepted | **Date:** 2026-10-20

## Context

`MASTER_PROMPT.md` §3 item 2 requires `docs/requirements-traceability.md` covering FR-01–FR-19
and NFR-01–NFR-10 with priority, screen/service, DB entities, verification method, status and
actual evidence. §9 adds the honesty rule: "An unexecuted test is `NOT RUN`, not `PASSED`."

Those two pull against each other in one file. A document recording per-run results must be
regenerated to stay true, and a generated document in version control needs a `--check` mode so
CI can prove it is current. **Embedding a generation timestamp in a committed file makes
`--check` unpassable by construction**: every run produces a different file, so the check fails
when nothing changed, and the usual repair is to stop running it. A committed `PASS` also outlives
the run that earned it — the file keeps asserting a result nobody re-executed.

## Decision

Split the concern into two artefacts.

| Artefact | Committed? | Contents |
|---|---|---|
| `docs/requirements-traceability.md` | Yes, deterministic | Requirement rows, priority, PRD ref, acceptance condition, verification method, implementation paths, covering test identities, and a **design status** from the closed vocabulary `{PLANNED, DEFERRED}`. **No timestamps. No run outcome.** |
| `reports/trace.json` + `reports/traceability-run.md` | No, gitignored | Per-requirement run outcome per suite, commit sha. Volatile. |

**Design status is in; run status is out** (canon §8.6). `PLANNED` and `DEFERRED` are properties
of scope: they are stable between runs, and master prompt §3 item 2 requires a status column.
`PASS`, `FAIL` and `NOT RUN` are outcomes of an execution and are not representable in the
committed file at all. The dividing line is a determinism test — *would this value change if the
same commit were checked twice without editing anything?* If yes, it belongs in the volatile
report.

`npm run trace:check` diffs only the deterministic file.

Coverage is matched by **structural tags** emitted by custom Vitest and Playwright reporters into
`reports/tags-*.json` — never by parsing concatenated test titles, which is silently empty for
every `it.each` test. Requirement ids come from a single `requirements.yaml`, and the count in the
document is generated from it.

In the volatile report a requirement is `PASS` only if a tagged test exists, ran, and passed.
**Unexecuted is `NOT RUN`, never `PASSED`.** `gates:selftest` fixtures assert deep equality against an expected
per-requirement object, not an exit code.

## Alternatives considered

| Option | Why rejected |
|---|---|
| One committed document carrying run statuses and a generation timestamp | `--check` becomes unpassable by construction, and a committed `PASS` asserts a result from a run that may be months stale. |
| One committed document carrying run statuses but no timestamp | The outcomes then drift from reality with no mechanism that can detect it — worse than the timestamp version, because it looks current. A design status does not have this defect: it only changes when scope changes, which is an edit. |
| Volatile report only, nothing committed | The FR/NFR map `MASTER_PROMPT.md` §3 requires disappears from the repository, and a reviewer has nothing to read without running the suite. |
| Match coverage by parsing test titles for requirement ids | Silently empty for every `it.each` test — a gate that reports full coverage of nothing. Structural tags from custom reporters instead. |
| Maintain requirement ids by hand in the document | Drifts from the suite and from the PRD. Single `requirements.yaml`; the document's count is generated. |
| Assert the checker's exit code in `gates:selftest` | Five fixtures asserting only `code === 2` let a checker that returns 0/2 pass seven of ten (ADR-0009). |
| Write run results into a handoff file for CI workers | Canon §8.7: no credentials are ever written to a handoff file; workers read connection bases from their own environment, and `reports/` is gitignored. |

## Consequences

**Positive.** The committed artefact is reviewable, diffable and mechanically checkable. The
volatile one can be as detailed and as timestamped as it likes, because nothing depends on
reproducing it. No file in version control claims a test result.

**Negative.** Two custom reporters to write and test, plus a generator, a `requirements.yaml` and
a `--check` mode — all themselves instruments, so all needing the liveness tests of ADR-0009. A
reader of the repository alone sees coverage *intent*, never results, and must run the suite to
learn outcomes. That is the honest state of the information.

**What this now requires.** `requirements.yaml` carrying FR-01–FR-19 and NFR-01–NFR-10 exactly as
the PRD numbers them; the generator and byte-identical `--check`; the two reporters; `reports/`
in `.gitignore`; and the secret scan running **before and after** the test gates so generated
artefacts are covered (canon §8.7).

**Current status.** No suite has executed and no run report has been produced, so every
requirement's run outcome is `NOT RUN` wherever one is recorded. A requirement carrying a
`manual` verification leg reaches at most `NOT RUN` until its named evidence record exists and
is referenced (canon §12.3); no sign-off name or date is to be invented for a review that has
not happened.

## Evidence

- Canon §8.6 — the two artefacts, the timestamp reasoning, structural tags, `requirements.yaml`, and `NOT RUN` over `PASSED`.
- Canon §8.7 — CI order, `reports/` gitignored, no credentials in handoff files.
- `MASTER_PROMPT.md` §3 item 2 and §9 — the traceability deliverable and the unexecuted-test rule.
- PRD §6 — FR-01–FR-19; PRD §11 — NFR-01–NFR-10.
- No V-fact bears on this decision; it follows from the `--check` contradiction and the reporter behaviour recorded in canon §8.6.
