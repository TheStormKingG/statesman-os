import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import './globals.css'

/**
 * The root layout. It holds the document shell and nothing else: no navigation,
 * no header chrome, no shared frame, because there are no screens yet to
 * navigate between and a navigation bar pointing at routes that do not exist
 * would be the first piece of fiction in the interface.
 */

export const metadata: Metadata = {
  title: 'STATESMAN OS',
  description: 'Private practice system. Development shell, no screens built yet.',
  /* A private single-user workspace. Never indexed. */
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  /* No maximum-scale and no user-scalable=no: pinch zoom stays available. */
}

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/*
          The skip link is the first focusable thing in the document, so the
          first Tab press reaches it. It is positioned off-screen rather than
          `display: none`, which would remove it from the accessibility tree and
          from the focus order, leaving a link that exists only in the markup.
        */}
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  )
}
