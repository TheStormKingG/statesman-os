# DESIGN.md

Design system for STATESMAN OS. Companion to `PRODUCT.md`.

Every contrast ratio below was **computed**, not estimated: OKLCH converted to sRGB, then
WCAG 2.x relative luminance. The verification script and its output are recorded in
`docs/ui-ux-design.md` §9. No ratio in this file is an assertion.

**Register:** product. **Theme:** light primary, dark equal. **Colour strategy:**
Restrained (tinted neutrals plus one accent, accent under 10% of surface).

---

## 1. Why this palette, and what it deliberately is not

Three candidate directions were rejected before this one:

| Rejected | Reason |
|---|---|
| Navy + white + formal serif | First-order category reflex. "Civic or government tool" predicts it from the category alone. |
| Terminal-style dark mode with a neon accent | Second-order reflex: the thing you reach for *after* rejecting navy. Also contradicted by the usage scene, which is a bright room in the morning. |
| Navy primary with a green "success" accent and red urgency, as recommended by the design-system query | Unusable on product grounds, not taste. PRD §9.4 prohibits urgency and persuasion mechanics, and a green/red axis would reconstruct the evaluative score that PRD §6.2 FR-10 forbids. |

**The constraint that actually drives the palette:** colour may never carry evaluative
meaning. There is no good/bad axis, because the product refuses to grade the person. So
colour does exactly two jobs: it marks what is interactive, and it marks destructive
intent. Everything else is a tinted neutral.

The neutrals are tinted toward the accent hue (75) at chroma 0.004 to 0.012, so the greys
are of the same family as the accent rather than a separate blue-grey system. No `#000`,
no `#fff` except the single elevated surface token.

---

## 2. Colour tokens (verified)

### Light

| Token | OKLCH | Hex | Role |
|---|---|---|---|
| `--bg` | `oklch(0.985 0.004 75)` | `#fcfaf7` | Page |
| `--surface` | `oklch(1 0 75)` | `#ffffff` | Raised surface, focus inner band |
| `--subtle` | `oklch(0.962 0.006 75)` | `#f5f2ee` | Recessed areas, table header, read-only fields |
| `--divider` | `oklch(0.900 0.007 75)` | `#e1ddd9` | Decorative hairlines only. No ratio requirement. |
| `--border` | `oklch(0.640 0.012 75)` | `#918b84` | **Control boundaries.** Must stay at or above 3:1. |
| `--fg` | `oklch(0.255 0.012 75)` | `#26221c` | Body text, focus ink |
| `--fg-muted` | `oklch(0.470 0.012 75)` | `#5f5a54` | Secondary text, helper text |
| `--accent` | `oklch(0.700 0.125 75)` | `#cb9238` | Primary button fill, active indicator |
| `--accent-fg` | `oklch(0.235 0.030 75)` | `#261c0d` | Label on `--accent` |
| `--accent-ink` | `oklch(0.540 0.110 75)` | `#93640c` | Links and accent-coloured text |
| `--danger` | `oklch(0.520 0.185 27)` | `#bc2826` | Destructive action, validation error |

### Dark

| Token | OKLCH | Hex | Role |
|---|---|---|---|
| `--bg` | `oklch(0.195 0.008 75)` | `#171411` | Page |
| `--surface` | `oklch(0.235 0.009 75)` | `#211e19` | Raised surface, focus inner band |
| `--subtle` | `oklch(0.275 0.010 75)` | `#2b2722` | Recessed areas |
| `--divider` | `oklch(0.330 0.010 75)` | `#383530` | Decorative hairlines only |
| `--border` | `oklch(0.550 0.012 75)` | `#76716a` | **Control boundaries** |
| `--fg` | `oklch(0.945 0.006 75)` | `#efece8` | Body text, focus ink |
| `--fg-muted` | `oklch(0.730 0.010 75)` | `#aba7a1` | Secondary text |
| `--accent` | `oklch(0.760 0.130 75)` | `#e1a447` | Primary button fill |
| `--accent-fg` | `oklch(0.225 0.030 75)` | `#241a0b` | Label on `--accent` |
| `--accent-ink` | `oklch(0.820 0.120 75)` | `#f2b966` | Links |
| `--danger` | `oklch(0.680 0.170 27)` | `#ef675c` | Destructive, error |

