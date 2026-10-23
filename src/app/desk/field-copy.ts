/**
 * The label and the persistent helper text for each of the fourteen fields.
 *
 * ── WHY THIS IS A SEPARATE MODULE ───────────────────────────────────────────
 *
 * DESIGN.md §9: "Label above every input. Placeholder is never the label.
 * Helper text PERSISTS in the markup rather than appearing only on error." So
 * every field needs two strings that are part of the product, not decoration —
 * the helper text is where the form teaches what a defensible answer contains,
 * which is the whole pedagogy of the Desk.
 *
 * Kept out of the component so that
 * `tests/unit/validation/decision.test.ts` can assert that the fourteen fields
 * and the fourteen copy entries agree by deep equality. A field with no entry
 * would otherwise render as a nameless box, and a leftover entry would be copy
 * for a field that no longer exists.
 *
 * `rows` is the MINIMUM height: `docs/ui-ux-design.md` §6.4 asks for four lines
 * for rationale and two elsewhere. The CSS also sets `field-sizing: content` so
 * the box grows; `rows` is the floor and the fallback where that is unsupported.
 *
 * No copy here says "great", "almost there" or "on track", and none implies a
 * grade. The product does not evaluate prose at this point and must not look as
 * though it does.
 */

import type { DecisionFieldName } from '../../lib/validation/decision'

export interface FieldCopy {
  readonly label: string
  readonly help: string
  readonly rows: number
}

export const FIELD_COPY: Record<DecisionFieldName, FieldCopy> = {
  objective: {
    label: 'Objective for the window',
    help: 'What this decision is trying to achieve inside the time the case gives you, and what you are deliberately not attempting.',
    rows: 3,
  },
  assumptions: {
    label: 'Assumptions you are treating as true',
    help: 'Things you cannot verify in time but have decided to act on. Name them so they can be challenged, and say what would change if one were wrong.',
    rows: 3,
  },
  unknowns: {
    label: 'Unknowns and missing data',
    help: 'What you do not know, and which of those gaps you would close first. Different from an assumption: an unknown is something you have not decided to treat either way.',
    rows: 3,
  },
  alternatives: {
    label: 'Alternatives considered',
    help: 'The options you weighed and rejected, with the reason each was rejected. An option list with no rejections is a decision that considered one thing.',
    rows: 4,
  },
  recommended_action: {
    label: 'Recommended action',
    help: 'What you are deciding to do, specifically enough that someone else could begin it: who does what, in what order.',
    rows: 4,
  },
  rationale: {
    label: 'Rationale',
    help: 'Why this option rather than the others, on the evidence the case actually provides. This is the field a later revision is compared against.',
    rows: 5,
  },
  lawful_authority: {
    label: 'Lawful authority to verify',
    help: 'Which authority would permit what you propose, who must confirm it, and by when. If the case does not settle it, say that it must be verified rather than assuming it.',
    rows: 3,
  },
  resources: {
    label: 'Resources and budget',
    help: 'What you are allocating and what each allocation takes away from. The case gives you nothing spare, so every allocation displaces something named.',
    rows: 3,
  },
  stakeholders: {
    label: 'Affected stakeholders and equity',
    help: 'Who is affected, who bears the cost of this choice, and what protects those with the least access.',
    rows: 3,
  },
  risks: {
    label: 'Risks',
    help: 'What could go wrong as a result of this decision, including effects that make the situation harder to read afterwards.',
    rows: 3,
  },
  confidence: {
    label: 'Confidence',
    help: 'A whole number from 0 to 100. Your own judgement of how likely it is that this decision holds up. It is recorded for calibration against what happens, and it is never scored.',
    rows: 1,
  },
  expected_outcomes: {
    label: 'Expected outcomes',
    help: 'What you expect to be true if this works. Stated so that it could later turn out to be wrong.',
    rows: 3,
  },
  indicators: {
    label: 'Indicators',
    help: 'How you would know, and from which source. An outcome with no indicator cannot be checked.',
    rows: 3,
  },
  time_horizon: {
    label: 'Time horizon',
    help: 'By when you expect those outcomes to be observable. Required separately from the outcome so a forecast carries a timeframe.',
    rows: 2,
  },
}
