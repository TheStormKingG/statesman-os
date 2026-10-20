# STATESMAN OS — UI/UX Design Specification

**Document ID:** SOS-UX-001
**Date:** 2026-10-20
**Status:** Design specification. No interface code exists.
**Derived from:** `docs/PRD.md` §5 and §7, `docs/MASTER_PROMPT.md` §5, `PRODUCT.md`, `DESIGN.md`
**Canon:** `docs/superpowers/specs/2026-10-20-statesman-os-p0-mvp-design.md`

Nothing in this document has been implemented, rendered or tested in a browser. Every
geometric and contrast claim is either computed (and marked as such) or flagged as
requiring measurement once a page exists.

---

## 1. The design read

Reading this as: **a private professional instrument for a single practitioner**, in the
product register, with a documentary and record-keeping language, leaning toward a
restrained tinted-neutral system with one non-evaluative accent and type chosen for
sustained reading rather than for expression.

Three dials, set from the brief rather than from a default:

| Dial | Value | Reason |
|---|---|---|
| Structural variance | **3 / 10** | A record instrument wants predictability. Asymmetry would make a permanent legal-style record feel casual, and the user returns to the same layout daily. |
| Motion intensity | **2 / 10** | The highest-frequency interactions are keyboard-initiated and seen dozens of times a day. Motion here is a tax, not a delight. |
| Visual density | **6 / 10** | Fourteen structured fields and a long evidence trail. Dense enough to see an argument whole, loose enough to write in. |

These are deliberately low where the common presets would be high. A landing-page preset
of 7 / 6 / 4 would be wrong on all three counts.

---

## 2. Which guidance applied, and which did not

Being honest about this matters, because applying a landing-page rule to a dense form
produces exactly the generic output the rules exist to prevent.

| Source | Applied | Not applied, and why |
|---|---|---|
| Craft and anti-slop rules | Absolute bans (side-stripe borders, gradient text, glassmorphism, identical card grids, modal-as-first-thought), the em dash ban in all interface copy, the two-altitude category-reflex check, OKLCH with tinted neutrals, the colour-strategy commitment axis | Its own scope statement excludes dashboards, data tables and multi-step product UI. The hero, eyebrow, marquee, logo-wall, bento, scroll-hijack and landing-structure rules have no referent here: there is no marketing surface in P0. |
| Design-engineering craft | The whole animation decision framework (frequency first, then purpose, then easing, then duration), custom ease-out curves, no `ease-in` on UI, no `transition: all`, never enter from `scale(0)`, origin-aware popovers with dialogs exempt, press feedback at `scale(0.97)`, CSS transitions over keyframes for re-triggerable state, exit faster than enter, tabular-figure discipline | Drag, swipe, momentum dismissal and gesture physics: there are no drag interactions in P0. |
| UI/UX rule database | Accessibility (priority 1), touch and interaction (2), layout and responsive (5), typography and colour (6), forms and feedback (8), its data-table accessibility rules | Its `--design-system` recommendation was **rejected on product grounds**, see §3. Its navigation rules and pre-delivery checklist are scoped to iOS/Android/React Native by its own notice; this is responsive web, so bottom-nav limits, safe-area insets, haptics and Dynamic Type do not apply. Charts: only one surface uses any, and the recommendation there is to use none, see §7.4. |

---

## 3. The recommendation that was rejected

The design-system query returned, for a civic decision-training tool:

- **Pattern: "Webinar Registration"** with "limited seats logic", a "live indicator", a
  countdown timer, and a conversion CTA in the hero plus a repeated form at the bottom.
- **Colour strategy:** "Urgency: Red/Orange. Professional: Blue/Navy."
- **Palette:** navy `#1E3A5F` primary with `#059669` green accent, noted as "paid green".
- **Typography:** EB Garamond with Lato.

All four were rejected, and not on taste:

1. A registration-conversion pattern has no referent. There is no funnel, no acquisition
   and no landing page in P0.
