/**
 * The Supabase Auth (GoTrue) half of the error taxonomy.
 *
 * ── WHY A SEPARATE FILE, AND WHY THE SAME BASE CLASS ────────────────────────
 *
 * `errors.ts` is about the DATA boundary: PostgreSQL SQLSTATEs and PostgREST
 * codes. GoTrue is a third source with its own vocabulary, and folding it into
 * a file whose whole structure is "which SQLSTATE means what" would blur the
 * one thing that file is good at. So the classes live here.
 *
 * They still extend `StatesmanError`, and their `kind`s are in the one
 * `ErrorKind` union, because `httpStatusFor()`, `publicMessageFor()` and
 * `isRetryable()` must keep working for every error the application can
 * produce. Two parallel taxonomies would mean every call site asking "which
 * kind of error is this kind of error" before it could ask anything useful.
 *
 * ── WHAT WAS MEASURED, AND WHY IT SHAPES THIS FILE ──────────────────────────
 *
 * Read from `GET /auth/v1/settings` on project onpkspfxfmjkqpomcsse,
 * 2026-10-22 (a public endpoint; no credentials, nothing written):
 *
 *   disable_signup     : false     anyone may register
 *   mailer_autoconfirm : false     sign-up sends a confirmation email and
 *                                  returns NO session
 *   external providers : { email: true }   password only
 *
 * `mailer_autoconfirm: false` is the fact that shapes the whole sign-up path.
 * A successful sign-up does NOT produce a session, so any code that treats
 * "no error" as "signed in" is wrong against this project specifically, not
 * hypothetically. `auth.ts` returns a discriminated result rather than a
 * session for exactly that reason.
 *
 * ── THE ENUMERATION TRAP, which is why there is no `email_already_in_use` ───
 *
 * With confirmations enabled, GoTrue answers a sign-up for an address that is
 * ALREADY registered with a success containing an obfuscated user object and a
 * null session — deliberately indistinguishable from a genuine new sign-up, so
 * that the endpoint cannot be used to enumerate accounts. There is therefore no
 * error class here for "that email is taken": inventing one would require
 * guessing, and the UI would state something the API refused to tell it. The
 * copy in the sign-up screen says only what is true: if the address can receive
 * mail, a message is on its way.
 */

import { StatesmanError } from './errors'

type Detail = { readonly cause?: unknown }

/**
 * The password was wrong, or no such account exists. ONE class for both, because
 * GoTrue answers both with `invalid_credentials` — on purpose, so that a caller
 * cannot tell a registered address from an unregistered one. Splitting it here
 * would mean fabricating a distinction the server withheld.
 */
export class InvalidCredentialsError extends StatesmanError {
  constructor(message: string, detail: Detail = {}) {
    super({
      ...detail,
      message,
      kind: 'invalid_credentials',
      httpStatus: 401,
      publicMessage: 'That email and password do not match an account.',
    })
  }
}

/**
 * The account exists but the address was never confirmed. Distinct from
 * `InvalidCredentialsError` because the remedy is completely different — the
 * password is right and there is nothing to retype — and because telling someone
 * to check their password when the real problem is an unclicked email is how a
 * person ends up resetting a password that was never wrong.
 */
export class EmailNotConfirmedError extends StatesmanError {
  constructor(message: string, detail: Detail = {}) {
    super({
      ...detail,
      message,
      kind: 'email_not_confirmed',
      httpStatus: 403,
      publicMessage:
        'This account exists but its email address has not been confirmed yet. ' +
        'Open the confirmation link that was sent to it.',
    })
  }
}

/** Registration is closed on the project. */
export class SignupDisabledError extends StatesmanError {
  constructor(message: string, detail: Detail = {}) {
    super({
      ...detail,
      message,
      kind: 'signup_disabled',
      httpStatus: 403,
      publicMessage: 'New accounts are not being created on this instance.',
    })
  }
}

/**
 * GoTrue's rate limiter. RETRYABLE, and the only retryable error in this file.
 *
 * This one matters more than it looks on a project using Supabase's built-in
 * email service, whose limit is a small number of messages per hour. A user who
 * clicks "resend" three times gets this, and a UI that renders it as a generic
 * failure invites them to keep clicking.
 */
