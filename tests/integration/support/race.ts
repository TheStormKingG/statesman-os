/**
 * tests/integration/support/race.ts — the concurrency instruments.
 *
 * THE PROBLEM THIS FILE EXISTS TO SOLVE (canon §8.4)
 * --------------------------------------------------
 * A concurrency test is the easiest kind of test to fake. Two sequential
 * `await`s read like a race in the source and are not one: the second statement
 * begins after the first transaction has already committed, so nothing ever
 * contends and every assertion about serialisation passes vacuously. Worse, the
 * usual instrument for "did the follower contend?" is a read of
 * `pg_stat_activity`, and V24 established that a non-privileged observer gets
 * one row per pid with `state` and `wait_event_type` **NULL** — so "I cannot
 * observe" is reported as "it never blocked", in exactly the direction that
 * reads healthy.
 *
 * Every instrument here therefore carries its own falsification:
 *
 *   - `waitForBlockDetail` reports `observedState`, which is true only if the
 *     observer ever read a NON-NULL `state` for that backend. A `blocked:false`
 *     with `observedState:false` is not a negative result, it is a blind
 *     instrument, and the suite treats the two differently.
 *   - `observeSimultaneousTransactions` proves overlap from a THIRD connection,
 *     at one instant, without reference to locks — because V23 showed an
 *     unguarded read-then-write overlaps perfectly while never waiting on a
 *     lock. Lock-wait detection answers "does the guarded path serialise?";
 *     it cannot answer "were these two transactions concurrent?".
 *   - `readOwnTxWindow` + `windowsOverlap` give a second, privilege-free overlap
 *     proof: a backend always sees its own `pg_stat_activity` row in full
 *     (measured on this cluster as `authenticated`), so `xact_start` and a
 *     closing `clock_timestamp()` bound each transaction's real lifetime.
 *
 * WHY THE OBSERVER IS A SEPARATE, PRIVILEGED psql CONNECTION
 * ----------------------------------------------------------
 * Two constraints meet here. First, `pg` may be imported only from
 * `tests/support/scoped-pg/**` (canon §6.1, enforced by `npm run boundaries`), so the
 * harness cannot open its own driver connection — `db.ts` already talks to
 * Postgres through psql for this reason and this module does the same. Second,
 * V24: an unprivileged reader of `pg_stat_activity` is shown NULLs for
 * `state`/`wait_event_type`, so the observer is the bootstrap admin role that
 * `db.ts` already uses for CREATE/DROP DATABASE.
 *
 * MEASURED REFINEMENT of that second reason, recorded because this file had it
 * wrong first: the restriction is ROLE-SCOPED. `authenticated` sees another
 * `authenticated` backend in FULL, including a live `Lock` wait, and sees only
 * NULLs for a backend of a different role. Both race parties here connect as
 * `authenticated` (ADR-0015 §8.3), so the app role would have worked as the
 * observer. The admin role is used anyway because that visibility is a property
 * of the parties' roles, not of the instrument: a future test parking a
 * `postgres` transaction would otherwise be told "never blocked", silently and
 * in the direction that reads healthy. `parkForeignRoleBackend` below lets the
 * suite assert both halves instead of arguing for either.
 *
 * That is a privileged connection in a test, which canon §8.3 otherwise forbids
 * — and the prohibition is about the DATA path. Post-port the reason is sharper
 * than "a superuser has BYPASSRLS": so does Supabase's `postgres`, whose
 * `rolsuper` is FALSE (ADR-0015, "the trap this introduces"), so a privileged
 * connection no longer announces itself through `rolsuper` at all. This observer
 * reads `pg_catalog`/`pg_stat_activity` only; it never reads `decision`,
 * `decision_revision` or `public.profile`, and every data read in the suite
 * still goes through `runAsUser` → `withUser` as `authenticated`.
 * `observeBackends` takes the role as an argument precisely so the suite can
 * ALSO run the same read as the app role and assert V24 still holds, which is
 * what justifies the privileged observer instead of assuming it.
 */

import { randomUUID } from 'node:crypto'
import {
  appRole,
  ensureWorkerDatabase,
  ownerQuery,
  queryRows,
  runAsUser,
  workerDatabaseName,
} from './db'
import type { ScopedQueries } from '../../support/scoped-pg'

