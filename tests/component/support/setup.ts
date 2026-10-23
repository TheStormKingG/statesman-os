/**
 * Per-file setup for the component suite.
 *
 * TWO THINGS jsdom DOES NOT PROVIDE, both load-bearing for the Desk.
 *
 * 1. `HTMLDialogElement.showModal` / `close`. jsdom 29 ships the element but
 *    not the modal methods, so the real submit path — form submit opens the
 *    confirmation dialog — throws `showModal is not a function` rather than
 *    opening anything. The shims below are the minimum that makes the OBSERVABLE
 *    behaviour right: `open` reflects, and `close` fires a `close` event. They
 *    are NOT a modal implementation: no focus trap, no inert background, no top
 *    layer. A test that asserted anything about modality would be asserting
 *    these shims, so none does.
 *
 * 2. `next/link` needs an app-router context to be mounted. Rendering one
 *    outside a Next tree throws an invariant. The stub renders a plain anchor
 *    with the same href, which is all the assertions read.
 */
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

if (typeof HTMLDialogElement !== 'undefined') {
  const proto = HTMLDialogElement.prototype
  // The DOM lib declares both methods, so no cast is involved: the question is
  // only whether this jsdom build implements them.
  if (typeof proto.showModal !== 'function') {
    proto.showModal = function showModal(this: HTMLDialogElement): void {
      this.setAttribute('open', '')
    }
  }
  if (typeof proto.close !== 'function') {
    proto.close = function close(this: HTMLDialogElement): void {
      this.removeAttribute('open')
      this.dispatchEvent(new Event('close'))
    }
  }
}

vi.mock('next/link', async () => {
  const React = await import('react')
  return {
    __esModule: true,
    default: function LinkStub({
      href,
      children,
      ...rest
    }: {
      readonly href: string
      readonly children?: React.ReactNode
    } & Record<string, unknown>): React.ReactElement {
      return React.createElement('a', { href, ...rest }, children)
    },
  }
})

afterEach(() => {
  cleanup()
})
