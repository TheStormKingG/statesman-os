/**
 * TEST-ONLY (ADR-0015). Was src/server/db|src/server/session; it has no production
 * role now that the app talks to Supabase from the browser. See ./index.ts for
 * what moved, why, and the GUC incompatibility with supabase/migrations/.
 *
 * Session resolution. The ONLY way `withUser` learns who the caller is.
 *
 * Slice 1b replaces the body of `resolveSession` with the real cookie ->
 * `app.resolve_session(token_hash)` lookup. What must not change is the shape:
 *
 *   - `resolveSession()` takes no arguments and reads an ambient context;
 *   - it THROWS when there is no identity. It never returns null, so there is no
 *     falsy value for a caller to mishandle into an unscoped query;
 *   - `AuthenticatedSession` is branded, so an arbitrary `{ userId }` object
 *     cannot be passed where a resolved session is required.
 *
 * Why the identity is ambient rather than a parameter (ADR-0006): a data path
 * that accepts an identity argument type-checks perfectly when it is handed a
 * victim's id, and RLS then faithfully enforces the attacker's chosen identity.
 * Removing the parameter removes the channel. `withUser` therefore has no
 * session parameter and calls this module itself.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import { UnauthenticatedError } from './errors'

/**
 * `declare const` means this symbol has NO runtime value: there is no brand
 * constructor to export, import or call. The type can only be produced by the
 * single assertion below, inside this module. CI additionally bans
 * `as AuthenticatedSession` outside this file (canon 6.1).
 */
declare const sessionBrand: unique symbol

export type AuthenticatedSession = {
  readonly userId: string
  readonly [sessionBrand]: 'AuthenticatedSession'
}

/**
 * 8-4-4-4-12 hex, NOT `z.uuid()`.
 *
 * VERIFIED by execution against the installed zod@4.6.7: `z.uuid()` enforces an
 * RFC 9562 version nibble `[1-8]` and variant nibble `[89abAB]`, and therefore
 * REJECTS this project's own seeded identities
 * (`aaaaaaaa-0000-0000-0000-000000000001`,
 * `bbbbbbbb-0000-0000-0000-000000000002`), which `z.guid()` accepts. Postgres's
 * `uuid` type accepts any 8-4-4-4-12 hex string, so a validator stricter than
 * the column it feeds rejects values the database considers legal. `z.guid()` is
 * the shape that matches the column.
 */
const userIdSchema = z.guid()

const identityStorage = new AsyncLocalStorage<string>()

/**
 * Establish the request's identity for the duration of `fn`.
 *
 * ONLY two callers are legitimate:
 *   1. the authentication middleware (Slice 1b), AFTER it has verified a session
 *      token against `app.resolve_session`;
 *   2. test fixtures.
 *
 * The id passed here MUST be the output of a verified session lookup. Passing a
 * request-supplied value — a header, a query parameter, a JSON body field —
 * hands the caller any identity they ask for. This is the one place in the data
 * path where that is possible, which is exactly why the identity is set once at
 * the edge and read ambiently everywhere after.
 */
export function enterIdentityContext<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const parsed = userIdSchema.safeParse(userId)
  if (!parsed.success) {
    throw new UnauthenticatedError('identity offered to enterIdentityContext is not a uuid')
  }
  return identityStorage.run(parsed.data.toLowerCase(), fn)
}

/**
 * True when an identity context is open. Used by `withMigrator` to refuse a
 * privileged connection on a path that has already been identified as a request.
 */
export function isIdentityContextActive(): boolean {
  return identityStorage.getStore() !== undefined
}

/**
 * The caller's identity, or a rejected `UnauthenticatedError`.
 *
 * RETURNS A PROMISE because Slice 1b's implementation queries the database.
 * Keeping the Promise-returning signature now means the call sites do not change
 * then. It is deliberately not declared `async`: there is nothing to await yet,
 * and an `async` function with no `await` is what `require-await` flags. The
 * observable contract is identical — every failure arrives as a REJECTION, not a
 * synchronous throw, so `resolveSession().catch(...)` behaves as before. When the
 * database call lands, this becomes `async` again and the explicit
 * `Promise.resolve`/`Promise.reject` wrappers come back out.
 */
export function resolveSession(): Promise<AuthenticatedSession> {
  const raw = identityStorage.getStore()
  if (raw === undefined) {
    return Promise.reject(new UnauthenticatedError('no identity in the current context'))
  }
  const parsed = userIdSchema.safeParse(raw)
  if (!parsed.success) {
    // Unreachable through enterIdentityContext, which validates on the way in.
    // Re-checked here so the value handed to set_config is validated at the
    // point of use rather than on trust in a distant caller.
    return Promise.reject(
      new UnauthenticatedError('identity in the current context is not a uuid'),
    )
  }
  // AST-ALLOW(brand-mint): the sole mint site for AuthenticatedSession.
  return Promise.resolve({ userId: parsed.data.toLowerCase() } as AuthenticatedSession)
}
