/**
 * Supabase Auth operations, and the profile row that anchors a user to the
 * `public` schema.
 *
 * ── THE ONE THING TO UNDERSTAND BEFORE CHANGING THIS FILE ───────────────────
 *
 * Nothing here is a security boundary. Every function below runs in the user's
 * own browser, reads a session out of that browser's `localStorage`, and can be
 * made to return whatever its owner likes with the developer console open. A
 * signed-in state in this module is a RENDERING HINT and nothing more.
 *
 * What actually enforces anything is on the other side of the wire: PostgREST
 * validates the JWT's signature, resolves it to the `authenticated` role, and
 * every table those requests touch is `enable`d and `force`d under RLS with a
 * policy keyed on `auth.uid()`. ADR-0015 is explicit that after the port "row
 * level security in the database is the only thing protecting the data".
 *
 * So a bug in this file can show the wrong screen. It cannot show the wrong
 * person's journal. Keep it that way: do not add a check here and treat it as
 * protection, and do not pass a user id to anything privileged — the lifecycle
 * functions derive identity internally and take no uuid, which canon §4.6
 * requires for exactly this reason.
 *
 * ── MEASURED ON THE LIVE PROJECT, 2026-10-22 ────────────────────────────────
 *
 * From `GET /auth/v1/settings` (public endpoint, no credentials, nothing
 * written):
 *
 *   disable_signup     : false     anyone may register
 *   mailer_autoconfirm : false     sign-up sends a confirmation email and
 *                                  returns NO session
 *   external providers : { email: true }   password only, no OAuth
 *
 * `mailer_autoconfirm: false` is why `signUp()` returns a discriminated outcome
 * instead of a session. Against THIS project, a successful sign-up leaves the
 * user not signed in, and code that reads "no error" as "signed in" is wrong as
 * a matter of fact rather than of style.
 *
 * Reachability of the endpoint was confirmed separately by execution: a sign-in
 * with deliberately bogus credentials returned `400 invalid_credentials`,
 * "Invalid login credentials". That proves the URL and the publishable key are
 * right, and it created nothing.
 */

import type { Session } from '@supabase/supabase-js'
import { supabase } from './client'
import { mapPostgrestError } from './errors'
import { mapAuthError } from './auth-errors'

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/**
 * What the UI is allowed to know about the signed-in user.
 *
 * Deliberately NOT the `Session`. A session carries the access token, and a
 * token that is passed around the component tree is a token that ends up in a
 * log line, an error report or a React dev-tools snapshot. Canon §6 forbids
 * logging session tokens; the cheapest way to honour that is for the rest of
 * the application never to hold one. The single client in `client.ts` attaches
 * it to requests itself.
 */
export interface AuthedIdentity {
  readonly userId: string
  /** Absent rather than guessed: a session can exist with no email claim. */
  readonly email: string | undefined
}

function identityOf(session: Session | null): AuthedIdentity | undefined {
  if (session === null) return undefined
  const userId = session.user.id
  if (typeof userId !== 'string' || userId.length === 0) return undefined
  return { userId, email: session.user.email ?? undefined }
}

/**
 * The current identity, read from local storage.
 *
 * `getSession()`, NOT `getUser()`. `getUser()` makes a network round trip to
 * validate the token, which is the right call when a decision depends on the
 * token being genuine — and no decision here does, because this module is not a
 * boundary (see the header). Using `getUser()` would add a request to every
 * first paint and buy a guarantee this layer is not entitled to make anyway.
 */
export async function currentIdentity(): Promise<AuthedIdentity | undefined> {
  const { data, error } = await supabase.auth.getSession()
  if (error !== null) throw mapAuthError(error)
  return identityOf(data.session)
}

/**
 * Subscribe to sign-in and sign-out. Returns the unsubscribe function.
 *
 * Needed because a static export has no server to redirect: the confirmation
 * and recovery links come back to this page with tokens in the URL fragment,
 * `detectSessionInUrl: true` consumes them, and the only notification the
 * application gets that it is now signed in is this callback.
 */
export function onIdentityChange(
  listener: (identity: AuthedIdentity | undefined) => void,
): () => void {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    listener(identityOf(session))
  })
  return () => {
    data.subscription.unsubscribe()
  }
}

/* ------------------------------------------------------------------ *
 * Sign in / sign up / sign out
 * ------------------------------------------------------------------ */

export async function signIn(email: string, password: string): Promise<AuthedIdentity> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error !== null) throw mapAuthError(error)
  const identity = identityOf(data.session)
  if (identity === undefined) {
    // Defensive, and not dead code: a 200 with no session would otherwise leave
    // the caller believing it is signed in because nothing threw.
    throw mapAuthError({
      code: 'unknown_auth',
      message: 'sign-in returned success with no session',
    })
  }
  return identity
}

/**
 * The result of a sign-up. Two cases, because on this project the common one
 * does NOT sign the user in.
 */
export type SignUpOutcome =
  | { readonly kind: 'session'; readonly identity: AuthedIdentity }
  | { readonly kind: 'confirmation-required'; readonly email: string }

