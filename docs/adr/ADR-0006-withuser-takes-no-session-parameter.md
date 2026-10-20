# ADR-0006: `withUser` takes no session parameter and returns a branded client

**Status:** Accepted | **Date:** 2026-10-20

## Context

`withUser` is the single place where user identity enters SQL; everything downstream — policies,
composite foreign keys, triggers — derives tenancy from the one value it sets into
`app.current_user_id`. The conventional shape is `withUser(session, fn)`: the route handler
resolves the session and passes it down, which is explicit, testable and easy to type.

That shape is a hole through every layer at once. A handler that takes an id from a request
parameter rather than from the cookie **type-checks perfectly**, and RLS then faithfully enforces
the attacker's chosen identity. No policy is violated, no trigger fires, no type is wrong, and
every component behaves exactly as specified. Nothing is left to detect it.

## Decision

```ts
// the ONLY exported data entry points; the Pool is module-private
export async function withUser<T>(fn: (db: UserScopedClient) => Promise<T>): Promise<T>
export async function withMigrator<T>(userId: string, fn: (db: Client) => Promise<T>): Promise<T>
```

`withUser` takes **no session parameter**. It calls `requireSession()` itself. Removing the
parameter removes the channel.

`AuthenticatedSession` and `UserScopedClient` are branded with a `unique symbol` producible only
inside `requireSession`/`withUser`. Because a brand is erasable with one assertion,
`as AuthenticatedSession` and `as UserScopedClient` are additionally banned by an AST check in
CI.

`withUser` body, in order: `await assertUnprivilegedOnce()` (a cached promise, so every path
validates the connection's role once per process, independent of framework lifecycle hooks) →
`BEGIN` → `select set_config('app.current_user_id', $1, true)` → `select app.require_user_id()`
as **eager validation** → the caller's work → `COMMIT`/`ROLLBACK` → `finally`: `DISCARD ALL`,
then release. `statement_timeout` is set via `set_config($1,$2,true)` with a Zod-validated
number, so transaction setup interpolates **zero** values.

## Alternatives considered

| Option | Why rejected |
|---|---|
| `withUser(session, fn)` — pass `AuthenticatedSession` as an argument | Type-checks when handed a victim's id, and RLS then enforces the attacker's chosen identity. Every layer does its job and the breach is invisible. |
| Ambient identity via framework middleware or `AsyncLocalStorage`, set outside the guard | Lifecycle-dependent: a path that skips the middleware still obtains a connection. V1 and V3 require role identity to be asserted in the data path, which is why `assertUnprivilegedOnce` lives inside `withUser`. |
| Skip the extra `app.require_user_id()` round trip | V6: with no context set, a select on a nonexistent id returns rc=0, zero rows and no error — the policy raises only when a candidate row reaches the qual. Context failure would be silent for whole query shapes. |
| Branded types without the AST ban on `as` | One assertion forges a `UserScopedClient`; the brand is erasable by design. |
| `no-restricted-imports`, or a grep for `new Pool(`, to keep `pg` out of app code | `no-restricted-imports` matches the *specifier string*, not the resolved path, and the grep is evaded by an alias. Neither is sufficient alone, so an AST script over the TypeScript API checks static imports, `require` and dynamic `import()`. |
| Trust `current_setting('app.current_user_id', true)` directly in policies | V5: a transaction-local GUC reverts to the **empty string**, not NULL, and `''::uuid` raises a cast error. The raising accessor `app.require_user_id()` is used instead. |
| An env-gated rollback branch inside `withUser` for test isolation | Canon §8.3: production code carries no `process.env` reference and no rollback path; isolation is injected by test-only code through an optional provider. |

## Consequences

**Positive.** The identity channel does not exist, so a future handler cannot misuse it.
`DISCARD ALL` in `finally` makes a mistaken `is_local=false` inert rather than merely tested-for.

**Negative.** One extra round trip per transaction, accepted deliberately for loudness. Test
transaction isolation needs a test-only provider plus a unit test asserting production code has
no env-gated rollback path, and the brand means the type cannot be constructed in tests without
going through the real guard.

**Residual, and not resolved by this ADR.** `withMigrator` still takes a `userId` argument — the
exact shape rejected above, surviving on the privileged path. It is not reachable from a request
handler, but the argument that justifies `withUser`'s signature does not extend to it, and the
canon does not say why. The implementation plan must either constrain `withMigrator`'s call sites
structurally or record why the channel is acceptable there.

**Status:** PLANNED. No guard, brand or AST check exists yet.

## Evidence

- **V1** — `trust` local auth and a BYPASSRLS login role: a typo'd `DATABASE_URL` username connects successfully as whatever role it names, so the role must be asserted at runtime.
- **V3** — a role that is a *member* of a BYPASSRLS role passes an `rolbypassrls` check while `SET ROLE` to it succeeds; `assertUnprivilegedOnce` must test reachability via `pg_has_role(…, 'MEMBER')`.
- **V5** — a transaction-local GUC reverts to the empty string, not NULL, at COMMIT.
- **V6** — with no context set, a select on a nonexistent uuid returns rc=0, zero rows, no error. The reason for eager validation.
- **V22** — a temp table shadows an unqualified reference to a real table; `search_path` is pinned and everything is schema-qualified.
