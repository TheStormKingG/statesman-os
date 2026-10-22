# STATESMAN OS

A private practice system for public leadership decisions.

You are given a sourced governance scenario, you write a decision and the reasoning behind
it, that reasoning is challenged from five professional viewpoints, you reflect on what the
challenge exposed, and you commit to a corrective action. The record is permanent and
auditable.

Its job is to build the habit of making a hard decision, recording the reasoning, receiving
challenge, and improving on evidence. Not to make anyone look prepared.

**It is not** a campaign tool, an election predictor, a governance certification, or an AI
adviser for live emergencies. There is no readiness score, and there never will be: the
product refuses to reduce a person to one number.

## Status: mid-build, no usable interface yet

Honest state as of the latest commit:

| | |
|---|---|
| Database schema, RLS, lifecycle functions | done, tested |
| Typed data-access boundary | done, tested |
| Scenario content, source register, claim whitelist | done, tested |
| Runnable shell (`npm run dev`) | a status page and a health endpoint, nothing more |
| The five screens | **not started** |
| Challenge Review (the AI layer) | **not started** |
| Deployment | target chosen and verified, not yet ported |

There is no sign-in and no product screen. `npm run dev` serves one page that says exactly
that. The first real screen arrives with the decision-workflow slice.

## Gates

```
npm run gates
```

Runs, in order, failing the build if any step fails: `typecheck`, `lint`, import-boundary
check and its own self-test, unit tests, integration tests, and the mutation gate.

The mutation gate is the unusual one and it is the point. An adversarial pass found eight
security guards whose removal left the test suite entirely green — including one that
turned out to be exploitable. The guards worked; nothing could tell if they stopped. So
`scripts/mutation-check.sh` now removes each guard in turn and fails the build unless the
suite goes red *and the specific test that claims to cover it* is the one that fails.
A new security guard ships with a mutation proving its control bites.

Current: 36 unit tests, 88 integration tests, 19 mutations, all caught.

## Running it locally

Needs PostgreSQL 17. See `.env.example`, and `docs/` for the rest.

```bash
npm install
npm run db:bootstrap    # cluster roles, once, as a superuser
npm run db:migrate      # applies migrations/0*.sql then the posture check
npm run dev
```

Two measured gotchas on macOS: Postgres installed by Homebrew is not brew-managed by
default, so after a reboot it needs `brew services start postgresql@17`; and the postmaster
aborts unless `LC_ALL` is set to a valid locale.

## Documentation

- `docs/PRD.md` — the authoritative product requirements
- `docs/superpowers/specs/` — the design canon, including a register of facts established
  by running commands rather than by reasoning about them
- `docs/adr/` — architecture decisions, with the alternatives and why they were rejected
- `docs/threat-model.md`, `docs/requirements-traceability.md`
- `docs/mutation-testing.md` — how the mutation gate works and how to add to it
- `docs/ui-ux-design.md`, `PRODUCT.md`, `DESIGN.md` — the interface design

## Licence and scope

Not licensed for reuse. Built for a single user; the scenario content is fictional
throughout and labelled as such.