Dark is **not** an inversion. Chroma rises slightly on the accent as lightness rises, and
the muted text is lightened rather than the background darkened, so hierarchy parity holds
in both themes.

### Two tokens, one word

`--divider` and `--border` both look like "the border colour" and are not
interchangeable. WCAG 1.4.11's 3:1 applies to the boundary that lets a user *identify a
control*, not to decorative rules. One token serving both jobs either makes every hairline
heavy or leaves every input boundary illegible. Inputs, selects, checkboxes, buttons and
focusable cards take `--border`. Table rules, section separators and card hairlines take
`--divider`.

---

## 3. Focus

A single-colour ring cannot work here, and that is a computed result rather than a
preference: no one colour reaches 3:1 against both a dark page and a light amber button
fill. So focus is **two-tone**.

```css
:where(a, button, input, select, textarea, summary, [tabindex]):focus-visible {
  outline: 2px solid var(--fg);     /* ink ring */
  outline-offset: 2px;              /* the gap exposes the page behind the control */
  box-shadow: 0 0 0 2px var(--surface);  /* explicit inner band */
  border-radius: inherit;
}
```

The inner band guarantees the ink ring is never adjacent to a coloured fill, so the ring's
contrast is always measured against the page: **15.11:1 light, 15.57:1 dark.**

This matters because `--fg` against the filled danger button measures only 2.61:1. With
the offset and the inner band those two colours are never adjacent, so the pair is not the
one WCAG compares. The number is recorded here so nobody later removes the offset and
assumes the ring is still compliant.

Never remove the focus ring. Never replace it with a colour change alone.

---

## 4. Type

| Role | Family | Notes |
|---|---|---|
| UI and prose | **Source Sans 3** | Open licence, holds up at 16px, has a true italic. Not Inter. |
| Identifiers, timestamps, confidence values, version strings, table numerics | **JetBrains Mono** | Chosen for **tabular figures**, so columns and confidence values do not shift width as digits change. |

One sans and one mono. No serif at P0: mixing a reading serif into dense structured forms
costs coherence, and a serif display face here would be the category reflex. If the long
prose fields later want a reading serif, that is a deliberate change behind an ADR, not a
default.

This is a restrained type choice made on purpose. The product is a reading and writing
instrument used daily for fifteen minutes; legibility at small sizes beats distinctiveness,
and a private tool earns nothing from an expressive display face.

**Pin exact versions at install and verify the families resolve before relying on them.**
Self-host with `font-display: swap`. No `<link>` to Google Fonts in production.

### Scale

Body 16px minimum, never below. Line height 1.5 for body, 1.25 for headings. Measure capped
at 70ch for prose, which matters most in the journal fields.

| Step | Size / line height | Use |
|---|---|---|
| `xs` | 12 / 1.4 | Mono metadata only, never body |
| `sm` | 14 / 1.5 | Helper text, table cells, labels |
| `base` | 16 / 1.5 | Body, inputs, prose |
| `lg` | 18 / 1.5 | Long prose fields, challenge questions |
| `xl` | 22 / 1.3 | Screen title |
| `2xl` | 28 / 1.25 | Scenario title |

Weight carries hierarchy with size: 600 headings, 500 labels, 400 body. Ratio between
adjacent steps stays at or above 1.25 at the display end.

---

## 5. Space, shape, elevation

**Space:** 4px base. Scale 4, 8, 12, 16, 24, 32, 48, 64. Section rhythm uses 24 / 32 / 48
by hierarchy depth; padding is deliberately varied between regions rather than uniform.

**Radius:** one system, three steps. `2px` chips and mono tags, `4px` inputs, buttons and
cards, `0` table cells. No pills anywhere. Nothing else.