2. Urgency mechanics are **prohibited** by PRD §9.4, which forbids persuasion and
   manipulative recommendation, and by §4.2, which requires the cadence to avoid punitive
   streaks. A countdown would be a product violation.
3. Green-for-paid and red-for-urgency would reconstruct an evaluative colour axis. PRD
   §6.2 FR-10 forbids a single readiness score, and a good/bad palette is that score in
   another medium.
4. Navy with a formal serif is the first-order category reflex for anything civic.

The engine matched on surface keywords because its pattern corpus has no entry for a
private practice instrument. The lesson recorded here: a recommendation engine's top match
is an input, not an instruction, and a product prohibition outranks it.

---

## 4. Information architecture

Five screens, flat. No nested navigation, no drawer, no tabs at the top level.

```
/                     Today
/desk/[decisionId]    Decision Desk      (draft, then read-only once submitted)
/review/[decisionId]  Challenge Review
/reflect/[decisionId] Reflection and Development
/history              History
/history/[decisionId] Evidence Trail     (one record, whole)
/account              Export, deletion, retention notice
```

Navigation is a persistent left rail at 1024px and up, and a top bar with a single menu
below that. Five destinations, each with icon and text label, current location marked by
both weight and a 2px `--accent` indicator, never by colour alone.

Every screen is reachable by URL. Back restores scroll position and filter state.

### The lifecycle is the navigation

The six states of a decision (`draft`, `submitted_locked`, `challenged`, `reflected`,
`action_recorded`, `reviewed_closed`) are not a wizard. They are the actual state of a
record, so the interface shows **where this record is** and lets the user move only where
the state machine permits. An illegal move is not offered, and if attempted it fails with
a message naming the current state, because the server raises a distinguishable code
rather than silently affecting zero rows.

---

## 5. Screen A — Today

**Job:** present one decision and the open actions. Nothing else.

Layout at 1024px and up: a single column capped at 70ch, left-aligned, not centred. One
`--surface` panel for today's decision, then a plain list of open development actions
separated by `--divider` hairlines, no cards.

Today's decision panel contains, in this order:

1. Sector and jurisdiction, mono `xs`.
2. **The fiction and date stamp.** `FICTIONAL TRAINING CASE` plus `As of 14 March 2026`,
   always visible, never behind a disclosure. This is FR-02 and it is not decoration.
3. Scenario title at `2xl`.
4. The decision task in one sentence at `lg`.
5. Three facts as a plain definition list: time window, estimated effort, assumed role.
6. One primary action: **Start decision**.

Below: `Open actions` as a flat list, each with description, due date in mono, and status
as a word. An overdue action is marked by the word `Overdue` and a `--danger` text colour,
never by colour alone.

**Explicitly absent:** any score, any streak, any completion ring, any "you are on track"
message, any counter of days practised, any chart. PRD §5.1 says the secondary content is
open actions and recent factual feedback, "not a large readiness score".

**Empty state**, first run: the panel explains that one case is seeded and labelled
fictional, and offers **Start decision**. The empty actions list reads `No open actions`,
not an illustration.

---

## 6. Screen B — Decision Desk

The most important surface. Most of the user's time is here, typing prose into fourteen
structured fields.

### 6.1 Not a wizard

A multi-step wizard is the reflexive answer to fourteen fields and it is wrong here. The
user is constructing a single argument that has to hold together, and PRD §5.2 requires
the response to be defensible as a whole. A wizard hides the whole, makes the earlier
reasoning unreadable while writing the later reasoning, and turns "reopen a draft without
loss" into a question about which step you were on.

So: **one scrollable page, four labelled groups, one autosaving draft.**

| Group | Fields |
|---|---|
| The problem | Objective; assumptions; unknowns and missing data |
| The options | Alternatives considered; recommended action; rationale |
| The authority and the means | Lawful authority to verify; resources and budget; affected stakeholders and equity |
| The exposure | Risks; confidence; expected outcomes; indicators; time horizon |

