# PRODUCT.md

Context for design work. Derived from `docs/PRD.md` (SOS-PRD-001 v1.0) and
`docs/MASTER_PROMPT.md`. Not invented: every claim below traces to one of those two
documents or to the approved design canon.

**register: product**

Design serves the product. This is a working instrument, not a marketing surface. There is
no landing page in P0 and no acquisition funnel.

## Product purpose

A private decision-training workspace. The user is given a sourced governance scenario,
writes a decision and the reasoning behind it, has that reasoning challenged from five
professional viewpoints, reflects on what the challenge exposed, and commits to a
corrective action. The record is permanent and auditable.

The product's job is to build the habit of making a hard decision, recording the reasoning,
receiving challenge, and improving on evidence. Not to make the user look prepared.

## Users

**Primary (P0):** one motivated adult preparing for complex public, nonprofit or
institutional leadership. Initially a single-user private pilot. Guyana-first scenario
content, extensible internationally.

**Later (not P0):** an invited reviewer or mentor with scoped access to selected records;
a scenario editor who never sees the journal.

## The usage scene

A weekday morning before work. A 13-inch laptop on a desk in a bright room in Georgetown.
Fifteen minutes. The user is writing a defence of a decision they know will be challenged,
and later re-reading what they wrote months ago to see whether they were calibrated.

This scene forces two things. It is a **daylight reading and writing surface**, so light is
the primary theme and dark is the equal alternate, not the default. And the authored prose
is the content, so the interface is closer to a document than to a dashboard.

## Voice and tone

Plain, exact, unhurried. The interface never congratulates, never gamifies, never urges.
It distinguishes what is known from what is assumed, and says when it does not know.

Labels are nouns and verbs, not slogans. Error messages state the cause and the recovery.
Feedback is described as provisional and AI-generated wherever it is.

## Anti-references

What this must not resemble, taken verbatim from the master prompt §5 and PRD §9.4:

- a political campaign site
- a game, with points, levels, badges or streaks
- a motivational dashboard
- a generic SaaS analytics page
- an AI oracle that pronounces on competence

## Hard prohibitions (these are product constraints, not style preferences)

- **No composite score.** No readiness score, character score or viability index. Nothing
  that reduces a person to one number.
- **No evaluative colour.** Green-for-good and red-for-bad would reconstruct a score out of
  the palette. Colour marks interaction and category, never quality.
- **No urgency mechanics.** No countdown, no scarcity, no streak pressure, no nudge to
  return. PRD §4.2 says the cadence is a recommendation and the experience must avoid
  punitive streaks.
- **No AI-awarded competence.** The model may never assign maturity level 3 or 4.
- **No fabricated authority.** No invented citations, statutes or institutional positions,
  and no impersonation of real officials.
- **No simulated outcome shown as a forecast.**
- **No public exposure of journal content.**

## Strategic design principles

1. **The epistemic distinction is the design problem.** The product's whole value rests on
   the user being able to see, at a glance, the difference between a sourced fact, an
   inference, a hypothetical and a value judgement, and between confident and uncertain.
   That distinction must survive greyscale, a screen reader and a 320px screen.
2. **Permanence must be legible.** A submitted decision is immutable. The interface has to
   make the moment of submission feel consequential and make a later revision visibly a
   revision rather than an edit.
3. **Challenge must read as challenge, not as correction.** The five lenses are testing
   reasoning, not grading it. The user can dispute, and the dispute is kept.
4. **Absence of evidence is a first-class state.** "Evidence insufficient" and "Not yet
   observable" are designed states, not empty states.
5. **The writing surface deserves the most care.** Most of the user's time is spent typing
   prose into structured fields. That is the product.

## Platform

Mobile-responsive private web application. Responsive from 320px upward, WCAG 2.2 AA
target, full keyboard operation, visible focus. Desktop and mobile web only. Not a native
app, not an installed desktop app.
