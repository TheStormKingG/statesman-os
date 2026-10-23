/**
 * THE DEFECT THIS SUITE EXISTS FOR.
 *
 * Observed by hand on the deployed site, 2026-10-23: after confirming a
 * submission the Desk showed "Submitted as revision 1. This version cannot be
 * edited." and left every textarea enabled with `Save draft` still offered.
 *
 * `frozen` is derived from `data.decision.submittedAt`, which is the decision as
 * it was LOADED. A successful submit does not change that object, so `frozen`
 * stays false until the next page load and only a reload picked up the new
 * state. In that gap the database refuses the saves as a frozen draft (ST003)
 * while autosave reports `Not saved. Your text is still here.` — text with
 * nowhere to go.
 *
 * `locked = frozen || submitted !== undefined` closes the gap. The assertion
 * that pins the regression is the one on the FIXTURE at the end of the second
 * test: `submittedAt` is still null when the form is locked. A test that
 * re-fetched, or that asserted only "fields are disabled after submit", would
 * pass against the defective version too, because the defective version does
 * lock — one reload later.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { brief, claims, openDraft, revisions, sources } from './support/desk-fixture'
import type * as DecisionsModule from '../../src/lib/supabase/decisions'

// `vi.hoisted` because `vi.mock` is hoisted above every top-level binding: a
// factory closing over a plain `const` throws "Cannot access before
// initialization" at import time.
const mocks = vi.hoisted(() => ({ submitDecision: vi.fn(), saveDraft: vi.fn() }))
const { submitDecision, saveDraft } = mocks

vi.mock('../../src/lib/supabase/decisions', async (importOriginal) => {
  const actual = await importOriginal<typeof DecisionsModule>()
  return { ...actual, submitDecision: mocks.submitDecision, saveDraft: mocks.saveDraft }
})

// Imported after vi.mock above, which Vitest hoists above every import.
import { Desk } from '../../src/app/desk/page'

function loaded() {
  return { brief: brief(), sources: sources(), claims: claims(), decision: openDraft(), revisions: revisions() }
}

/** Every editable control the form renders. */
function controls(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll('textarea, input'))
}

describe('Desk — the submission lock', () => {
  beforeEach(() => {
    submitDecision.mockReset()
    saveDraft.mockReset()
    saveDraft.mockResolvedValue(undefined)
  })

  it('CONTROL: an open draft is editable, and both controls are offered', () => {
    const { container } = render(<Desk data={loaded()} />)

    const fields = controls(container)
    // Fourteen structured fields (canon FR-02). The exact number is asserted so
    // that a form which silently stopped rendering fields cannot make the
    // "everything is disabled" assertion below pass vacuously.
    expect(fields.length).toBeGreaterThanOrEqual(14)
    expect(fields.filter((f) => (f as HTMLTextAreaElement).disabled)).toHaveLength(0)

    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDefined()
  })

  it('locks every field and withdraws both controls the moment a submit succeeds, with no reload', async () => {
    submitDecision.mockResolvedValue({ revisionNo: 1, replayed: false })

    const data = loaded()
    const { container } = render(<Desk data={data} />)

    // Open the confirmation dialog the way a user does.
    const formSubmit = screen
      .getAllByRole('button', { name: 'Submit decision' })
      .find((b) => b.getAttribute('type') === 'submit')
    expect(formSubmit).toBeDefined()
    formSubmit?.click()

    const dialog = container.querySelector('dialog')
    expect(dialog).not.toBeNull()
    await waitFor(() => {
      expect(dialog?.hasAttribute('open')).toBe(true)
    })

    // Confirm.
    within(dialog as HTMLElement)
      .getByRole('button', { name: 'Submit decision' })
      .click()

    await waitFor(() => {
      expect(submitDecision).toHaveBeenCalledTimes(1)
    })

    // ── THE LOCK ────────────────────────────────────────────────────────────
    await waitFor(() => {
      const after = controls(container)
      expect(after.length).toBeGreaterThan(0)
      expect(after.filter((f) => !(f as HTMLTextAreaElement).disabled)).toHaveLength(0)
    })

    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull()
    // `queryAllByRole`, not `getAllByRole`: the latter THROWS when nothing
    // matches, and nothing matching is exactly the state being asserted.
    expect(
      screen
        .queryAllByRole('button', { name: 'Submit decision' })
        .filter((b) => b.getAttribute('type') === 'submit'),
    ).toHaveLength(0)

    expect(screen.getByText(/cannot be edited/i)).toBeDefined()
    expect(screen.getByRole('link', { name: /evidence trail/i })).toBeDefined()

    // ── THE ASSERTION THAT PINS THE REGRESSION ──────────────────────────────
    // The loaded decision is still an OPEN draft. The form is locked anyway, so
    // the lock cannot be coming from `frozen`, and nothing re-fetched.
    expect(data.decision.submittedAt).toBeNull()
  })
})
