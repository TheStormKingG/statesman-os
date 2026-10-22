/**
 * Unit: GoTrue failure -> typed error, in `src/lib/supabase/auth-errors.ts`.
 *
 * Pure logic, no network. `mapAuthError` is a total function from a thrown value
 * to a typed error, and every claim its comments make is checkable here.
 *
 * ── THE EXPECTATION TABLE IS A SECOND EXPRESSION, NOT A COPY ─────────────────
 *
 * The switch in `mapAuthError` is module-private; the kinds, statuses and retry
 * flags below are restated from the design rather than imported. A test that
 * read the mapping out of the module and asserted it equalled itself would pass
 * under every mutation. Editing one side and not the other is meant to fail.
 *
 * ── THE THREE CLAIMS THIS FILE EXISTS FOR ───────────────────────────────────
 *
 *   1. AN UNRECOGNISED FAILURE DOES NOT BECOME "WRONG PASSWORD". That is the
 *      tempting default — `invalid_credentials` is by far the commonest real
 *      case — and it is the harmful one: it sends someone to re-type a password
 *      that was never the problem, and to reset a password that was correct.
 *      The sweep below asserts `unknown_auth` for a set of codes and shapes the
 *      mapper has never heard of, with the recognised codes in the same sweep so
 *      the comparison is demonstrably live.
 *
 *   2. "EMAIL NOT CONFIRMED" IS NOT SWALLOWED BY THE CREDENTIALS BRANCH. This
 *      is an ordering trap in the message fallback, not a hypothetical: the two
 *      remedies are opposites — one means retype, the other means there is
 *      nothing to retype and a link to click — and a message can plausibly
 *      contain both words.
 *
 *   3. ONLY RATE LIMITING IS RETRYABLE. `retryable` drives whether a UI invites
 *      another attempt. Marking a wrong password retryable produces a form that
 *      encourages guessing; marking a rate limit non-retryable produces one that
 *      tells the user to give up at the exact moment waiting would work.
 */
import { describe, expect, it } from 'vitest'
import {
  EmailNotConfirmedError,
  InvalidCredentialsError,
  RateLimitedError,
  SignupDisabledError,
  UnknownAuthError,
  WeakPasswordError,
  mapAuthError,
} from '../../src/lib/supabase/auth-errors'
import { StatesmanError, httpStatusFor, isRetryable, publicMessageFor } from '../../src/lib/supabase/errors'

interface Expectation {
  readonly code: string
  readonly kind: string
  readonly status: number
  readonly retryable: boolean
  readonly ctor: new (m: string) => StatesmanError
}

/** Restated from the design. Not imported from the module under test. */
const BY_CODE: readonly Expectation[] = [
  { code: 'invalid_credentials', kind: 'invalid_credentials', status: 401, retryable: false, ctor: InvalidCredentialsError },
  { code: 'invalid_grant', kind: 'invalid_credentials', status: 401, retryable: false, ctor: InvalidCredentialsError },
  { code: 'email_not_confirmed', kind: 'email_not_confirmed', status: 403, retryable: false, ctor: EmailNotConfirmedError },
  { code: 'signup_disabled', kind: 'signup_disabled', status: 403, retryable: false, ctor: SignupDisabledError },
  { code: 'email_provider_disabled', kind: 'signup_disabled', status: 403, retryable: false, ctor: SignupDisabledError },
  { code: 'over_request_rate_limit', kind: 'rate_limited', status: 429, retryable: true, ctor: RateLimitedError },
  { code: 'over_email_send_rate_limit', kind: 'rate_limited', status: 429, retryable: true, ctor: RateLimitedError },
  { code: 'weak_password', kind: 'weak_password', status: 422, retryable: false, ctor: WeakPasswordError },
]

/** Codes and shapes the mapper has never heard of. */
const UNRECOGNISED: readonly unknown[] = [
  { code: 'teapot', message: 'short and stout' },
  { code: 'mfa_challenge_expired', message: 'expired' },
  { error_code: 'captcha_failed', message: 'captcha failed' },
  { message: 'something went wrong' },
  {},
]