/* ------------------------------------------------------------------ *
 * Rendezvous
 * ------------------------------------------------------------------ */

/**
 * A one-shot rendezvous point. `wait()` resolves once `fire()` has been called,
 * and rejects on timeout rather than hanging the suite.
 *
 * This is the "application rendezvous" canon §8.4 requires. It is what makes
 * the interleaving a property of the TEST rather than of the scheduler: the
 * leader holds its transaction open at a known point until the test says
 * otherwise, so "the follower contended" is reproducible instead of lucky.
 *
 * `fire()` is idempotent and safe to call from a `finally`, which every test
 * here does — a failed assertion must not leave a transaction parked forever
 * waiting on a gate that is never opened.
 */
export class Gate {
  readonly name: string
  private fired = false
  private waiters: Array<() => void> = []

  constructor(name: string) {
    this.name = name
  }

  get isFired(): boolean {
    return this.fired
  }

  fire(): void {
    if (this.fired) return
    this.fired = true
    const pending = this.waiters
    this.waiters = []
    for (const resume of pending) resume()
  }

  wait(timeoutMs = 15_000): Promise<void> {
    if (this.fired) return Promise.resolve()
    return new Promise<void>((resolveWait, rejectWait) => {
      const timer = setTimeout(() => {
        rejectWait(
          new Error(
            `rendezvous timed out after ${String(timeoutMs)}ms waiting for gate '${this.name}'. ` +
              'Either the party that should have fired it threw first, or the interleaving ' +
              'this test assumes did not happen.',
          ),
        )
      }, timeoutMs)
      this.waiters.push(() => {
        clearTimeout(timer)
        resolveWait()
      })
    })
  }
}

/** Open every gate, whatever happened. Used from `finally` so nothing parks. */
export function openAll(...gates: readonly Gate[]): void {
  for (const gate of gates) gate.fire()
}

function sleep(ms: number): Promise<void> {
  // Deliberately NOT unref'd: the poll loop's progress depends on this timer, and
  // an unref'd timer lets Node exit the event loop with the await unresolved.
  return new Promise<void>((resolveSleep) => {
    setTimeout(resolveSleep, ms)
  })
}

/* ------------------------------------------------------------------ *
 * Observing other backends
 * ------------------------------------------------------------------ */

/**
 * psql renders NULL and the empty string identically (`db.ts` says so in its own
 * comment), so every nullable column is coalesced to this marker and mapped back.
 * Without it "no wait event" and "wait event was the empty string" are the same
 * observation, which is the V24 failure mode one level down.
 */
const NULL_MARKER = '<NULL>'

function unmarked(value: string | undefined, what: string): string | undefined {
  if (value === undefined) throw new Error(`observer query returned no value for ${what}`)
  return value === NULL_MARKER ? undefined : value
}

function requiredNumber(value: string | undefined, what: string): number {
  const text = unmarked(value, what)
  if (text === undefined) throw new Error(`observer query returned NULL for ${what}`)
  const parsed = Number.parseInt(text, 10)
  if (!Number.isInteger(parsed)) throw new Error(`${what} is not an integer: '${text}'`)
  return parsed
}

export interface BackendObservation {
  readonly pid: number
  /** `pg_stat_activity.state`. `undefined` means the column came back NULL (V24). */
  readonly state: string | undefined
  /** `'Lock'` while waiting on a heavyweight lock. `undefined` when NULL (V24). */
  readonly waitEventType: string | undefined
  readonly waitEvent: string | undefined
  /** Transaction start, epoch ms. `undefined` when the backend is not in a transaction. */
  readonly xactStartMs: number | undefined
  readonly backendType: string | undefined
  /**
   * `pg_stat_activity.usename` — the SESSION role, not the effective one.
   *
   * MEASURED: this column stays visible to an unprivileged reader even when
   * `state`, `wait_event_type`, `xact_start` and `backend_type` are all NULLed,
   * so it is what distinguishes "this row is for another role and I am being
   * shown nothing" from "this backend is idle".
   */
  readonly usename: string | undefined
}

export interface BackendSnapshot {
  /** Server-side instant of the observation, epoch ms. */
  readonly observedAtMs: number
  readonly byPid: ReadonlyMap<number, BackendObservation>
  /** The role the observation was made as. */
  readonly observerRole: string
}

