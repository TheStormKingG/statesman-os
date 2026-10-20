# ADR-0012: Session resolution in Route Handlers

**Status:** Proposed | **Date:** 2026-10-20

> **This is a stub.** It exists so that the forward references to ADR-0012 resolve to a file and
> the `docs:check` gate can pass before the question is answered. It records the question, the
> experiment that answers it, and the interim behaviour — not a decision.

## Context

`requireSession()` is called on every request, and the obvious optimisation is to wrap it in
React's `cache()` so one request resolves the session once. Server Components run inside a render
context, where `cache()`'s per-pass memoisation is the documented behaviour. **Route Handlers do
not** — and the session is resolved there too, including by the export route that dumps a full
journal (canon §9, open item O2).

If `cache()` outside a render context degrades to something process-wide rather than per-request,
two concurrent requests from different users can share one resolved session. That is identity
crossover at the single worst place in the system: `withUser` would then set
`app.current_user_id` to the wrong user and RLS would faithfully enforce the wrong identity —
the hole ADR-0006 closes on the argument-passing side, reopened by a cache.

Canon open item O4 forbids settling framework behaviour from memory or documentation. This one is
also not settleable by reading: the answer depends on the installed Next.js and React release.

## Decision

**Not yet taken.** The question is settled by command first:

1. Put a `randomUUID()` in the **uncached** session-resolution implementation.
2. Fire **two concurrent requests** for different users against a Route Handler.
3. The printed ids **must differ**. If they do not, the cache is shared across requests.

If the ids differ, `cache()` may stay on the Route Handler session path and this ADR records the
observed output and the exact installed Next.js and React versions. If they do not, `cache()` is
removed from that path and the session is resolved explicitly per handler.

**Interim behaviour, in force until this ADR records a result:** the export route resolves the
session explicitly per handler, with no `cache()`. The probe is a **blocking** gate until its
output is recorded here.

## Alternatives considered

| Option | Why rejected, or why still open |
|---|---|
| Assume per-request semantics from the React documentation | O4: framework behaviour is settled by command against the installed release, never from memory or from docs describing a different context. The failure mode here is silent cross-user identity, so an assumption is the one thing that cannot be afforded. |
| Remove `cache()` from every session path unconditionally, without probing | **Still open** — this is the fallback if the probe shows shared ids, and the interim behaviour already. Its cost is one extra `resolve_session` round trip per call site that resolves twice. Choosing it without probing would leave O2 unsettled for Server Components too. |
| A module-level `Map` keyed by the token hash | Invents a cache whose lifetime nobody controls, in a module that outlives the request. It replaces an unsettled framework behaviour with a hand-written one that has the same hazard and no probe. |
| `AsyncLocalStorage` keyed per request | More machinery than the probe may show is needed, and another thing to test. Reconsider only if the probe fails *and* per-handler resolution proves to cost something measurable. |

## Consequences

Until the probe runs, the Route Handler session path is the un-optimised one, which is the safe
direction. Nothing about `cache()` may be asserted in any other document until this file records
an observed result.

**Status:** PROPOSED / NOT RUN. The probe has not been executed and no result is recorded here.

## Evidence

- Canon §9 **O2** — React `cache()` outside a render context, used for session resolution in Route Handlers including the full-journal export route; settle empirically before relying on it.
- Canon §9 **O4** — framework and library assertions are settled by command against installed tooling before use, never from memory, and recorded in the ADR that cites them.
- No V-fact bears on this decision. The verified-facts register covers the database; this is a framework question, and it is open precisely because nothing has been executed against it.