A sticky completeness summary rides at the top on scroll: four group names, each showing
filled count over total, in mono. It is a position indicator, not a progress bar, and it
never gamifies. Clicking a group name scrolls to it.

### 6.2 The case brief sits above the form, not beside it

At 1024px and up the brief is a two-column reading area above the form, not a sidebar: a
sidebar at this density produces a cramped 40ch form, and the brief is read once then
referred back to. The source register and stakeholder positions are `<details>` disclosures,
closed by default, each source showing title, publisher, publication date and retrieved
date. Every factual assertion in the brief is either linked to a source or carries the
scenario-fiction marker.

### 6.3 Confidence

Confidence is `0 to 100`. **Not a slider.** A slider is imprecise, awkward by keyboard,
hard at 44px on a phone, and it anchors the user to wherever the handle starts.

A number input in mono with tabular figures, stepping by 5, with the value also written as
a word band (`Low`, `Moderate`, `High`) beside it so the number is not the only channel.
No colour scale behind it, and no fill bar. A red-to-green confidence track would be an
evaluative gradient, which is the thing the product refuses.

### 6.4 Writing fields

Prose fields are `lg` with a 70ch measure and auto-growing height, minimum four lines for
rationale and two elsewhere. Label above, persistent helper text below stating what a good
answer contains, character guidance where PRD acceptance conditions imply a bound. No
placeholder ever carries the label.

Validation on blur, never per keystroke. Error below the field with `role="alert"`.

### 6.5 Autosave and the lock

Draft state saves on blur and on a 10 second idle timer. The indicator is a single mono
line: `Draft saved 14:21`. It does not animate, because it appears constantly. On failure
it reads `Not saved. Retrying.` and then `Not saved. Your text is still here.` It never
claims a save it did not get.

**Submission is the one consequential moment in the product**, so it gets the one dialog:

> **Submit this decision**
>
> Submitting saves a permanent, timestamped version of this response. You cannot edit it
> afterwards. You can add a later revision, and both versions stay visible.
>
> Objective, alternatives, recommended action, rationale, authority, resources,
> stakeholders, risks, assumptions, unknowns, confidence, outcomes, indicators and horizon
> are all recorded.
>
> `Submit decision`   `Keep editing`

It states what becomes immutable and what remains possible. It is centred, 240ms, centred
transform origin. If any required field is empty the dialog does not open; focus moves to
the first invalid field instead.

### 6.6 After submission

The same route renders read-only. Fields become `--subtle` panels with their values, a
`SUBMITTED 20 Oct 2026 14:23` mono stamp, and a single action: **Open challenge review**.
Read-only is visually and semantically distinct from disabled.

### 6.7 320px

Groups stack. The brief collapses to a single `<details>` above the form, open by default
on first view of a scenario and closed thereafter. The sticky summary becomes a single line
showing the current group. Inputs are 44px minimum height. No horizontal scroll.

---

## 7. Screen C — Challenge Review

### 7.1 Not five cards in a grid

Five equal cards in a row is a banned pattern and it is also wrong on the merits: it
implies the five lenses are parallel and equally weighted, invites scanning rather than
reading, and collapses badly at 320px.

Instead: **a single column, one challenge at a time, each anchored to the passage it
targets.**

### 7.2 Anchoring is the central design move

A challenge that floats free of the text it challenges is just an opinion. So each
challenge renders as:

1. The user's own quoted passage, in their own words, set in `--subtle` with a hairline,
   labelled `Your words`.
2. The lens as a mono uppercase label: `LEGAL AUTHORITY`, `PUBLIC FINANCE`,
   `ETHICS AND EQUITY`, `EXECUTION`, `COMMUNITY IMPACT`.
3. The challenge question at `lg`.
4. The basis and uncertainty, by the §7 encoding in `DESIGN.md`: a spelled-out mono label,
   a glyph, and for uncertainty a three-segment indicator plus the word.