const PID_LIST = /^[0-9]+(,[0-9]+)*$/

/**
 * One `pg_stat_activity` read covering several pids, as a chosen role.
 *
 * The pid list reaches SQL as a psql VARIABLE (`:'pids'`), validated against
 * `PID_LIST` first and then parsed server-side by `string_to_array(...)::int[]`.
 * Nothing is concatenated into SQL text (canon rule 4) — psql identifier/literal
 * interpolation is the same mechanism `db.ts` uses for database names.
 */
export async function observeBackends(
  pids: readonly number[],
  options: { readonly role?: string | undefined } = {},
): Promise<BackendSnapshot> {
  if (pids.length === 0) throw new Error('observeBackends was given no pids')
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`observeBackends: '${String(pid)}' is not a backend pid`)
    }
  }
  const list = pids.join(',')
  if (!PID_LIST.test(list)) throw new Error(`refusing to observe pid list '${list}'`)

  await ensureWorkerDatabase()
  const role = options.role
  // The marker is written out literally rather than interpolated from
  // NULL_MARKER: canon rule 4 is "never string-interpolate into SQL", and a
  // constant is still interpolation. The two spellings are kept honest by the
  // suite rather than by the compiler — the V24 test asserts `state` comes back
  // as `undefined` for a foreign backend read as the app role, which can only
  // happen if the marker written here is the marker `unmarked()` strips. A
  // drift between them turns that assertion red.
  const rows = await queryRows(
    `select sa.pid::text,
            coalesce(sa.state, '<NULL>'),
            coalesce(sa.wait_event_type, '<NULL>'),
            coalesce(sa.wait_event, '<NULL>'),
            coalesce((extract(epoch from sa.xact_start) * 1000)::bigint::text, '<NULL>'),
            coalesce(sa.backend_type, '<NULL>'),
            coalesce(sa.usename, '<NULL>'),
            (extract(epoch from clock_timestamp()) * 1000)::bigint::text
       from pg_stat_activity sa
      where sa.pid = any (string_to_array(:'pids', ',')::int[])
      order by sa.pid`,
    { db: workerDatabaseName(), role, vars: { pids: list } },
  )

  const byPid = new Map<number, BackendObservation>()
  let observedAtMs = Number.NaN
  for (const row of rows) {
    const pid = requiredNumber(row[0], 'pg_stat_activity.pid')
    const xactStartText = unmarked(row[4], 'pg_stat_activity.xact_start')
    byPid.set(pid, {
      pid,
      state: unmarked(row[1], 'pg_stat_activity.state'),
      waitEventType: unmarked(row[2], 'pg_stat_activity.wait_event_type'),
      waitEvent: unmarked(row[3], 'pg_stat_activity.wait_event'),
      xactStartMs: xactStartText === undefined ? undefined : Number.parseInt(xactStartText, 10),
      backendType: unmarked(row[5], 'pg_stat_activity.backend_type'),
      usename: unmarked(row[6], 'pg_stat_activity.usename'),
    })
    observedAtMs = requiredNumber(row[7], 'clock_timestamp()')
  }
  if (!Number.isInteger(observedAtMs)) {
    // Every requested pid was gone. Still a legitimate observation; stamp it
    // locally so callers never read NaN.
    observedAtMs = Date.now()
  }

  return {
    observedAtMs,
    byPid,
    // The default role in `db.ts`'s psql() is TEST_ADMIN_ROLE, which is what the
    // privileged observer wants. Recorded rather than assumed, so a report of
    // "nothing was blocked" always carries who looked.
    observerRole: role ?? '(admin: TEST_ADMIN_ROLE)',
  }
}

/* ------------------------------------------------------------------ *
 * waitUntilBlocked, and the control that it can report the negative
 * ------------------------------------------------------------------ */

export interface BlockProbeOptions {
  readonly timeoutMs?: number | undefined
  readonly pollIntervalMs?: number | undefined
  readonly role?: string | undefined
}

