# Reserved ADR numbers

Canon §12 makes `docs/adr/README.md` the owner of ADR numbering, and sets this rule:

> A reference to an ADR that does not yet exist must appear in a committed reserved-numbers
> list, or the `docs:check` gate cannot pass before the ADR is written.

This is that list. It exists so a forward reference can be legal: a document may cite a decision
that has not been written, provided the number is reserved here with a line saying what will fill
it. A reserved number is **not** a decision, and nothing may cite one as though the reasoning
had already been recorded.

## Reserved and not yet written

| ADR | What will fill it | Referenced from |
|---|---|---|
| **0014** | The pinned toolchain: every dependency at an exact version, with the resolved versions **read back from `package-lock.json`** rather than stated from memory (canon O3, O4), plus the Node and npm lines the install was performed with. | `implementation-plan.md` §0.1 and its gate table, which currently cite this record as `ADR-0013-pinned-toolchain.md` — see the collision note below. |

## Abandoned reservations — never reused

A reservation is abandoned when the design it was held for is settled by deciding NOT to build
the thing. The number is **not** returned to the pool: this file's rule is that a number, once
issued, is never reused, so a stale citation lands on nothing rather than on an unrelated
decision.

| ADR | Held for | Outcome |
|---|---|---|
| **0015** | CSRF origin verification: the mechanism, and why `SameSite=Lax` is not the control (canon §12.1 item 1). | **Abandoned.** The reservation was itself broken — `ADR-0015` is the static-export decision (see the second collision below) — and the design it was held for was retired rather than chosen: ADR-0015 removed the server request boundary origin verification is defined against. Recorded in [ADR-0019](ADR-0019-retire-csrf-origin-verification.md), with the residuals that survive. |

## Numbering collision to resolve

`implementation-plan.md` names the toolchain record `docs/adr/ADR-0013-pinned-toolchain.md`, but
**0013 is taken** by the transition-guard decision
(`ADR-0013-transition-guard-derives-prospective-state.md`), which records the V28/V29 correction
to canon §4.4. Under canon §12 this directory owns the numbering, so the toolchain record is
**0014** and the plan's two references are the ones that change. Until they do, a check that every
ADR number referenced in `docs/` resolves to a file will pass on the number and land a reader on
the wrong decision, which is worse than a missing file — so this is a correction to make in
`implementation-plan.md`, not something to absorb by renumbering here.

**A second collision, of the same shape.** This file reserved **0015** for the CSRF mechanism while `ADR-0015-static-github-pages-plus-supabase.md` already occupied that number. The two are not merely different decisions: the occupant is the decision that made the reservation's subject inapplicable. It is recorded above as abandoned and the replacement took **0019**. The pattern in both collisions is the same — a number cited from another document before this file was consulted — which is the thing a `docs:check` over ADR references would have caught at the point of writing.

## Designs required by canon §12.1 that have no number yet

Three of the four controls canon §12.1 moves into Slice 6 are required but do not yet have an ADR
reserved, because whether each is recorded as an ADR or settled inside the implementation plan is
not yet decided:

- **Log and telemetry redaction** — the field classification, and the test that a full loop leaks
  no journal field value, token or connection string into any captured log or telemetry payload.
- **Stored-XSS rendering and CSP** — the single escaping component every journal field and model
  output renders through, the policy itself, and the recorded residual that `freeText` rejects
  URIs and control characters but **not** HTML metacharacters, which makes escaping at render
  load-bearing rather than defence in depth.
- **NFR-10 source integrity** — the `source.status` column (`active | withdrawn | unreachable`),
  the `scenario_version` archival flag, and the CI assertion that a seeded withdrawn source is
  reported.

If any of these is written up as an ADR, it takes the next free number, is added to this list the
moment the first document cites it, and moves to the README index when written.

Decisions required by canon §12.2 — the NFR-06 deferral, the NFR-07 disposition, the coverage
threshold and the dependency-audit threshold — belong in `docs/decisions.md`, not here. They are
scope and configuration choices, not architecture decisions, and canon §12.2 names that file.

## Rules

- A number appears here only while it is **referenced and unwritten**. When the ADR is written it
  moves to the README index and its row is deleted from this file in the same change.
- Numbers are **never reused**, including numbers reserved here and later abandoned. Record an
  abandoned reservation as abandoned rather than freeing it.
- A reservation carries no status, no approval and no reasoning. There is nothing to cite yet.