describe('mapAuthError — code-driven mapping', () => {
  it('[NFR-01] maps every modelled code to its kind, status and retry flag', () => {
    for (const e of BY_CODE) {
      const mapped = mapAuthError({ code: e.code, message: `gotrue says ${e.code}` })
      expect(mapped, `${e.code} must map to a StatesmanError`).toBeInstanceOf(StatesmanError)
      expect(mapped, `${e.code} -> ${e.ctor.name}`).toBeInstanceOf(e.ctor)
      expect((mapped as StatesmanError).kind, `${e.code} kind`).toBe(e.kind)
      expect(httpStatusFor(mapped), `${e.code} status`).toBe(e.status)
      expect(isRetryable(mapped), `${e.code} retryable`).toBe(e.retryable)
    }
  })

  it('[NFR-01] also honours the older error_code field', () => {
    const mapped = mapAuthError({ error_code: 'invalid_credentials', message: 'nope' })
    expect(mapped).toBeInstanceOf(InvalidCredentialsError)
  })

  /** CLAIM 1. The dangerous default. */
  it('[NFR-01] never maps an unrecognised failure to InvalidCredentialsError', () => {
    for (const value of UNRECOGNISED) {
      const mapped = mapAuthError(value)
      expect(mapped, `${JSON.stringify(value)} must not be read as a wrong password`).not
        .toBeInstanceOf(InvalidCredentialsError)
      expect(mapped, `${JSON.stringify(value)} -> UnknownAuthError`).toBeInstanceOf(UnknownAuthError)
      expect(isRetryable(mapped), 'an unknown failure is not retryable').toBe(false)
    }
    // The positive control for this test: the sweep above would also pass
    // against a mapper that returned UnknownAuthError for EVERYTHING, so assert
    // in the same test that a recognised code still resolves.
    expect(mapAuthError({ code: 'invalid_credentials', message: 'x' })).toBeInstanceOf(
      InvalidCredentialsError,
    )
  })

  it('[NFR-01] maps a non-object, including null and undefined, to UnknownAuthError', () => {
    for (const value of [null, undefined, 'a string', 42, true]) {
      expect(mapAuthError(value), `${String(value)}`).toBeInstanceOf(UnknownAuthError)
    }
  })

  it('[NFR-01] passes an already-mapped StatesmanError through unchanged', () => {
    const original = new InvalidCredentialsError('already mapped')
    expect(mapAuthError(original)).toBe(original)
  })
})

describe('mapAuthError — the message fallback, for responses carrying no code', () => {
  it('[NFR-01] maps GoTrue prose when no code is present', () => {
    expect(mapAuthError({ message: 'Invalid login credentials' })).toBeInstanceOf(
      InvalidCredentialsError,
    )
    expect(mapAuthError({ message: 'Email not confirmed' })).toBeInstanceOf(
      EmailNotConfirmedError,
    )
    expect(mapAuthError({ message: 'Signups not allowed for this instance' })).toBeInstanceOf(
      SignupDisabledError,
    )
    expect(mapAuthError({ status: 429, message: 'slow down' })).toBeInstanceOf(RateLimitedError)
  })

  /**
   * CLAIM 2. The ordering trap, asserted directly rather than trusted.
   *
   * A message mentioning both concepts must resolve to the unconfirmed-email
   * case, because that is the one whose remedy is not "retype your password".
   * A mapper testing 'credentials' first passes every other test in this file
   * and fails only this one.
   */
  it('[NFR-01] prefers "not confirmed" over "credentials" when a message contains both', () => {
    const mapped = mapAuthError({
      message: 'Invalid login credentials: email address is not confirmed',
    })
    expect(mapped).toBeInstanceOf(EmailNotConfirmedError)
    expect(mapped).not.toBeInstanceOf(InvalidCredentialsError)
  })

  it('[NFR-01] a code always beats the prose, so rewording GoTrue cannot change a verdict', () => {
    // `code` says rate limited; the prose says wrong password. The stable field
    // must win, which is the stated reason the switch is consulted first.
    const mapped = mapAuthError({
      code: 'over_request_rate_limit',
      message: 'Invalid login credentials',
    })
    expect(mapped).toBeInstanceOf(RateLimitedError)
  })
})

describe('mapAuthError — what reaches the user', () => {
  /** CLAIM 3, and the privacy rule: no GoTrue prose in a public message. */
  it('[NFR-01] [NFR-02] public messages are distinct per kind and leak no internals', () => {
    const seen = new Set<string>()
    for (const e of BY_CODE) {
      const mapped = mapAuthError({
        code: e.code,
        message: 'INTERNAL-GOTRUE-DETAIL-should-not-be-shown',
      })
      const publicMessage = publicMessageFor(mapped)
      expect(publicMessage, `${e.code} public message is non-empty`).not.toBe('')
      expect(
        publicMessage,
        `${e.code} public message must not echo the raw GoTrue message`,
      ).not.toContain('INTERNAL-GOTRUE-DETAIL')
      seen.add(publicMessage)
    }
    // FIVE distinct kinds across the eight codes (invalid_credentials,
    // email_not_confirmed, signup_disabled, rate_limited, weak_password), so
    // both failure shapes are caught here: collapsing the kinds to one shared
    // message drops the count below 5, and giving each CODE its own message
    // pushes it to 8.
    expect(seen.size, 'each KIND needs its own public message').toBe(5)
  })

  it('[NFR-01] the unconfirmed-email message tells the user to click the link, not to retype', () => {
    const publicMessage = publicMessageFor(mapAuthError({ code: 'email_not_confirmed', message: 'x' }))
    expect(publicMessage.toLowerCase()).toContain('confirm')
    expect(publicMessage.toLowerCase()).not.toContain('password')
  })
})
