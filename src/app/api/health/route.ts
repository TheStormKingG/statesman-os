/**
 * GET /api/health — the chain probe. A development endpoint.
 *
 * ── WHAT IT PROVES, AND WHAT IT CANNOT ──────────────────────────────────────
 *
 * `withUser` is the only data entry point `src/server/db/index.ts` exports, and
 * its body order (canon §6.1) is load-bearing here:
 *
 *   1. `await assertUnprivilegedOnce()`   <- a real query, as the app role
 *   2. `await resolveSession()`           <- throws when there is no identity
 *   3. BEGIN / set_config / eager probe / the caller's work
 *
 * Step 1 runs BEFORE step 2. So calling `withUser` from an unauthenticated
 * request opens a real connection to PostgreSQL as the configured application
 * role, executes the role-posture query against `pg_catalog`, and only then
 * refuses for want of an identity. The refusal is the proof, not a failure:
 * browser -> Next server -> PostgreSQL -> role assertion -> identity guard ->
 * back, with the guard failing closed.
 *
 * ── THE THREE THINGS IT REPORTS AS UNAVAILABLE ──────────────────────────────
 *
 * The current database name, the migration state and the posture-check result
 * each need a `select`, and there is no identity-free read path to run one:
 *
 *   - `index.ts` exports `withUser` (needs an identity), `withMigrator` and the
 *     lifecycle wrappers (which take a `UserScopedClient`). Nothing else.
 *   - `src/server/session/resolve.ts` THROWS when no identity is present, which
 *     is correct, and `enterIdentityContext` is documented for exactly two
 *     callers: the authentication middleware after a VERIFIED session lookup,
 *     and test fixtures. Calling it here would mint an unverified identity on a
 *     request path, which is the precise channel ADR-0006 closed by removing
 *     `withUser`'s session parameter. A health endpoint is not worth reopening
 *     it, so this file does not import it.
 *   - `withMigrator` is not an option twice over: `check-import-boundaries.ts`
 *     rule R3 permits importing it only from `tests/` or `scripts/`, and it
 *     refuses at runtime whenever `NEXT_RUNTIME` is set, which every Next CLI
 *     command sets.
 *   - `pool.ts` is module-private (rule R2), and its test-only allowance covers
 *     `tests/` and `scripts/` only.
 *
 * Two of the three are additionally unavailable for reasons an identity would
 * not fix, both MEASURED against this database rather than assumed:
 *
 *   - `app.verify_security_posture()` has no `EXECUTE` grant to the application
 *     role (`permission denied for function verify_security_posture`). That is
 *     the design: canon §4.8 runs it as the schema owner at the end of every
 *     migration run. The application role is not meant to be able to ask.
 *   - there is no migration ledger to read. `scripts/migrate.sh` applies
 *     `migrations/0*.sql` by lexical glob and records nothing; no
 *     `schema_migrations` table exists in any database on this cluster.
 *
 * So they are reported as `null` with a reason. Inventing a seam to fill them
 * in would trade a real guarantee for a prettier payload.
 *
 * ── DISCLOSURE ──────────────────────────────────────────────────────────────
 *
 * No connection string, host, port, password, database name, role name or role
 * list appears in any response. Database-sourced text reaches the client only
 * through `publicMessageFor`, which returns the mapped error's `publicMessage`
 * and never a driver message: `PrivilegeAssertionError`'s own `message` names
 * the offending role and database, which is why `err.message` is never used.
 */

import {
  ConfigurationError,
  PrivilegeAssertionError,
  StatesmanError,
  UnauthenticatedError,
  publicMessageFor,
  withUser,
} from '@/server/db'

/**
 * `pg` is a Node library, so this handler cannot run on the edge runtime.
 * Stated rather than inherited from the default.
 */
export const runtime = 'nodejs'

/**
 * Without this, Next prerenders a route handler that uses no dynamic API at
 * build time. `next build` would then open a database connection and bake one
 * verdict into a static response, so the "health" of a running server would be
 * a fact about the machine that built it.
 */
export const dynamic = 'force-dynamic'

type Probe =
  | { readonly outcome: 'identity_guard_fired' }
  | { readonly outcome: 'role_rejected'; readonly detail: string }
  | { readonly outcome: 'not_configured'; readonly detail: string }
  | { readonly outcome: 'database_unreachable'; readonly detail: string }
  | { readonly outcome: 'guard_did_not_fire' }
  | { readonly outcome: 'unexpected'; readonly kind: string; readonly detail: string }

/**
 * Whether this process has already seen the role assertion resolve.
 *
 * `assertUnprivilegedOnce` caches its verdict for the lifetime of the process,
 * so the FIRST successful probe is the one that actually talks to PostgreSQL
 * and every later probe reuses that verdict without any database contact. The
 * response says which of the two happened, because "the database is reachable"
 * and "the database was reachable once, at some earlier point" are different
 * claims and only one of them is true on the second request.
 */
let roleAssertionSeen = false

function errorCodeOf(err: unknown): string {
  if (err instanceof Error && 'code' in err && typeof err.code === 'string') {
    return err.code
  }
  return 'unknown'
}