export interface BlockProbe {
  readonly pid: number
  /** `state = 'active'` AND `wait_event_type = 'Lock'` was observed at least once. */
  readonly blocked: boolean
  readonly samples: number
  readonly elapsedMs: number
  /** The backend was present in `pg_stat_activity` at least once. */
  readonly present: boolean
  /**
   * A NON-NULL `state` was read at least once.
   *
   * THIS IS THE ANTI-VACUOUS CONTROL (V24). An observer that cannot see the
   * column reports `blocked:false` for a backend that is in fact waiting, so
   * `blocked === false` is only a negative RESULT when `observedState === true`.
   * Otherwise it is a blind instrument and the assertion must fail instead.
   */
  readonly observedState: boolean
  /** Distinct `state/wait_event_type` pairs seen, for the failure message. */
  readonly seen: readonly string[]
  readonly observerRole: string
}

/**
 * Poll until `pid` is waiting on a heavyweight lock, or the timeout expires.
 *
 * Returns the full probe rather than a boolean so a caller can tell a real
 * negative from an unobservable one. `waitUntilBlocked` below is the boolean
 * form canon §8.4 names, and the suite's first instrument test asserts it
 * returns FALSE for two transactions locking different rows.
 */
export async function waitForBlockDetail(
  pid: number,
  options: BlockProbeOptions = {},
): Promise<BlockProbe> {
  const timeoutMs = options.timeoutMs ?? 2_000
  const pollIntervalMs = options.pollIntervalMs ?? 25
  const startedAt = Date.now()
  const seen = new Set<string>()
  let samples = 0
  let present = false
  let observedState = false
  let blocked = false
  let observerRole = '(not yet observed)'

  for (;;) {
    const snapshot = await observeBackends([pid], { role: options.role })
    observerRole = snapshot.observerRole
    samples += 1
    const observation = snapshot.byPid.get(pid)
    if (observation !== undefined) {
      present = true
      if (observation.state !== undefined) observedState = true
      seen.add(`${observation.state ?? 'NULL'}/${observation.waitEventType ?? 'NULL'}`)
      if (observation.state === 'active' && observation.waitEventType === 'Lock') {
        blocked = true
        break
      }
    }
    if (Date.now() - startedAt >= timeoutMs) break
    await sleep(pollIntervalMs)
  }

  return {
    pid,
    blocked,
    samples,
    elapsedMs: Date.now() - startedAt,
    present,
    observedState,
    seen: [...seen].sort(),
    observerRole,
  }
}

/** The boolean instrument canon §8.4 names. Must be able to report `false`. */
export async function waitUntilBlocked(
  pid: number,
  options: BlockProbeOptions = {},
): Promise<boolean> {
  return (await waitForBlockDetail(pid, options)).blocked
}

/** Render a probe for an assertion message. A bare `false` explains nothing. */
export function describeProbe(probe: BlockProbe): string {
  return (
    `pid=${String(probe.pid)} blocked=${String(probe.blocked)} ` +
    `present=${String(probe.present)} observedState=${String(probe.observedState)} ` +
    `samples=${String(probe.samples)} elapsed=${String(probe.elapsedMs)}ms ` +
    `seen=[${probe.seen.join(' ')}] observer=${probe.observerRole}`
  )
}

/* ------------------------------------------------------------------ *
 * A backend belonging to a DIFFERENT role — V24's actual condition
 * ------------------------------------------------------------------ */

export interface ForeignRoleBackend {
  readonly pid: number
  /** `pg_stat_activity.usename` for that backend: the SESSION role. */
  readonly sessionRole: string
  /** Settles when the parked statement ends. The caller must await it. */
  readonly finished: Promise<void>
}

/**
 * Park a backend whose SESSION ROLE is not `authenticated`, and return its pid.
 *
 * WHY THIS EXISTS. V24 reads "a non-privileged observer of `pg_stat_activity`
 * gets one row per pid with `state` and `wait_event_type` NULL", and this suite
 * first assumed that applied to any foreign pid. MEASURED, it does not: the
 * detail columns are ROLE-SCOPED, so `authenticated` sees another
 * `authenticated` backend in full — including a live `Lock` wait — and sees
 * nothing for a backend of another role. Since both parties in every race here
 * connect as `authenticated`, the app role would in fact have served as the
 * observer; the instrument uses the admin role because that visibility is a
 * property of the PARTIES' roles rather than of the instrument, and a future
 * test that parked a `postgres` transaction would otherwise be told "never
 * blocked" by a blind observer.
 *
 * This helper makes that an observation rather than an argument: it produces a
 * foreign-role backend so the suite can read the same pid twice, once as each
 * role, and assert the asymmetry.
 *
 * The backend is `postgres`, which is the connection `ownerQuery` already uses
 * for fixture DDL — no new connection machinery, and no `pg` import. No
 * `SET ROLE` is involved any more: the pre-port version connected as
 * `statesman_migrator` and had to `SET ROLE statesman_owner`, because that role
 * was `noinherit`; ADR-0015 §4.1 retires both and `postgres` owns every relation
 * in `public` directly. `pg_stat_activity.usename` reports the SESSION role, so
 * the discovery predicate below still sees a name that differs from `appRole()`.
 */
