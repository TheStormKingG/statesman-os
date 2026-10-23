'use client'

/**
 * Renders its children only when a session exists, and otherwise renders the
 * sign-in form.
 *
 * ── THIS IS NOT A SECURITY BOUNDARY, AND SAYING SO IS NOT A DISCLAIMER ──────
 *
 * Everything here runs in the user's browser and reads a session out of that
 * browser's `localStorage`. Someone with the developer console open can make
 * this component render its children with no session at all. That is FINE, and
 * it is important to understand WHY it is fine rather than to add checks that
 * look like protection:
 *
 *   the children would then render with no data. Every table they read is
 *   `enable`d and `force`d under RLS with a policy keyed on `auth.uid()`, and
 *   PostgREST resolves the role from a SIGNED token it validates itself. A
 *   browser that lies to this component still sends no credential, so it is
 *   still `anon`, and `anon` holds nothing (measured: 0 reachable tables).
 *
 * So the worst a bug here can do is show an empty screen to the wrong person.
 * It cannot show them someone else's journal. Do not add an authorisation check
 * to this file and treat it as enforcement; put it in a policy.
 *
 * ── WHY THE PROFILE ROW IS CREATED HERE ─────────────────────────────────────
 *
 * `public.profile` is the FK anchor every user-owned row hangs from, so it has
 * to exist before the first decision can be written. It is created on first
 * sign-in rather than by a trigger on `auth.users`, for the two reasons
 * `auth.ts` records: the `auth` schema is platform-owned and the emulation makes
 * it unwritable by our migrations, and `profile.user_id` references
 * `auth.users` ON DELETE RESTRICT, so auto-creating profiles would make deleting
 * any user from the dashboard fail forever.
 *
 * A failure here does NOT block the screen. The profile row matters for writing,
 * and the user may only be reading; a reader held at a spinner because a row
 * they do not yet need could not be created would be a worse outcome than a
 * named error at the moment they first write.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  currentIdentity,
  ensureProfile,
  onIdentityChange,
  signIn,
  signOut,
  signUp,
} from '../lib/supabase/auth'
import type { AuthedIdentity } from '../lib/supabase/auth'
import { publicMessageFor } from '../lib/supabase/errors'

type GateState =
  | { readonly phase: 'checking' }
  | { readonly phase: 'anonymous' }
  | { readonly phase: 'signed-in'; readonly identity: AuthedIdentity }

export function AuthGate({
  children,
}: {
  readonly children: (identity: AuthedIdentity) => React.ReactNode
}): React.ReactElement {
  const [state, setState] = useState<GateState>({ phase: 'checking' })
  const [profileNote, setProfileNote] = useState<string | undefined>(undefined)
  /** Profiles are ensured once per userId per page load, not once per render. */
  const ensuredFor = useRef<string | undefined>(undefined)

  const adopt = useCallback((identity: AuthedIdentity | undefined) => {
    setState(identity === undefined ? { phase: 'anonymous' } : { phase: 'signed-in', identity })
  }, [])

  useEffect(() => {
    let cancelled = false
    currentIdentity()
      .then((identity) => {
        if (!cancelled) adopt(identity)
      })
      .catch(() => {
        // A failed session read is not a signed-in state. Fall closed.
        if (!cancelled) setState({ phase: 'anonymous' })
      })
    const unsubscribe = onIdentityChange((identity) => {
      if (!cancelled) adopt(identity)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [adopt])

  useEffect(() => {
    if (state.phase !== 'signed-in') return
    const { userId } = state.identity
    if (ensuredFor.current === userId) return
    ensuredFor.current = userId
    ensureProfile(state.identity)
      .then(() => setProfileNote(undefined))
      .catch((error: unknown) => {
        setProfileNote(
          'Your profile row could not be created, so writing a decision will fail: ' +
            publicMessageFor(error),
        )
      })
  }, [state])

  if (state.phase === 'checking') {
    // Deliberately not a spinner. The session is read from local storage and
    // resolves in a millisecond or two; a spinner would flash.
    return <p className="autosave">Checking for a session.</p>
  }

  if (state.phase === 'anonymous') return <SignInPanel />

  return (
    <>
      <div className="site-head">
        <span className="meta-line">{state.identity.email ?? 'signed in'}</span>
        <nav className="site-nav">
          <a href="./">Today</a>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => {
              void signOut()
            }}
          >
            Sign out
          </button>
        </nav>
      </div>
      {profileNote === undefined ? null : (
        <p className="notice" role="alert">
          {profileNote}
        </p>
      )}
      {children(state.identity)}
    </>
  )
}

/* ------------------------------------------------------------------ *
 * Sign in / sign up
 * ------------------------------------------------------------------ */

type Mode = 'sign-in' | 'sign-up'

function SignInPanel(): React.ReactElement {
  const [mode, setMode] = useState<Mode>('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [confirmationSentTo, setConfirmationSentTo] = useState<string | undefined>(undefined)

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      if (mode === 'sign-in') {
        await signIn(email, password)
        // No navigation: onAuthStateChange re-renders the gate.
      } else {
        const outcome = await signUp(email, password)
        if (outcome.kind === 'confirmation-required') setConfirmationSentTo(outcome.email)
      }
    } catch (caught: unknown) {
      setError(publicMessageFor(caught))
    } finally {
      setBusy(false)
    }
  }

  if (confirmationSentTo !== undefined) {
    return (
      <section className="panel auth-card">
        <h1>Confirm your email address</h1>
        {/*
          The copy is true whether this was a new account OR an address that was
          already registered. GoTrue answers both identically on purpose, so that
          this endpoint cannot be used to find out which addresses have accounts,
          and a message saying "account created" would be both unsupported and a
          disclosure.
        */}
        <p>
          If {confirmationSentTo} can receive mail, a confirmation link is on its way. Open
          it and then sign in.
        </p>
        <p className="field-help">
          This instance sends mail through the project&apos;s default service, which is
          rate limited to a small number of messages per hour. If nothing arrives, wait
          before asking for another.
        </p>
        <div className="button-row">
          <button
            type="button"
            className="button"
            onClick={() => {
              setConfirmationSentTo(undefined)
              setMode('sign-in')
            }}
          >
            Back to sign in
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="panel auth-card">
      {/*
        h1, not h2. When nobody is signed in this panel IS the page, so it carries the
        document's only heading. MEASURED on the rendered page before this change: the
        accessibility tree held a single heading at level 2 and no level 1, which is the
        heading skip DESIGN.md §9 forbids.
      */}
      <h1>{mode === 'sign-in' ? 'Sign in' : 'Create an account'}</h1>
      <p className="field-help">
        This is a private workspace. Nothing you write here is shared, published or scored.
      </p>
      <form onSubmit={(e) => void submit(e)} noValidate>
        <div className="field">
          <label htmlFor="auth-email">Email address</label>
          <input
            id="auth-email"
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="auth-password">Password</label>
          <input
            id="auth-password"
            type="password"
            name="password"
            // `new-password` on sign-up so a manager offers to generate one, and
            // `current-password` on sign-in so it offers the saved one. The same
            // value for both would make one of the two behave wrongly.
            autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error === undefined ? null : (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="button-row" style={{ marginBlockStart: '16px' }}>
          <button type="submit" className="button button--primary" disabled={busy}>
            {busy ? 'Working' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
          </button>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => {
              setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')
              setError(undefined)
            }}
          >
            {mode === 'sign-in' ? 'Create an account' : 'I already have an account'}
          </button>
        </div>
      </form>
    </section>
  )
}