/**
 * Where a confirmation link should return the user.
 *
 * Computed from the live location so it is correct both on
 * `http://localhost:3000/...` and on the Pages URL under its `basePath`,
 * rather than hard-coded to one and wrong on the other.
 *
 * UNVERIFIED, and it is the first thing to check if confirmation links land
 * somewhere unexpected: GoTrue only honours a redirect that matches the
 * project's **Redirect URLs** allowlist, and silently falls back to **Site
 * URL** otherwise. Both are project settings, not SQL, and no migration in this
 * repository can set them. A stock project's Site URL is
 * `http://localhost:3000`, so until the Pages origin is added to the allowlist,
 * a confirmation email will send the user to localhost.
 */
function confirmationRedirectTo(): string | undefined {
  if (typeof window === 'undefined') return undefined
  return `${window.location.origin}${window.location.pathname}`
}

export async function signUp(email: string, password: string): Promise<SignUpOutcome> {
  const redirectTo = confirmationRedirectTo()
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    ...(redirectTo === undefined ? {} : { options: { emailRedirectTo: redirectTo } }),
  })
  if (error !== null) throw mapAuthError(error)

  const identity = identityOf(data.session)
  if (identity !== undefined) return { kind: 'session', identity }

  /**
   * No session. On this project that is the EXPECTED outcome, and it covers two
   * situations GoTrue refuses to distinguish:
   *
   *   1. a genuinely new account, now awaiting confirmation;
   *   2. an address that is ALREADY registered — answered with an obfuscated
   *      user object and a null session, specifically so that this endpoint
   *      cannot be used to enumerate accounts.
   *
   * We do not know which. So the outcome says only that confirmation is
   * required, and the screen's copy is written to be true in both cases. An
   * "account created" message here would be a claim we cannot support, and in
   * case 2 it would also leak that the address is registered.
   */
  return { kind: 'confirmation-required', email }
}

export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut()
  if (error !== null) throw mapAuthError(error)
}

/* ------------------------------------------------------------------ *
 * The profile row
 * ------------------------------------------------------------------ */

/**
 * What `ensureProfile` observed. Named states rather than a boolean, because
 * "false" would have to mean both "it was already there" and "I could not tell".
 */
export type ProfileBootstrap =
  | { readonly kind: 'created' }
  | { readonly kind: 'existed' }

/**
 * Make sure the signed-in user has a `public.profile` row, and report which of
 * the two states was actually observed.
 *
 * ── WHY AN INSERT AND NOT A SELECT-THEN-INSERT ──────────────────────────────
 *
 * The obvious implementation reads the row first and inserts when it finds
 * nothing. It cannot work here, and the reason is the most load-bearing rule in
 * `errors.ts`: a read returning zero rows means "denied", "absent", or "the
 * table is empty and the policy was never evaluated". Branching on it would
 * make a policy failure look like a first-run and send the application into a
 * write it is not allowed to make.
 *
 * The INSERT has no such ambiguity, because it reports what happened:
 *
 *   success              the row did not exist and now does
 *   SQLSTATE 23505       it already existed  (primary key on user_id)
 *   SQLSTATE 42501       the policy refused  — measured as "new row violates
 *                        row-level security policy" (ADR-0015)
 *
 * Each of those is a distinct answer. That is the whole argument for doing it
 * this way: canon §4.4's "a row count of 0 is never a success signal" with the
 * corollary that a write's own status is a signal, and a read's row count is not.
 *
 * ── WHY THE USER ID IS PASSED, WHEN CANON SAYS IDENTITY IS DERIVED ──────────
 *
 * `profile.user_id` is a PK with no default and `authenticated` holds plain
 * INSERT, so a value must be supplied. Canon §4.6's rule — "once identity
 * exists a call derives it internally and takes no uuid" — is about the
 * `SECURITY DEFINER` functions, where a passed uuid is an identity channel an
 * attacker controls. This is not that: the policy's
 * `with check (user_id = auth.uid())` is evaluated by the database against the
 * JWT, so a row naming anyone else is refused with 42501 no matter what this
 * code sends. The guard is the policy, not the caller's good behaviour.
 *
 * ── NOT A TRIGGER ON auth.users ─────────────────────────────────────────────
 *
 * The conventional Supabase pattern creates profiles from an `AFTER INSERT`
 * trigger on `auth.users`. Rejected twice over. The `auth` schema is
 * platform-owned and the emulation deliberately makes it unwritable by our
 * migrations (port finding P9), so such a trigger would exist on the project and
 * not locally — the exact divergence that makes a local gate meaningless. And
 * `profile.user_id` references `auth.users` **ON DELETE RESTRICT** (canon §5.2,
 * no cascade from the identity table), so auto-creating a profile for every new
 * auth user would make deleting any user from the dashboard fail forever after.
 * Creating the row on first sign-in keeps erasure a deliberate path, which is
 * what FR-16 requires it to be.
 */
export async function ensureProfile(identity: AuthedIdentity): Promise<ProfileBootstrap> {
  const { error } = await supabase.from('profile').insert({ user_id: identity.userId })
  if (error === null) return { kind: 'created' }

  // 23505 is the primary key doing its job, which is the ordinary second-visit
  // path and not a fault. Everything else is mapped and thrown.
  if (error.code === '23505') return { kind: 'existed' }
  throw mapPostgrestError(error)
}