async function probeDataPath(): Promise<Probe> {
  try {
    // A no-op body: the round trip and the guards are the whole point, and the
    // callback is never reached because `resolveSession` rejects first. Not an
    // `async` arrow, which would be an async function with nothing to await.
    await withUser(() => Promise.resolve(null))
    // Reaching here means an identity existed on an unauthenticated request.
    return { outcome: 'guard_did_not_fire' }
  } catch (err: unknown) {
    if (err instanceof UnauthenticatedError) return { outcome: 'identity_guard_fired' }
    if (err instanceof PrivilegeAssertionError) {
      return { outcome: 'role_rejected', detail: publicMessageFor(err) }
    }
    if (err instanceof ConfigurationError) {
      return { outcome: 'not_configured', detail: publicMessageFor(err) }
    }
    if (err instanceof StatesmanError) {
      return { outcome: 'unexpected', kind: err.kind, detail: err.publicMessage }
    }
    // Not a StatesmanError: the failure happened below the mapped layer, which
    // for this path means the connection itself. The driver's error code is
    // the useful signal and carries no credential.
    return { outcome: 'database_unreachable', detail: errorCodeOf(err) }
  }
}

const UNAVAILABLE = {
  currentDatabase:
    'Requires a database read. The only read path is withUser, which requires a verified ' +
    'session, and sign in is not built yet.',
  migrationState:
    'No migration ledger exists to read. scripts/migrate.sh applies migrations/0*.sql by ' +
    'lexical glob and records nothing; there is no schema_migrations table.',
  postureCheck:
    'app.verify_security_posture() has no EXECUTE grant to the application role, by design ' +
    '(canon 4.8: it runs as the schema owner at the end of every migration run).',
} as const

const CACHING_NOTE =
  'assertUnprivilegedOnce caches its verdict per process. Only a request reported as ' +
  'performed_in_this_request opened a database connection; a cached_in_process request ' +
  'made no database contact at all.'

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

export async function GET(): Promise<Response> {
  // A development endpoint. It refuses in production rather than merely being
  // undocumented there, and answers 404 so it does not advertise itself.
  if (process.env['NODE_ENV'] === 'production') {
    return jsonResponse({ error: 'not_found' }, 404)
  }

  const probeWasCold = !roleAssertionSeen
  const probe = await probeDataPath()
  if (probe.outcome === 'identity_guard_fired') {
    roleAssertionSeen = true
  }

  const roundTrip = probeWasCold ? 'performed_in_this_request' : 'cached_in_process'

  const base = {
    service: 'statesman-os',
    mode: 'development-shell',
    note: CACHING_NOTE,
    unavailable: UNAVAILABLE,
  }

  switch (probe.outcome) {
    case 'identity_guard_fired':
      return jsonResponse(
        {
          ...base,
          ok: true,
          chain: [
            'browser -> Next server: this handler ran',
            'Next server -> PostgreSQL: role posture query executed as the application role',
            'PostgreSQL -> role assertion: passed',
            'identity guard: refused, no verified session',
          ],
          checks: {
            nextServer: { ok: true },
            databaseRoundTrip: { ok: true, roundTrip },
            unprivilegedRole: {
              ok: true,
              basis:
                'assertUnprivilegedOnce passed: the connected role is not a superuser, does ' +
                'not hold BYPASSRLS, owns no relation in schema public, and cannot SET ROLE ' +
                'to any privileged role.',
            },
            identityGuard: {
              failsClosed: true,
              basis: 'withUser rejected with UnauthenticatedError before opening a transaction.',
            },
          },
        },
        200,
      )

    case 'role_rejected':
      return jsonResponse(
        {
          ...base,
          ok: false,
          checks: {
            nextServer: { ok: true },
            databaseRoundTrip: { ok: true, roundTrip },
            unprivilegedRole: { ok: false, reason: probe.detail },
            identityGuard: { failsClosed: null, reason: 'not reached' },
          },
        },
        503,
      )

    case 'not_configured':
      return jsonResponse(
        {
          ...base,
          ok: false,
          checks: {
            nextServer: { ok: true },
            databaseRoundTrip: { ok: false, reason: probe.detail },
            unprivilegedRole: { ok: null, reason: 'not reached' },
            identityGuard: { failsClosed: null, reason: 'not reached' },
          },
        },
        503,
      )

    case 'database_unreachable':
      return jsonResponse(
        {
          ...base,
          ok: false,
          checks: {
            nextServer: { ok: true },
            databaseRoundTrip: { ok: false, errorCode: probe.detail },
            unprivilegedRole: { ok: null, reason: 'not reached' },
            identityGuard: { failsClosed: null, reason: 'not reached' },
          },
        },
        503,
      )

    case 'guard_did_not_fire':
      // Security-relevant: an unauthenticated request carried an identity.
      return jsonResponse(
        {
          ...base,
          ok: false,
          checks: {
            nextServer: { ok: true },
            databaseRoundTrip: { ok: true, roundTrip },
            unprivilegedRole: { ok: true },
            identityGuard: {
              failsClosed: false,
              reason:
                'withUser resolved on an unauthenticated request, which means an identity was ' +
                'present where there should be none.',
            },
          },
        },
        500,
      )

    default:
      return jsonResponse(
        {
          ...base,
          ok: false,
          checks: {
            nextServer: { ok: true },
            databaseRoundTrip: { ok: null, reason: 'indeterminate' },
            unprivilegedRole: { ok: null, reason: 'indeterminate' },
            identityGuard: { failsClosed: null, reason: 'indeterminate' },
          },
          error: { kind: probe.kind, detail: probe.detail },
        },
        500,
      )
  }
}