export async function parkForeignRoleBackend(
  options: { readonly seconds?: number; readonly discoveryTimeoutMs?: number } = {},
): Promise<ForeignRoleBackend> {
  const seconds = options.seconds ?? 1
  const discoveryTimeoutMs = options.discoveryTimeoutMs ?? 3_000
  await ensureWorkerDatabase()

  // The column alias is the search marker: `pg_stat_activity.query` carries the
  // statement text verbatim, so the alias identifies this backend without any
  // out-of-band channel. The duration is a psql variable, not interpolation.
  const finished = ownerQuery(
    `select pg_sleep(:'secs'::numeric) as statesman_foreign_role_probe`,
    { secs: seconds.toFixed(3) },
  ).then(
    () => undefined,
    (reason: unknown) => {
      throw new Error(`the parked foreign-role backend failed: ${String(reason)}`)
    },
  )

  const deadline = Date.now() + discoveryTimeoutMs
  for (;;) {
    // Observed as the admin role, because discovery reads `query`, which is
    // restricted in exactly the same way as `state`.
    const rows = await queryRows(
      `select sa.pid::text, sa.usename
         from pg_stat_activity sa
        where sa.datname = current_database()
          and sa.pid <> pg_backend_pid()
          and sa.usename <> :'approle'
          and sa.query like '%statesman_foreign_role_probe%'
        order by sa.backend_start desc
        limit 1`,
      { db: workerDatabaseName(), vars: { approle: appRole() } },
    )
    const row = rows[0]
    const pidText = row?.[0]
    const sessionRole = row?.[1]
    if (pidText !== undefined && sessionRole !== undefined && sessionRole !== '') {
      const pid = Number.parseInt(pidText, 10)
      if (Number.isInteger(pid)) return { pid, sessionRole, finished }
    }
    if (Date.now() >= deadline) break
    await sleep(25)
  }

  await finished
  throw new Error(
    `could not find the parked foreign-role backend within ${String(discoveryTimeoutMs)}ms. ` +
      'It may have finished before discovery — raise `seconds`.',
  )
}

/* ------------------------------------------------------------------ *
 * Overlap, without reference to locks (V23)
 * ------------------------------------------------------------------ */

export interface SimultaneityReport {
  readonly observedAtMs: number
  readonly requested: readonly number[]
  /** Pids that were present AND had a non-null `xact_start` at that instant. */
  readonly inTransaction: readonly number[]
  readonly missing: readonly number[]
  /** Every requested pid was inside a transaction at the same observed instant. */
  readonly allOverlapping: boolean
  readonly detail: string
}

/**
 * Prove, from a third connection and at a single instant, that every one of
 * these backends is inside an open transaction right now.
 *
 * This — not lock-wait detection — is the instrument for "these two
 * transactions were genuinely concurrent". V23 reproduced an unguarded
 * read-then-write in which the follower inserted and committed while the
 * leader's transaction was still open and no Lock wait ever appeared, so an
 * overlap test built on lock detection would report "not concurrent" for the
 * very case that is most dangerous.
 */
export async function observeSimultaneousTransactions(
  pids: readonly number[],
): Promise<SimultaneityReport> {
  const snapshot = await observeBackends(pids)
  const inTransaction: number[] = []
  const missing: number[] = []
  const parts: string[] = []
  for (const pid of pids) {
    const observation = snapshot.byPid.get(pid)
    if (observation === undefined) {
      missing.push(pid)
      parts.push(`${String(pid)}:absent`)
      continue
    }
    if (observation.xactStartMs !== undefined) inTransaction.push(pid)
    parts.push(
      `${String(pid)}:state=${observation.state ?? 'NULL'},` +
        `wait=${observation.waitEventType ?? 'NULL'},` +
        `xact_start=${observation.xactStartMs === undefined ? 'NULL' : String(observation.xactStartMs)}`,
    )
  }
  return {
    observedAtMs: snapshot.observedAtMs,
    requested: [...pids],
    inTransaction,
    missing,
    allOverlapping: missing.length === 0 && inTransaction.length === pids.length && pids.length >= 2,
    detail: `observer=${snapshot.observerRole} at=${String(snapshot.observedAtMs)} ${parts.join(' ')}`,
  }
}