**Elevation:** two levels only. Flat on `--bg`, and raised on `--surface` with a 1px
`--divider` hairline. Shadows are tinted toward hue 75 and used only on genuinely floating
layers (popover, dialog). No shadow on cards.

Cards are used only where elevation marks a real boundary. Grouping is done with space and
a single hairline first. Nested cards are never correct.

---

## 6. Motion

Chosen by frequency, not by taste. An animation a user sees a hundred times a day is a tax.

| Interaction | Frequency | Decision |
|---|---|---|
| Keyboard-initiated: save draft, command palette, lens navigation | 100+/day | **No animation at all.** |
| Screen navigation | tens/day | Opacity only, 120ms. No movement. |
| Button press | constant | `scale(0.97)`, 120ms |
| Field validation message | occasional | Opacity and 4px rise, 160ms |
| Popover, select | occasional | 180ms, origin-aware from the trigger |
| Submission confirmation dialog | rare, consequential | 240ms, centred origin |
| Challenge cards after generation | once per decision | 50ms stagger, 200ms each |

```css
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);   /* entering, the default */
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1); /* on-screen movement */
```

Rules: never `ease-in` on UI, it delays the moment the user is watching. Never
`transition: all`. Only `transform`, `opacity` and `filter`. Exit at roughly 60 to 70% of
enter duration. Never enter from `scale(0)`; start at `0.95` with opacity. Popovers scale
from their trigger, dialogs stay centred. Use CSS transitions rather than keyframes
anywhere a state can be re-triggered mid-animation.

Under `prefers-reduced-motion: reduce`, keep opacity and colour transitions, drop every
transform and every stagger. Reduced motion means gentler, not none.

Hover effects are gated behind `@media (hover: hover) and (pointer: fine)`.

---

## 7. Encoding epistemic status without colour

The product's core distinction is `fact | inference | hypothetical | value_judgment` and an
uncertainty level of `low | medium | high | insufficient_evidence`. Both must be readable in
greyscale, by a screen reader, and at 320px.

**Not a coloured left border.** A thick coloured side stripe is the obvious answer, it is a
banned pattern, and it would fail greyscale and colour-blind users anyway.

The encoding is three redundant channels:

1. A mono uppercase label at `xs`, spelling the category out: `FACT`, `INFERENCE`,
   `HYPOTHETICAL`, `VALUE JUDGEMENT`.
2. A distinct glyph per category from one icon family, at one stroke width.
3. For uncertainty, a filled-segment indicator of three segments plus the word, so the word
   carries the meaning and the segments only speed up scanning.

`insufficient_evidence` is a designed state with its own treatment and the explicit string
"Evidence insufficient", never an empty space. `Not yet observable` is likewise a real
state, not a blank.

The container is a full 1px `--divider` hairline. Category never changes the background
colour, because a tinted background per category reintroduces a colour code and starts to
read as a grade.

---

## 8. Icons

One family, one stroke width. Lucide at `1.5px`, sized by token (`16`, `20`, `24`). Outline
only, no mixing of filled and outline at the same level.

No emoji anywhere in the interface. No hand-drawn SVG paths. Every icon-only control carries
an `aria-label`, and icon-only controls are avoided for anything consequential.

---

## 9. Fixed rules

- Minimum target 44×44px, 8px minimum gap between targets.
- Label above every input. Placeholder is never the label. Helper text persists in the
  markup rather than appearing only on error.
- Validate on blur, not on keystroke. Error below the field, plus `role="alert"`. On a failed
  submit, move focus to the first invalid field. With several errors, a summary at the top
  with anchors to each.
- Tabular figures for every number in a column, every confidence value, every timestamp.
- Prefer wrapping to truncation. Where truncation is unavoidable, the full value is
  reachable.
- No horizontal page scroll at 320px.
- Heading levels never skip.
- One primary action per screen. Destructive actions are separated spatially from primary
  ones and confirmed.
- Long forms autosave. Dismissing a sheet with unsaved changes is confirmed.
- No `#000`, no `#fff` outside `--surface`. No gradient text. No glassmorphism. No
  decorative status dots. No side-stripe borders. No em dash in any interface string.
