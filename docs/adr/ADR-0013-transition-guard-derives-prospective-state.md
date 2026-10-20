# ADR-0013: The transition guard derives the prospective state; it never reads `NEW.state`

**Status:** Accepted | **Date:** 2026-10-20

## Context

`decision.state` is a `GENERATED ALWAYS AS … STORED` column derived from five milestone
timestamps (ADR-0004, canon §4.4). Illegal lifecycle transitions must fail loudly and
classifiably, which means a `BEFORE UPDATE` trigger raising a custom SQLSTATE rather than an RLS
clause affecting zero rows (ADR-0004, V7).

The obvious trigger body is a whitelist of `OLD.state → NEW.state` pairs. Written that way it
compiles, installs, fires on every update, and does nothing:

> **V28, reproduced on this cluster:** `NEW.<col>` is **NULL** in a `BEFORE UPDATE` trigger when
> that column is `GENERATED`. The probe printed `BEFORE: OLD.state=[draft] NEW.state=[<NULL>]`,
> while the `AFTER` trigger on the same update correctly reported `[submitted]`.

So the comparison is against NULL on every transition. Depending on how the whitelist is phrased,
the guard permits everything or rejects everything — and the SQL reads correctly either way. The
generated column is what makes `NEW.state` NULL, and nothing in the trigger text, the error
output or the catalog points at it.

## Decision

**One `IMMUTABLE` derivation function, used twice.** `app.derive_decision_state()` is the sole
definition of what the state is. The generated column calls it; the `BEFORE UPDATE` trigger calls
it again on `NEW`'s timestamps to obtain the **prospective** state, and compares
`OLD.state → prospective` against the whitelist.

```sql
-- the single definition (canon §4.4): per-branch enum casts, never a cast of the CASE result (V12)
create function app.derive_decision_state(
  p_submitted timestamptz, p_challenged timestamptz, p_reflected timestamptz,
  p_action timestamptz, p_closed timestamptz
) returns app.decision_state language sql immutable as $$ … $$;

-- used by the column
state app.decision_state generated always as (
  app.derive_decision_state(submitted_at, challenged_at, reflected_at,
                            action_recorded_at, closed_at)) stored

-- used by the guard: derive, never read NEW.state
declare v_next app.decision_state := app.derive_decision_state(
  new.submitted_at, new.challenged_at, new.reflected_at,
  new.action_recorded_at, new.closed_at);
begin
  if not (old.state, v_next) in ( …whitelist… ) then
    raise exception 'illegal transition % -> %', old.state, v_next
      using errcode = 'ST001';                        -- uppercase SQLSTATE (V13)
  end if;
```

**The trigger must never reference `NEW.state`.** That is the whole content of this decision.

Two facts make it work, and both were established by execution against this cluster rather than
reasoned about:

- **V29** — an `IMMUTABLE` user-defined SQL function **is** accepted inside a
  `GENERATED ALWAYS AS … STORED` expression, and the same function can derive the prospective
  state inside the `BEFORE UPDATE` trigger. Reproduced end to end: the legal transition was
  permitted and the illegal one raised `ST001`.
- **V28** — the NULL behaviour above, which is what rules out the original design.

V29 also supersedes the inline-`CASE` approach that V12 left in place: one definition now serves
both the column and the guard, so **they cannot drift**.

**Required control.** A meta-test over **all 32 combinations** of the five milestone timestamps,
asserting that the function's result and the stored column agree for every combination. Without
it, the two call sites can diverge silently — the column is maintained by the planner and the
guard by the trigger, and a disagreement shows up as a transition that is permitted by one and
denied by the other.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **The original design: a `BEFORE UPDATE` trigger whitelisting `OLD.state → NEW.state` pairs** | V28: `NEW.state` is NULL in `BEFORE UPDATE` on a generated column, so every comparison is against NULL and the guard permits everything or rejects everything. Recorded here deliberately, because it is the form a competent implementer writes from the lifecycle diagram, it looks correct in review, and it is **inert** — a transition test written against it passes for the wrong reason, and the only thing that distinguishes a working guard from this one is executing an illegal transition and watching it be refused. |
| An `AFTER UPDATE` trigger instead, where `NEW.state` is populated (V28) | It would refuse correctly — raising in `AFTER UPDATE` still aborts the transaction. Rejected for a weaker but real reason: the derivation function is needed anyway for the generated column, so deriving in `BEFORE` costs nothing extra and keeps one definition, whereas an `AFTER` guard reads a second source of truth and fires after every other `BEFORE` trigger and constraint has already acted, making the error a reader sees depend on ordering. |
| Drop the generated column; write `state` explicitly on each transition | Reintroduces two definitions of the same rule — the column's value and the guard's expectation — which is exactly the drift this ADR removes. It also makes `state` writable by any path that holds an UPDATE grant. |
| Keep the inline `CASE` in the generation expression and repeat it in the trigger | V12 settled the per-branch casts, but two copies of the same `CASE` will diverge. V29 shows one `IMMUTABLE` function is accepted in both places, so there is no reason to copy it. |
| Compare the milestone timestamps directly in the trigger, with no function | A second expression of the same rule in a different shape. The 32-combination meta-test would then be asserting agreement between two hand-written bodies rather than between one function and its own stored output. |
| Enforce transitions in RLS `USING` instead of a trigger | ADR-0004 / V7: a failing `USING` clause affects zero rows and raises nothing, making 404 and 409 indistinguishable. |

## Consequences

**Positive.** The state definition exists once. An illegal transition raises a distinct uppercase
SQLSTATE the API maps to a specific HTTP status, and the guard's correctness is demonstrable by
executing a refused transition rather than inferred from the trigger text.

**Negative.** The function's parameter list is positional and must stay aligned with the column
list in the generation expression and in the trigger — three call sites of one signature. Adding
a sixth milestone means editing all three and doubling the meta-test to 64 combinations. The
trigger also cannot reuse the already-computed column value, so the derivation runs twice per
update; it is a pure five-argument `CASE`, and that cost is accepted.

**What this now requires.** `app.derive_decision_state()` created before the table that generates
from it; the `BEFORE UPDATE` guard with no reference to `NEW.state`; the 32-combination meta-test;
a per-transition test asserting the specific SQLSTATE for each illegal pair, each with the paired
positive control of ADR-0009 — a guard that never fires is indistinguishable from one that always
permits, and this is the decision that proves that is not a hypothetical.

**Status:** PLANNED / NOT RUN. The two behaviours this decision rests on (V28, V29) were
reproduced during design; no migration, trigger or test for this design exists.

## Evidence

- **V28** — `NEW.<col>` is NULL in a `BEFORE UPDATE` trigger when that column is `GENERATED`; reproduced as `BEFORE: OLD.state=[draft] NEW.state=[<NULL>]` against `AFTER`'s `[submitted]`. The driving fact.
- **V29** — an `IMMUTABLE` user-defined SQL function is accepted in a `GENERATED ALWAYS AS … STORED` expression and can derive the prospective state in the `BEFORE UPDATE` trigger; reproduced end to end, legal transition permitted and illegal transition raising `ST001`. Supersedes the inline-`CASE` approach of V12.
- **V12** — per-branch enum casts are required; a cast of the `CASE` result is rejected as not immutable (`enum_in` is `STABLE`).
- **V13** — lowercase custom SQLSTATEs silently resolve to `42704`, so every transition code is uppercase and round-trip tested.
- **V7** — a failing RLS `USING` clause affects zero rows and raises nothing, which is why the guard is a trigger at all (ADR-0004).