/** A transaction's real lifetime, measured from inside it. */
export interface TxWindow {
  readonly pid: number
  /** `pg_stat_activity.xact_start` for this backend, epoch ms. */
  readonly xactStartMs: number
  /** `clock_timestamp()` at the moment this window was read, epoch ms. */
  readonly observedMs: number
}

/**
 * Read this transaction's own window.
 *
 * MEASURED on this cluster: a backend connected as `authenticated` sees its OWN
 * `pg_stat_activity` row in full (`state='active'`, non-null `xact_start`),
 * even though V24's restriction hides those columns for other pids. So this
 * second overlap proof needs no privileged connection at all — which matters,
 * because it means the suite's concurrency claim does not rest solely on the
 * admin observer.
 *
 * Call it as the LAST statement of the transaction: `observedMs` is then a lower
 * bound on when the transaction was still alive, and `windowsOverlap` can close
 * the interval.
 */
export async function readOwnTxWindow(db: ScopedQueries): Promise<TxWindow> {
  const row = await db.queryOne<{
    pid: string
    xact_start_ms: string | null
    observed_ms: string
  }>(
    `select pg_backend_pid()::text as pid,
            (extract(epoch from sa.xact_start) * 1000)::bigint::text as xact_start_ms,
            (extract(epoch from clock_timestamp()) * 1000)::bigint::text as observed_ms
       from pg_stat_activity sa
      where sa.pid = pg_backend_pid()`,
  )
  if (row.xact_start_ms === null) {
    throw new Error(
      'readOwnTxWindow: xact_start is NULL for this backend, so it is not inside a ' +
        'transaction. withUser issues BEGIN before the callback runs, so this means the ' +
        'transaction preamble changed.',
    )
  }
  return {
    pid: Number.parseInt(row.pid, 10),
    xactStartMs: Number.parseInt(row.xact_start_ms, 10),
    observedMs: Number.parseInt(row.observed_ms, 10),
  }
}

/** True when the two measured lifetimes intersect. */
export function windowsOverlap(a: TxWindow, b: TxWindow): boolean {
  return Math.max(a.xactStartMs, b.xactStartMs) <= Math.min(a.observedMs, b.observedMs)
}

export function describeWindows(a: TxWindow, b: TxWindow): string {
  const base = Math.min(a.xactStartMs, b.xactStartMs)
  const rel = (w: TxWindow): string =>
    `pid=${String(w.pid)} [+${String(w.xactStartMs - base)}ms .. +${String(w.observedMs - base)}ms]`
  return `${rel(a)} vs ${rel(b)}`
}

/** This backend's pid, read from inside the scoped transaction. */
export async function backendPid(db: ScopedQueries): Promise<number> {
  const row = await db.queryOne<{ pid: string }>('select pg_backend_pid()::text as pid')
  const pid = Number.parseInt(row.pid, 10)
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`pg_backend_pid() returned '${row.pid}'`)
  return pid
}

/* ------------------------------------------------------------------ *
 * The revision-number read helper
 * ------------------------------------------------------------------ */

/**
 * `max(revision_no) + 1` for a decision, read through RLS as the caller.
 *
 * This is deliberately the SAME computation `app.append_revision` performs
 * (migration 0004), and it is the helper canon §8.4's second mandatory
 * instrument test covers: run sequentially around a real append it must return
 * DIFFERENT values, otherwise `expect(nextA).toBe(nextB)` in the unguarded-race
 * control is not evidence of a race — it is a constant.
 */