export class RateLimitedError extends StatesmanError {
  constructor(message: string, detail: Detail = {}) {
    super({
      ...detail,
      message,
      kind: 'rate_limited',
      httpStatus: 429,
      retryable: true,
      publicMessage: 'Too many attempts. Wait a few minutes and try again.',
    })
  }
}

/** The password does not meet the project's policy. */
export class WeakPasswordError extends StatesmanError {
  constructor(message: string, detail: Detail = {}) {
    super({
      ...detail,
      message,
      kind: 'weak_password',
      httpStatus: 422,
      // GoTrue's own reasons list is the useful part, and it is not sensitive,
      // so the caller passes it through in `message`; this stays generic.
      publicMessage: 'That password does not meet the requirements.',
    })
  }
}

/**
 * An auth failure this file does not recognise.
 *
 * NOT retryable, and not silently folded into `InvalidCredentialsError`. An
 * unrecognised failure rendered as "wrong password" sends the user to fix
 * something that is not broken, which is worse than admitting ignorance.
 */
export class UnknownAuthError extends StatesmanError {
  constructor(message: string, detail: Detail = {}) {
    super({
      ...detail,
      message,
      kind: 'unknown_auth',
      httpStatus: 500,
      publicMessage: 'Sign-in failed for an unexpected reason.',
    })
  }
}

/**
 * The shape supabase-js hands back. Declared structurally rather than imported
 * as `AuthError`, because the mapper must also cope with a plain object from a
 * `fetch` (the probe script's shape) and with `unknown` from a catch block.
 */
interface AuthErrorLike {
  readonly message?: unknown
  /** GoTrue's stable machine-readable code. Present on current versions. */
  readonly code?: unknown
  /** The older field, still returned by some endpoints. */
  readonly error_code?: unknown
  readonly status?: unknown
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Map a GoTrue failure onto the taxonomy.
 *
 * ── CODE FIRST, MESSAGE ONLY AS A FALLBACK ──────────────────────────────────
 *
 * `code` is a stable identifier; `message` is prose that GoTrue is free to
 * reword. Matching on prose is how a mapper silently stops recognising the case
 * it was written for — the error keeps arriving, the branch stops firing, and
 * nothing fails. So `code` is consulted first and the message is a documented
 * fallback for older responses, not the primary signal.
 *
 * Returns the mapped error rather than throwing, so a caller can decide; it
 * returns `unknown` for the same reason `mapDatabaseError` does — the result is
 * meant to be thrown, and typing it as `Error` would invite inspecting it here.
 */
export function mapAuthError(value: unknown): unknown {
  if (value instanceof StatesmanError) return value
  if (value === null || typeof value !== 'object') {
    return new UnknownAuthError(`auth failed with a non-object value: ${String(value)}`, {
      cause: value,
    })
  }

  const e = value as AuthErrorLike
  const code = str(e.code) ?? str(e.error_code)
  const message = str(e.message) ?? 'no message'

  switch (code) {
    case 'invalid_credentials':
    case 'invalid_grant':
      return new InvalidCredentialsError(message, { cause: value })
    case 'email_not_confirmed':
      return new EmailNotConfirmedError(message, { cause: value })
    case 'signup_disabled':
    case 'email_provider_disabled':
      return new SignupDisabledError(message, { cause: value })
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
    case 'over_sms_send_rate_limit':
      return new RateLimitedError(message, { cause: value })
    case 'weak_password':
      return new WeakPasswordError(message, { cause: value })
    default:
      break
  }

  // Fallback for responses that carry no `code`. Ordered so the more specific
  // phrase is tested before the more general one: GoTrue's unconfirmed-email
  // message contains the word "confirmed", and its bad-password message
  // contains "credentials", so a looser order would mis-map one of them.
  const lower = message.toLowerCase()
  if (lower.includes('not confirmed')) {
    return new EmailNotConfirmedError(message, { cause: value })
  }
  if (lower.includes('invalid login credentials')) {
    return new InvalidCredentialsError(message, { cause: value })
  }
  if (e.status === 429 || lower.includes('rate limit')) {
    return new RateLimitedError(message, { cause: value })
  }
  if (lower.includes('signups not allowed') || lower.includes('signup is disabled')) {
    return new SignupDisabledError(message, { cause: value })
  }

  return new UnknownAuthError(message, { cause: value })
}