5. Evidence references, each resolving to a source in the case register. A challenge whose
   references do not resolve is not shown, because the server rejects it.
6. A response area with three explicit dispositions: `Accept`, `Dispute`, `Flag as
   incorrect`. Disputing opens a text field. The disposition and the text are both kept, and
   a flagged challenge is surfaced as its own state rather than counted as addressed.

A lens progress line sits at the top: five lens names, the current one marked. Moving
between lenses is keyboard-driven and therefore **not animated at all**.

### 7.3 The honest unavailable state

NFR-08. When the model call fails or no provider is configured:

> **Challenges unavailable**
>
> Your decision is saved and locked. No challenges were generated.
>
> `Retry`

The review is not marked complete, the draft is untouched, the locked revision is
unchanged. Nothing canned is ever shown as a live response.

When the fixture adapter is serving, a persistent banner reads
`Example challenges. Not generated by a model.` This is a product requirement, not a
courtesy.

Abstention is a real answer: where the model cannot ground a challenge, the card shows
`Evidence insufficient` with the reason, and that is a successful outcome rather than an
error.

### 7.4 No charts here, or anywhere in P0

The five dimensions tempt a radar chart. **A radar chart is prohibited by the product.**
Its enclosed area reads as a single composite magnitude, so it computes visually exactly
the readiness score that FR-10 forbids, even though no such number is stored. A stacked bar
across dimensions has the same defect.

The five dimensions are therefore five separate rows with no total, no shared axis that
invites summing, and no shape whose area means anything.

---

## 8. Screen D — Reflection and Development

Five rows, one per dimension: Knowledge, Judgment, Execution, Ethics, Learning. Each row
carries:

- The dimension name.
- Observed level as a word plus its number: `2 Applied in exercises`. The AI can never
  write 3 or 4; the database refuses it. Where a level is unassessed the row reads
  `0 Unassessed`.
- Evidence quality as a word: `High`, `Medium`, `Low`, `Insufficient`.
- Assessor provenance, stated plainly: `AI formative analysis` or `Human reviewer`, with
  the date. PRD §7.2 requires the assessor and review date to be shown.
- Observations, each quoting the passage it rests on.
- Limitations, always present, never collapsed away.

**No total row. No average. No chart. No progress toward a next level.**

A standing notice sits above the rows: `AI-generated formative analysis. Not a validated
assessment of competence.` It is not dismissible.

Below, the user selects one or two corrective actions. Each action takes a description,
owner, due date, and later completion evidence, and keeps a link back to the challenge or
observation that produced it. The action form is inline, not a modal.

A `Repeat a comparable case` control creates a new decision linked to this one as a
reassessment. Both attempts stay visible, side by side, with no winner declared.

---

## 9. Screen E — History and Evidence Trail

### 9.1 List

At 768px and up: a table. Columns are date, scenario, sector, state, confidence, review
status. Numerics in mono with tabular figures so columns do not shift. Sorting is real,
with `aria-sort` reflecting the current state. Rules between rows use `--divider`, with no
border on both top and bottom of every row.

Below 768px a table is the wrong component. It becomes a list of records, each a plain
block with the scenario name, the date and state in mono, and the confidence. No horizontal
scroll, no pinned first column.

Filters: sector, state, date range. Filter state survives back navigation.

### 9.2 The evidence trail

One record, reconstructed whole, in chronological order: the exact scenario version with
its sources, the original locked response, every later revision with the stated reason for
the change, every challenge with its prompt and model version and generation timestamp,
the user's responses and disputes, the reflection, the actions and their completion
evidence, and any later verified development.

Each hop shows the identifiers it is pinned to. A submitted decision continues to resolve
the scenario version it was written against even after a newer version is published.

Export is a real file. Deletion is a separate, confirmed, destructive action, visually and
spatially separated from everything else, with the retention notice stating plainly what
happens to backups. No immediate-erasure promise.

---

## 10. Keyboard

Full operation without a pointer is a P0 requirement, and the frequent paths are keyboard
paths, which is why they carry no animation.

| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Move by one control, in visual order |
| `Cmd/Ctrl+S` | Save draft, no animation |
| `Cmd/Ctrl+Enter` | Open the submit dialog from the Desk |
| `Esc` | Close dialog or disclosure, return focus to the trigger |
| `J` / `K` | Next and previous challenge in review |
| `1`–`5` | Jump to lens, when not in a text field |
| `G` then `T/D/R/H` | Go to Today, Desk, Review, History |

A skip link precedes the navigation. After a route change focus moves to the main region.
Heading levels never skip. Focus is never trapped except inside the one dialog, which
returns focus to its trigger on close.

---

## 11. Interface copy specimens

Plain, exact, no urgency, and no em dash anywhere.

| Context | Copy |
|---|---|
| Fiction marker | `Fictional training case. As of 14 March 2026.` |
| Autosave | `Draft saved 14:21` |
| Autosave failure | `Not saved. Your text is still here.` |
| Submit button | `Submit decision` |
| Post-submission stamp | `Submitted 20 Oct 2026 14:23. This version cannot be edited.` |
| Revision marker | `Revision 2. Revision 1 remains visible.` |
| AI provenance | `AI-generated formative analysis. Not a validated assessment of competence.` |
| Fixture banner | `Example challenges. Not generated by a model.` |
| Abstention | `Evidence insufficient. The case sources do not settle this question.` |
| Unobserved outcome | `Not yet observable.` |
| Validation | `Confidence must be a whole number between 0 and 100.` |
| Empty actions | `No open actions.` |
| Deletion confirm | `Delete your account and all records. This cannot be undone. Backups are removed on the documented retention schedule, not immediately.` |

Never used: `Great work`, `You are on track`, `Streak`, `Score`, `Level up`, `Almost
there`, `Don't miss`, `Only N left`.

---

## 12. Verification: what is computed and what is not

### Computed

The palette in `DESIGN.md` was verified by converting OKLCH to sRGB and computing WCAG
relative-luminance contrast for 31 pairs. Result: **0 tokens out of sRGB gamut, 30 of 31
pairs passing.** Control borders reach 3:1 against page, surface and recessed backgrounds
in both themes. Body text reaches 14:1 or better in both themes. The primary button label
reaches 6.14:1 light and 7.85:1 dark.

The single non-passing pair, `focus ink` against the filled `danger` button at 2.61:1, is
resolved by construction rather than by changing a token: `outline-offset` plus a
surface-coloured inner band means those two colours are never adjacent, and the ring is
measured against the page at 15.11:1 light and 15.57:1 dark. **If the offset is ever
removed, that pair becomes adjacent and non-compliant.** Recorded so the constraint
survives.

A single-colour focus ring was shown to be impossible: no one colour reaches 3:1 against
both a dark page and a light amber fill. The two-tone ring is a derived result.

### Not yet measured, and therefore not claimed

- Rendered geometry. Every target-size, gutter and overflow claim here is an intent. The
  320px no-overflow rule, the 44px targets and the focus-indicator geometry must be
  measured on a real rendered page, and the responsive and a11y gates in the canon §8.5
  carry the positive controls that prove those checks can fail.
- Type metrics. Source Sans 3 and JetBrains Mono must be confirmed to resolve and to carry
  tabular figures before the numeric-column rule is relied on.
- Reading-order and screen-reader behaviour, which needs a real page and a real assistive
  technology, recorded as a manual verification leg with its own evidence record.
- Core Web Vitals. No bundle exists.

### Open design questions

1. Whether the long prose fields want a reading serif. Deferred behind an ADR rather than
   decided by reflex.
2. Whether the lens progress line should show which lenses abstained before the user opens
   them. Showing it risks pre-framing the user's reading; hiding it costs orientation.
3. Whether revision 2 should render as a diff against revision 1 or as an independent
   document. A diff is more informative and risks implying the first answer was a draft,
   which it was not.