export async function readNextRevisionNo(
  db: ScopedQueries,
  decisionId: string,
): Promise<number> {
  const row = await db.queryOne<{ next_no: string }>(
    `select (coalesce(max(dr.revision_no), 0) + 1)::text as next_no
       from public.decision_revision dr
      where dr.decision_id = $1::uuid`,
    [decisionId],
  )
  const value = Number.parseInt(row.next_no, 10)
  if (!Number.isInteger(value)) throw new Error(`next revision_no is not an integer: '${row.next_no}'`)
  return value
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** Any `ScopedQueries` that also carries the identity the policies will enforce. */
export type IdentifiedQueries = ScopedQueries & { readonly userId: string }

export interface RevisionPayload {
  readonly content: { readonly label: string }
  readonly confidence: number
  readonly forecast: string
  readonly horizon: string
  readonly rationale: string
}

/**
 * Revision body. The forecast text is labelled fictional because canon §1.2's
 * editorial boundary applies to seeded content as much as to shipped content.
 */
export function revisionPayload(label: string): RevisionPayload {
  return {
    content: { label },
    confidence: 50,
    forecast: `fictional fixture forecast — ${label}`,
    horizon: '90 days',
    rationale: `fixture rationale — ${label}`,
  }
}

export function newId(): string {
  return randomUUID()
}

/**
 * Seed an identity: the `auth.users` row and then its `public.profile` row.
 *
 * Through `ownerQuery` (as `postgres`), and post-port the REASON HAS CHANGED even
 * though the call has not. It used to be grant-absence plus a `noinherit`
 * migrator role needing `SET ROLE`; ADR-0015 §4.1 retires those roles and
 * 20261021140200 replaces `app_user` with `public.profile`, which
 * `authenticated` CAN reach. What makes the owner connection necessary now is
 * the row above it: `auth.users` is the platform's table, and
 * scripts/emulate-supabase.sh grants `postgres` exactly `select, insert,
 * references` on it while revoking everything from `public, anon, authenticated`
 * (port finding P8). UPDATE and DELETE are withheld from `postgres` too, so this
 * helper can create an identity and nothing in the harness can edit or remove
 * one — on the live project that would be editing GoTrue's table.
 *
 * No FORCE bracket is needed, and the post-port reason is different from the
 * pre-port one: not "the table is grant-protected rather than RLS-protected",
 * but that `postgres` is BYPASSRLS, so RLS does not apply to this connection at
 * all. MEASURED: as `postgres`, with FORCE on and no claim set, a read of
 * `public.decision` returns rows and raises nothing. A bracket would still be
 * needed for a WRITE issued by a merely-owning role (V8).
 */
export async function seedUser(userId: string = newId()): Promise<string> {
  // PORTED FOR THE SUPABASE SHAPE (ADR-0015). `public.app_user` is retired: ADR-0002 goes
  // with it and 20261021140200 replaces the three identity tables with `public.profile`,
  // whose primary key `user_id` carries a REAL foreign key to `auth.users (id)` with
  // ON DELETE RESTRICT. So an identity fixture now has to create the auth user FIRST —
  // the chain is `decision -> profile -> auth.users` — and a fixture that forgets fails
  // immediately rather than at the next posture run.
  //
  // No credential column is written at all. `encrypted_password` is nullable and NULL can
  // never verify against anything, which is strictly stronger than the pre-port trick of
  // storing a deliberately malformed argon2 encoding: this identity cannot be signed in
  // as, by construction rather than by the hash being wrong. The address is at
  // `.invalid` (RFC 2606) so no magic link or recovery mail can be delivered to it.
  //
  // Four columns, matching exactly what scripts/emulate-supabase.sh gives its minimal
  // `auth.users`, so the local insert exercises the same column list a live one would.
  // UNVERIFIED against project onpkspfxfmjkqpomcsse: the real `auth.users` is GoTrue's and
  // carries many more columns, all nullable or defaulted as far as the published schema
  // goes (port finding P5).
  await ownerQuery(
    `insert into auth.users (id, email, created_at, updated_at)
     values (:'uid'::uuid, :'email', now(), now())
     on conflict (id) do nothing;
     insert into public.profile (user_id, display_name, created_at, updated_at)
     values (:'uid'::uuid, :'display', now(), now())
     on conflict (user_id) do nothing`,
    {
      uid: userId,
      email: `${userId}@concurrency.invalid`,
      display: `concurrency fixture ${userId.slice(0, 8)}`,
    },
  )
  return userId
}

/**
 * Create a draft decision owned by `userId`, through the real `withUser`.
 *
 * Canon §8.3: seeding goes through `withUser` so a missing INSERT policy
 * surfaces here instead of being bypassed by a privileged fixture. `db.userId`
 * is used for the owner column rather than the caller's argument, so the row is
 * stamped with the identity the policy will actually enforce.
 */
export async function createDraftDecision(userId: string, decisionId: string = newId()): Promise<string> {
  await runAsUser(userId, async (db) => {
    await db.queryAffectingOne(
      `insert into public.decision (id, user_id, draft_payload)
       values ($1::uuid, $2::uuid, $3::jsonb)`,
      [decisionId, db.userId, JSON.stringify({ fixture: 'concurrency', decisionId })],
    )
  })
  return decisionId
}

/**
 * Insert a revision with a CALLER-CHOSEN `revision_no`, bypassing
 * `app.append_revision` entirely.
 *
 * This is the unguarded write of V23's negative control, and it is expressible
 * only because `authenticated` genuinely holds `INSERT` on
 * `public.decision_revision` (20261021140300). No `FOR UPDATE` is taken and no
 * row lock is acquired, which is exactly why two callers can read the same
 * `max(revision_no) + 1` and the follower can commit while the leader is still
 * open. Nothing in the application may do this; the control exists to show what
 * the guarded path is protecting against.
 */
export async function insertRevisionUnguarded(
  db: IdentifiedQueries,
  input: {
    readonly decisionId: string
    readonly revisionNo: number
    readonly idempotencyToken: string
    readonly payload: RevisionPayload
  },
): Promise<void> {
  await db.queryAffectingOne(
    `insert into public.decision_revision
       (decision_id, user_id, revision_no, content, confidence,
        forecast, horizon, rationale, idempotency_token)
     values ($1::uuid, $2::uuid, $3::int, $4::jsonb, $5::smallint,
             $6::text, $7::text, $8::text, $9::uuid)`,
    [
      input.decisionId,
      db.userId,
      input.revisionNo,
      JSON.stringify(input.payload.content),
      input.payload.confidence,
      input.payload.forecast,
      input.payload.horizon,
      input.payload.rationale,
      input.idempotencyToken,
    ],
  )
}

/** Every `revision_no` for a decision, ascending, read through RLS as the owner. */
export async function readRevisionNumbers(userId: string, decisionId: string): Promise<number[]> {
  return runAsUser(userId, async (db) => {
    const result = await db.query<{ revision_no: string }>(
      `select dr.revision_no::text as revision_no
         from public.decision_revision dr
        where dr.decision_id = $1::uuid
        order by dr.revision_no`,
      [decisionId],
    )
    return result.rows.map((row) => Number.parseInt(row.revision_no, 10))
  })
}

/** The generated `state` column, read through RLS as the owner. */
export async function readDecisionState(userId: string, decisionId: string): Promise<string> {
  return runAsUser(userId, async (db) => {
    const row = await db.queryOne<{ state: string }>(
      `select d.state::text as state from public.decision d where d.id = $1::uuid`,
      [decisionId],
    )
    return row.state
  })
}

/**
 * Take a row-level write lock on a decision's `draft_payload`, using the only
 * column `authenticated` may update (§4.6b).
 *
 * `select ... for update` is NOT used: row locking requires UPDATE/DELETE
 * privilege and the app role's UPDATE is column-scoped, so the lock the
 * application can actually take is the one an `UPDATE ... set draft_payload`
 * takes. Using the real grant keeps the instrument tests on the same privilege
 * surface as the code they are instruments for. The row must be an unsubmitted
 * draft or the transition guard raises ST003 (frozen draft) instead of locking.
 */
export async function lockDraftRow(
  db: IdentifiedQueries,
  decisionId: string,
  marker: string,
): Promise<void> {
  await db.queryAffectingOne(
    `update public.decision
        set draft_payload = $2::jsonb
      where id = $1::uuid`,
    [decisionId, JSON.stringify({ fixture: 'concurrency', marker })],
  )
}

/**
 * The role name the data path connects as.
 *
 * Re-exported so a test can run the SAME `pg_stat_activity` read as the app role
 * and assert V24 still holds — the control that justifies the privileged
 * observer rather than assuming it is needed.
 */
export { appRole }
