# ADR-0004: RLS carries tenancy only; state and immutability live in triggers

**Status:** Accepted | **Date:** 2026-10-20

## Context

`MASTER_PROMPT.md` §6 requires server-side guards on the lifecycle
`scenario_available → draft → submitted_locked → challenged → reflected → action_recorded →
reviewed/closed`, with illegal transitions failing **predictably**, and FR-04 requires submitted
versions to be immutable. RLS looks like the natural place for both: a `USING` clause could
restrict updates to rows still in `draft`.

It cannot. **A failing RLS `USING` clause affects zero rows and raises nothing** — reproduced
three ways (V7). The transition is blocked, but the caller gets the same result as a query against
a row that does not exist, so the API cannot distinguish 404 from 409 and a user editing their own
submitted decision is told it was not found. A row count of 0 is not a reliable denial signal
either: a cross-user `DELETE` with no DELETE policy returns `DELETE 0` byte-identically to
deleting a nonexistent id (V19).

## Decision

**Policies carry tenancy and nothing else**, in both `USING` and `WITH CHECK`, with the `TO`
clause omitted (ADR-0003):

```sql
create policy decision_tenancy on public.decision
  using (user_id = app.require_user_id())
  with check (user_id = app.require_user_id());
```

State and immutability live in the schema and in triggers:

- **State** is a `GENERATED ALWAYS AS (app.derive_decision_state(…)) STORED` column derived from
  the five milestone timestamps by one `IMMUTABLE` function, with **per-branch** enum casts,
  never a cast of the `CASE` result (V12). An `IMMUTABLE` user-defined function is accepted in a
  stored generation expression (V29).
- **Transitions** are validated in a `BEFORE UPDATE` trigger that derives the **prospective**
  state by calling that same `app.derive_decision_state()` on `NEW`'s timestamps, then permits
  only whitelisted `OLD.state → prospective` pairs, raising **uppercase** custom SQLSTATEs (V13)
  that the API maps to distinct HTTP statuses — this is what makes an illegal transition loud
  and classifiable.

  > **The trigger must never read `NEW.state`.** It is NULL in `BEFORE UPDATE` on a generated
  > column (V28), so a trigger that reads it compares against NULL on every transition and
  > therefore permits everything or rejects everything. One function serves both the column and
  > the guard, so the two cannot drift. Recorded in full as ADR-0013, with the required control:
  > a meta-test over all 32 combinations of the five timestamps asserting that the function's
  > result and the stored column agree.
- **Immutability** of a submitted revision rests on three independent layers: `BEFORE UPDATE OR
  DELETE` triggers, `BEFORE TRUNCATE … FOR EACH STATEMENT` (V15), and absent grants.
- **Every privileged write asserts its row count**, because silence is not success (V7):

```sql
get diagnostics n = row_count;
if n <> 1 then raise exception 'transition did not apply' using errcode = 'ST005'; end if;
```

`app.require_user_id()` must remain `STABLE`. An `IMMUTABLE` variant was proven to let a prepared
statement leak one user's rows to another from the second execution onward, so the catalog
assertion `provolatile = 's'` is the primary gate — it cannot be scheduled away.

## Alternatives considered

| Option | Why rejected |
|---|---|
| State predicates in policy `USING` / `WITH CHECK` | V7: the clause raises nothing and affects zero rows, making 404 and 409 indistinguishable and leaving the user with "not found" for their own record. |
| Application-layer transition checks only, no triggers | A direct SQL session or one forgotten write path bypasses them. The invariant must hold where the data is, since grants and triggers apply even when the API is wrong. |
| Cast the `CASE` result to the enum in the generated column | V12: rejected outright — *generation expression is not immutable* (`enum_in` is STABLE). Per-branch literals constant-fold. |
| Lowercase custom SQLSTATEs (e.g. `'st010'`) | V13: silently resolves to `42704`, so the API maps a specific transition error to a generic failure. All SQLSTATEs uppercase and round-trip tested. |
| Treat a 0 row count as proof the guard fired | V7 and V19: zero rows distinguishes neither denial from absence nor success from refusal. |
| A `BEFORE UPDATE` trigger comparing `OLD.state → NEW.state` | V28: `NEW.state` is NULL in `BEFORE UPDATE` on a generated column, so the comparison is against NULL on every transition and the trigger is inert while looking correct. Recorded in full as ADR-0013. |
| Row-level triggers alone for immutability | V15: `TRUNCATE` bypasses row-level `BEFORE UPDATE/DELETE` triggers entirely; statement-level truncate triggers plus `REVOKE TRUNCATE` are required. |
| `IMMUTABLE` `app.require_user_id()` for plan-caching | Proven to leak one user's rows to another from the second execution of a prepared statement. |

## Consequences

**Positive.** Every refusal has a distinct, mappable error code instead of an empty result set.
Tenancy and lifecycle are separately testable, and policies stay simple enough to audit by eye.

**Negative.** The trigger set is a security surface of its own, so each trigger needs the paired
positive control of ADR-0009 — a trigger that never fires is indistinguishable from one that
always permits. `TRUNCATE` must be revoked from `statesman_app` on every immutable table (posture
rule 7), which also means the harness cannot truncate between tests.

**Open design point.** `decision` grants `update (draft_payload)` only, and `draft_updated_at` is
set by a trigger, so the app role cannot write `submitted_at` and the other milestone timestamps
that the generated `state` column derives from. The canon does not name the privileged path that
writes them. This must be settled in the implementation plan before the submission slice.

**Status:** PLANNED / NOT RUN.

## Evidence

- **V7** — a failing `USING` clause affects zero rows and raises nothing (reproduced three ways). The driving fact.
- **V19** — cross-user `DELETE` under RLS returns `DELETE 0` with no error, byte-identical to deleting a nonexistent id.
- **V12** — per-branch enum casts required inside a stored generated column.
- **V28** — `NEW.state` is NULL in a `BEFORE UPDATE` trigger on a generated column (`BEFORE: OLD.state=[draft] NEW.state=[<NULL>]`, while `AFTER` reports `[submitted]`), so a transition trigger must never read it.
- **V29** — an `IMMUTABLE` user-defined SQL function is accepted in a `GENERATED ALWAYS AS … STORED` expression and can derive the prospective state inside the trigger; reproduced end to end, legal transition permitted and illegal transition raising `ST001`.
- **V13** — lowercase custom SQLSTATEs silently resolve to `42704`.
- **V15** — `TRUNCATE` bypasses row-level update/delete triggers.
- **V5, V6** — the context accessor must raise rather than return the empty string, and must be validated eagerly (see ADR-0006).
