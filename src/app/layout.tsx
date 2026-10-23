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
        {/*
          WHY THIS IS HERE AND NOT LEFT TO THE READER TO WORK OUT.

          Every screen is a client component that reads its session and its data
          in the browser, so the PRERENDERED html of /today/ and /desk/ contains
          only the shell plus whatever those components render before any effect
          has run. MEASURED on the built export: a visitor to /today/ with
          scripting disabled sees exactly

            STATESMAN OS  Skip to main content  Checking for a session.

          and nothing more, forever. "Checking" is then a false statement: there
          is no script to do the checking and none will run. A page that claims
          to be working on something it has abandoned is the small kind of lie
          this product is built not to tell, so it is contradicted here, in the
          one place that covers every route.
        */}
        <noscript>
          <div className="page">
            <p className="notice">
              This application needs JavaScript. It has no server: the pages are static
              files and every screen reads the database directly from your browser, so with
              scripting disabled nothing loads and no session can be established. Any text
              above saying a check is in progress is wrong in this state, because nothing is
              running.
            </p>
          </div>
        </noscript>
        {children}
      </body>
    </html>
  )
}
