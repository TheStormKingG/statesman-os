/**
 * tests/integration/concurrency.test.ts — canon §8.4.
 *
 * WHAT MAKES THIS SUITE NON-VACUOUS
 * ---------------------------------
 * Every test below runs TWO transactions at once: two separate pool clients,
 * each with its own `BEGIN` opened by the real `withUser`, with the statement
 * order fixed by an application rendezvous (`Gate`) in the test body. Two
 * sequential `await`s would read identically in the source and prove nothing,
 * because the second statement would begin after the first transaction had
 * already committed. So every race test also carries an overlap probe: a third,
 * privileged connection reads `pg_stat_activity` at one instant and asserts both
 * backends have a non-null `xact_start` right then; and wherever both
 * transactions survive to run one more statement, each reports its own
 * `xact_start`/`clock_timestamp()` window and the two are asserted to intersect
 * with no privileged read involved at all.
 *
 * THE INSTRUMENTS ARE TESTED BEFORE THEY ARE USED
 * -----------------------------------------------
 * The first `describe` block validates the measuring device, because a
 * concurrency suite fails silently in exactly one direction:
 *
 *   - a `waitUntilBlocked` that always answers "blocked" leaves every test in
 *     this file green while nothing ever contends. So it is required to answer
 *     FALSE for two transactions locking DIFFERENT rows.
 *   - V24: a non-privileged observer of `pg_stat_activity` gets one row per pid
 *     with `state` and `wait_event_type` NULL, so "cannot observe" is otherwise
 *     reported as "never blocked". The probe therefore reports `observedState`,
 *     and `blocked:false` is accepted as a negative RESULT only when the
 *     observer demonstrably could read the column. A separate positive
 *     observability test deliberately blocks a backend and asserts
 *     `state='active'` and `wait_event_type='Lock'` are actually visible.
 *     MEASURED REFINEMENT, after this suite asserted V24 too broadly and failed:
 *     that visibility is ROLE-SCOPED. `authenticated` sees another
 *     `authenticated` backend in full, and sees only NULLs for a backend of a
 *     different role. Both are asserted here, the second against a deliberately
 *     parked `postgres` backend paired with an admin read of the same pid.
 *   - the revision-number read helper is required to produce DIFFERENT values
 *     when run sequentially around a real append, because the V23 control's
 *     central assertion is `leaderNext === followerNext`, and that is not
 *     evidence of a stale read unless the helper can disagree with itself.
 *
 * WHY THE NEGATIVE CONTROL DOES NOT USE LOCK DETECTION
 * ----------------------------------------------------
 * V23 reproduced an unguarded read-then-write in which the follower inserted
 * and committed while the leader's transaction was still open and NO Lock wait
 * ever appeared. An overlap test built on lock-wait detection would therefore
 * report "not concurrent" about the most dangerous interleaving in the system.
 * Lock detection answers one question only — "does the guarded path
 * serialise?" — while "were these two transactions genuinely concurrent?" is
 * answered by the rendezvous plus the `xact_start` overlap assertion. The last
 * describe block reproduces V23 so the distinction is shown on this cluster
 * rather than inherited from the register.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureWorkerDatabase, releaseProductionPools, runAsUser } from './support/db'
import {
  InvalidDecisionStateError,
  RevisionNumberConflictError,
  StatesmanError,
  appendRevision,
  submitDecision,
} from '../support/scoped-pg'
import {
  Gate,
  appRole,
  backendPid,
  createDraftDecision,
  describeProbe,
  describeWindows,
  insertRevisionUnguarded,
  lockDraftRow,
  newId,
  observeBackends,
  observeSimultaneousTransactions,
  openAll,
  parkForeignRoleBackend,
  readDecisionState,
  readNextRevisionNo,
  readOwnTxWindow,
  readRevisionNumbers,
  revisionPayload,
  seedUser,
  waitForBlockDetail,
  waitUntilBlocked,
  windowsOverlap,
} from './support/race'
import type { BlockProbe, SimultaneityReport, TxWindow } from './support/race'

/* ------------------------------------------------------------------ *
 * Local helpers
 * ------------------------------------------------------------------ */

type Settled<T> =
  | { readonly status: 'fulfilled'; readonly value: T }
  | { readonly status: 'rejected'; readonly reason: unknown }

/**
 * Settle two already-running transactions without ever leaving one unhandled.
 *
 * `Promise.allSettled` would do the same job but loses the tuple's element
 * types, and `noUncheckedIndexedAccess` then turns every read into a
 * `| undefined`. The part that matters is that both handlers are attached
 * SYNCHRONOUSLY: a follower that rejects while the test body is still
 * orchestrating must surface as a value here, not as an unhandled rejection
 * that takes the worker down.
 */
function settleTwo<A, B>(a: Promise<A>, b: Promise<B>): Promise<readonly [Settled<A>, Settled<B>]> {
  const wrap = <T>(p: Promise<T>): Promise<Settled<T>> =>
    p.then<Settled<T>, Settled<T>>(
      (value) => ({ status: 'fulfilled', value }),
      (reason: unknown) => ({ status: 'rejected', reason }),
    )
  return Promise.all([wrap(a), wrap(b)])
}

function render(value: unknown): string {
  if (value instanceof StatesmanError) {
    return (
      `${value.name}(kind=${value.kind}, sqlState=${value.sqlState ?? 'none'}, ` +
      `constraint=${value.constraintName ?? 'none'}, retryable=${String(value.retryable)}): ${value.message}`
    )
  }
  return value instanceof Error ? `${value.name}: ${value.message}` : String(value)
}

function expectFulfilled<T>(result: Settled<T>, what: string): T {
  if (result.status !== 'fulfilled') {
    throw new Error(`${what} was expected to succeed but rejected with: ${render(result.reason)}`)
  }
  return result.value
}

function expectRejected<T>(result: Settled<T>, what: string): unknown {
  if (result.status !== 'rejected') {
    throw new Error(
      `${what} was expected to be rejected but succeeded with: ${JSON.stringify(result.value)}`,
    )
  }
  return result.reason
}

/** The rejection must be a typed boundary error, so its SQLSTATE can be asserted. */
function asStatesmanError(reason: unknown, what: string): StatesmanError {
  if (!(reason instanceof StatesmanError)) {
    throw new Error(`${what} did not reject with a StatesmanError: ${render(reason)}`)
  }
  return reason
}

interface Observed {
  readonly probe: BlockProbe
  readonly simultaneity: SimultaneityReport
}

function requireObserved(observed: Observed | undefined): Observed {
  if (observed === undefined) {
    throw new Error('the orchestration threw before the instruments produced a reading')
  }
  return observed
}

/* ------------------------------------------------------------------ *
 * Fixture lifecycle
 * ------------------------------------------------------------------ */

beforeAll(async () => {
  // Clones this worker's database from the template AND runs the role guard, so
  // a run that silently connected as a superuser dies here instead of reporting
  // green while RLS was bypassed (canon §8.3).
  await ensureWorkerDatabase()
}, 120_000)

afterAll(async () => {
  await releaseProductionPools()
})

/* ================================================================== *
 * 1. INSTRUMENT VALIDATION — harness-fatal, and written first
 * ================================================================== */

describe('concurrency instruments', () => {
  it('waitUntilBlocked returns FALSE when the two transactions lock DIFFERENT rows, and the observer could see the column', async () => {
    const user = await seedUser()
    const leaderRow = await createDraftDecision(user)
    const followerRow = await createDraftDecision(user)

    const leaderLocked = new Gate('leader locked its own row')
    const followerAtWrite = new Gate('follower about to lock the other row')
    const release = new Gate('release both transactions')

    let leaderPid = 0
    let followerPid = 0

    const leader = runAsUser(user, async (db) => {
      leaderPid = await backendPid(db)
      await lockDraftRow(db, leaderRow, 'leader')
      leaderLocked.fire()
      await release.wait()
      return readOwnTxWindow(db)
    })

    const follower = runAsUser(user, async (db) => {
      followerPid = await backendPid(db)
      await leaderLocked.wait()
      followerAtWrite.fire()
      await lockDraftRow(db, followerRow, 'follower')
      await release.wait()
      return readOwnTxWindow(db)
    })

    const settled = settleTwo(leader, follower)
    let blocked: boolean | undefined
    let observed: Observed | undefined
    try {
      await followerAtWrite.wait()
      // The named instrument, in the boolean form canon §8.4 requires to be
      // able to answer FALSE. Called first and on its own.
      blocked = await waitUntilBlocked(followerPid, { timeoutMs: 700, pollIntervalMs: 25 })
      // A second, shorter window collects the diagnostics that decide whether
      // the `false` above was a RESULT or a blind instrument (V24).
      observed = {
        probe: await waitForBlockDetail(followerPid, { timeoutMs: 300, pollIntervalMs: 25 }),
        simultaneity: await observeSimultaneousTransactions([leaderPid, followerPid]),
      }
    } finally {
      openAll(release)
    }
    const [leaderResult, followerResult] = await settled
    const leaderWindow = expectFulfilled(leaderResult, 'leader transaction')
    const followerWindow = expectFulfilled(followerResult, 'follower transaction')
    const { probe, simultaneity } = requireObserved(observed)

    // THE INSTRUMENT'S NEGATIVE. Without this, a probe that always reported
    // "blocked" would leave every other test in this file green while nothing
    // ever contended.
    expect(
      blocked,
      `waitUntilBlocked must report false for different rows — ${describeProbe(probe)}`,
    ).toBe(false)

    // ...and the negative is only a negative if the observer was not blind.
    expect(
      probe.present,
      `the observer never saw pid ${String(followerPid)} in pg_stat_activity — ${describeProbe(probe)}`,
    ).toBe(true)
    expect(
      probe.observedState,
      'the observer never read a non-NULL state, so "not blocked" is unfalsifiable (V24) — ' +
        describeProbe(probe),
    ).toBe(true)
    expect(probe.blocked, describeProbe(probe)).toBe(false)
    expect(probe.seen).not.toContain('active/Lock')

    // Both transactions really were open at the same instant, proven without
    // any reference to locks — twice, once per instrument.
    expect(simultaneity.allOverlapping, simultaneity.detail).toBe(true)
    expect(simultaneity.missing).toEqual([])
    expect(
      windowsOverlap(leaderWindow, followerWindow),
      `measured windows do not intersect: ${describeWindows(leaderWindow, followerWindow)}`,
    ).toBe(true)
    expect(leaderWindow.pid).not.toBe(followerWindow.pid)
  })

  it('reports blocked with state=active and wait_event_type=Lock on the SAME row (the positive observability assertion)', async () => {
    const user = await seedUser()
    const contended = await createDraftDecision(user)

    const leaderLocked = new Gate('leader locked the contended row')
    const followerAtWrite = new Gate('follower about to lock the same row')
    const release = new Gate('release leader')

    let followerPid = 0

    const leader = runAsUser(user, async (db) => {
      await lockDraftRow(db, contended, 'leader')
      leaderLocked.fire()
      await release.wait()
      return readOwnTxWindow(db)
    })

    const follower = runAsUser(user, async (db) => {
      followerPid = await backendPid(db)
      await leaderLocked.wait()
      followerAtWrite.fire()
      await lockDraftRow(db, contended, 'follower')
      return readOwnTxWindow(db)
    })

    const settled = settleTwo(leader, follower)
    let probe: BlockProbe | undefined
    let privilegedState: string | undefined
    let privilegedWaitType: string | undefined
    let privilegedWaitEvent: string | undefined
    let appRowCount = -1
    let appState: string | undefined
    let appWaitType: string | undefined
    try {
      await followerAtWrite.wait()
      probe = await waitForBlockDetail(followerPid, { timeoutMs: 2_500, pollIntervalMs: 25 })

      // Read the two columns directly, as the privileged observer, while the
      // follower is still parked. THIS IS THE POSITIVE OBSERVABILITY ASSERTION
      // canon §8.4 requires: it proves the instrument can see a real lock wait,
      // so its "no lock wait" elsewhere is a measurement rather than silence.
      const privileged = await observeBackends([followerPid])
      const observation = privileged.byPid.get(followerPid)
      privilegedState = observation?.state
      privilegedWaitType = observation?.waitEventType
      privilegedWaitEvent = observation?.waitEvent

      // The same read, as the app role. See the refinement of V24 below.
      const asApp = await observeBackends([followerPid], { role: appRole() })
      appRowCount = asApp.byPid.size
      const appObservation = asApp.byPid.get(followerPid)
      appState = appObservation?.state
      appWaitType = appObservation?.waitEventType
    } finally {
      openAll(release)
    }
    const [leaderResult, followerResult] = await settled
    expectFulfilled(leaderResult, 'leader transaction')
    expectFulfilled(followerResult, 'follower transaction')
    if (probe === undefined) throw new Error('the orchestration threw before the probe ran')

    expect(
      probe.blocked,
      `the follower should have waited on the leader's row lock — ${describeProbe(probe)}`,
    ).toBe(true)
    expect(probe.seen).toContain('active/Lock')
    expect(privilegedState, `privileged observer saw state=${privilegedState ?? 'NULL'}`).toBe('active')
    expect(
      privilegedWaitType,
      `privileged observer saw wait_event_type=${privilegedWaitType ?? 'NULL'}`,
    ).toBe('Lock')
    // `transactionid` for a wait on another transaction's row lock, `tuple` when
    // queued behind a third waiter. Either is a real heavyweight lock wait; the
    // assertion is that the column is populated rather than NULL.
    expect(privilegedWaitEvent).toBeDefined()

    // ───────────────────────────────────────────────────────────────────────
    // MEASURED REFINEMENT OF V24, recorded because this suite got it wrong
    // first.
    //
    // V24 reads "a non-privileged observer of pg_stat_activity gets one row per
    // pid with state and wait_event_type NULL", and this test originally
    // asserted that for the follower's pid — and FAILED, with
    // `expected 'active' to be undefined`. The detail columns are ROLE-SCOPED:
    // `authenticated` sees another `authenticated` backend in full, including a
    // live Lock wait. V24's NULLs apply to a backend of a DIFFERENT role, which
    // the next test reproduces directly.
    //
    // So the app role would in fact have served as this suite's observer. The
    // instrument still observes as the admin role, because the visibility is a
    // property of the PARTIES' roles rather than of the instrument: a future
    // test that parked a `postgres` transaction would be told "never blocked"
    // by an app-role observer, silently and in the healthy-looking direction. `BlockProbe.observedState` is the guard against that, and it is
    // asserted in every negative result in this file.
    // ───────────────────────────────────────────────────────────────────────
    expect(appRowCount, 'the app role should see one pg_stat_activity row per pid').toBe(1)
    expect(appState, 'a same-role backend is fully visible to the app role').toBe('active')
    expect(appWaitType).toBe('Lock')
  })

  it('V24 under its actual condition: a FOREIGN-role backend reads as all-NULL to the app role and as populated to the admin observer', async () => {
    // The paired control for the NULL reading. Without the admin half, "the app
    // role saw NULLs" is indistinguishable from "the backend was not there" —
    // which is the same ambiguity V18/V19 describe for a row count of 0, one
    // layer down in the catalog.
    const parked = await parkForeignRoleBackend({ seconds: 1.2 })
    try {
      const asAdmin = await observeBackends([parked.pid])
      const asApp = await observeBackends([parked.pid], { role: appRole() })

      const adminView = asAdmin.byPid.get(parked.pid)
      const appView = asApp.byPid.get(parked.pid)

      expect(parked.sessionRole).not.toBe(appRole())
      expect(adminView, 'the admin observer must see the parked backend').toBeDefined()
      expect(appView, 'the row itself is visible to the app role (V24: one row per pid)').toBeDefined()
      if (adminView === undefined || appView === undefined) throw new Error('unreachable')

      // The admin half: the columns really are populated for this pid, so the
      // NULLs below are a privilege artefact and not an empty backend.
      expect(adminView.state, 'admin observer sees the parked statement running').toBe('active')
      expect(adminView.usename).toBe(parked.sessionRole)
      expect(adminView.backendType).toBe('client backend')

      // The app-role half: V24, exactly. Note that `backend_type` is NULLed too,
      // which V24 does not mention — only `usename` survives, which is what
      // makes the row identifiable as someone else's at all.
      expect(appView.usename, 'usename stays visible, which is how the row is identifiable').toBe(
        parked.sessionRole,
      )
      expect(appView.state, 'V24: state is NULL for a foreign-role backend').toBeUndefined()
      expect(appView.waitEventType).toBeUndefined()
      expect(appView.xactStartMs).toBeUndefined()
      expect(appView.backendType).toBeUndefined()
    } finally {
      await parked.finished
    }
  })

  it('the revision-number read helper produces DIFFERENT values when run sequentially around a real append', async () => {
    const user = await seedUser()
    const decision = await createDraftDecision(user)

    const acrossSubmit = await runAsUser(user, async (db) => {
      const before = await readNextRevisionNo(db, decision)
      const submitted = await submitDecision(db, {
        decisionId: decision,
        idempotencyToken: newId(),
        ...revisionPayload('instrument-submit'),
      })
      const after = await readNextRevisionNo(db, decision)
      return { before, submitted, after }
    })

    expect(acrossSubmit.before).toBe(1)
    expect(acrossSubmit.submitted.revisionNo).toBe(1)
    expect(acrossSubmit.after).toBe(2)
    // THE INSTRUMENT'S NEGATIVE. `leaderNext === followerNext` in the V23
    // control below is evidence of a stale read only because this helper is
    // capable of returning different values for the same decision.
    expect(acrossSubmit.after).not.toBe(acrossSubmit.before)

    const acrossAppend = await runAsUser(user, async (db) => {
      const before = await readNextRevisionNo(db, decision)
      const appended = await appendRevision(db, {
        decisionId: decision,
        idempotencyToken: newId(),
        ...revisionPayload('instrument-append'),
      })
      const after = await readNextRevisionNo(db, decision)
      return { before, appended, after }
    })

    expect(acrossAppend.before).toBe(2)
    expect(acrossAppend.appended.revisionNo).toBe(2)
    expect(acrossAppend.after).toBe(3)
    expect(acrossAppend.after).not.toBe(acrossAppend.before)

    // The helper mirrors `app.append_revision`'s own `max(revision_no) + 1`
    // (migration 0004). It agreeing with what the function actually wrote is
    // what keeps the two from drifting.
    expect(await readRevisionNumbers(user, decision)).toEqual([1, 2])
  })
})

/* ================================================================== *
 * 2. DOUBLE SUBMIT
 * ================================================================== */

describe('double submit', () => {
  it('two concurrent submits with DIFFERENT tokens: one wins, the other raises ST010, exactly one revision survives', async () => {
    const user = await seedUser()
    const decision = await createDraftDecision(user)

    const leaderSubmitted = new Gate('leader completed submit_decision')
    const followerAtCall = new Gate('follower about to call submit_decision')
    const release = new Gate('release leader to commit')

    let leaderPid = 0
    let followerPid = 0

    const leader = runAsUser(user, async (db) => {
      leaderPid = await backendPid(db)
      const result = await submitDecision(db, {
        decisionId: decision,
        idempotencyToken: newId(),
        ...revisionPayload('leader'),
      })
      // The FOR UPDATE row lock taken inside app.submit_decision is held until
      // this transaction commits, which happens when withUser returns. Parking
      // here is what makes the follower's contention deterministic instead of a
      // matter of scheduling luck.
      leaderSubmitted.fire()
      await release.wait()
      return result
    })

    const follower = runAsUser(user, async (db) => {
      followerPid = await backendPid(db)
      await leaderSubmitted.wait()
      followerAtCall.fire()
      return submitDecision(db, {
        decisionId: decision,
        idempotencyToken: newId(),
        ...revisionPayload('follower'),
      })
    })

    const settled = settleTwo(leader, follower)
    let observed: Observed | undefined
    try {
      await followerAtCall.wait()
      observed = {
        probe: await waitForBlockDetail(followerPid, { timeoutMs: 2_500, pollIntervalMs: 25 }),
        simultaneity: await observeSimultaneousTransactions([leaderPid, followerPid]),
      }
    } finally {
      openAll(release)
    }
    const [leaderResult, followerResult] = await settled
    const { probe, simultaneity } = requireObserved(observed)

    // Genuine concurrency, two ways: the follower was parked on a lock, and both
    // backends were inside a transaction at one observed instant. The
    // privilege-free window proof is NOT available here, because the follower's
    // transaction aborts and cannot run another statement — see the append test.
    expect(
      probe.blocked,
      `the follower should have blocked on the row lock — ${describeProbe(probe)}`,
    ).toBe(true)
    expect(simultaneity.allOverlapping, simultaneity.detail).toBe(true)

    const winner = expectFulfilled(leaderResult, 'leader submit')
    expect(winner.replayed).toBe(false)
    expect(winner.revisionNo).toBe(1)

    // The follower blocked, then re-evaluated `submitted_at is null` against the
    // leader's committed row under READ COMMITTED, matched nothing, and raised.
    const error = asStatesmanError(expectRejected(followerResult, 'follower submit'), 'follower submit')
    expect(error).toBeInstanceOf(InvalidDecisionStateError)
    expect(error.sqlState).toBe('ST010')
    expect(error.kind).toBe('invalid_decision_state')

    // The after-state read is the part that cannot be faked: a row count of 0 is
    // never a success signal (V7), so the suite reads back what actually exists.
    expect(await readRevisionNumbers(user, decision)).toEqual([1])
    expect(await readDecisionState(user, decision)).toBe('submitted')
  })

  it('two concurrent submits with the SAME token: the follower is rejected with ST010 rather than replayed, and exactly one revision survives', async () => {
    const user = await seedUser()
    const decision = await createDraftDecision(user)
    const sharedToken = newId()

    const leaderSubmitted = new Gate('leader completed submit_decision')
    const followerAtCall = new Gate('follower about to call submit_decision')
    const release = new Gate('release leader to commit')

    let leaderPid = 0
    let followerPid = 0

    const leader = runAsUser(user, async (db) => {
      leaderPid = await backendPid(db)
      const result = await submitDecision(db, {
        decisionId: decision,
        idempotencyToken: sharedToken,
        ...revisionPayload('leader-same-token'),
      })
      leaderSubmitted.fire()
      await release.wait()
      return result
    })

    const follower = runAsUser(user, async (db) => {
      followerPid = await backendPid(db)
      await leaderSubmitted.wait()
      followerAtCall.fire()
      return submitDecision(db, {
        decisionId: decision,
        idempotencyToken: sharedToken,
        ...revisionPayload('follower-same-token'),
      })
    })

    const settled = settleTwo(leader, follower)
    let observed: Observed | undefined
    try {
      await followerAtCall.wait()
      observed = {
        probe: await waitForBlockDetail(followerPid, { timeoutMs: 2_500, pollIntervalMs: 25 }),
        simultaneity: await observeSimultaneousTransactions([leaderPid, followerPid]),
      }
    } finally {
      openAll(release)
    }
    const [leaderResult, followerResult] = await settled
    const { probe, simultaneity } = requireObserved(observed)

    expect(probe.blocked, describeProbe(probe)).toBe(true)
    expect(simultaneity.allOverlapping, simultaneity.detail).toBe(true)

    // THE SAFETY INVARIANT, asserted first and unconditionally: whatever the two
    // callers were told, the decision ends with exactly one revision and one
    // submitted_at stamp.
    expect(await readRevisionNumbers(user, decision)).toEqual([1])
    expect(await readDecisionState(user, decision)).toBe('submitted')

    const winner = expectFulfilled(leaderResult, 'leader submit')
    expect(winner.replayed).toBe(false)
    expect(winner.revisionNo).toBe(1)

    // ───────────────────────────────────────────────────────────────────────
    // MEASURED DIVERGENCE FROM THE IDEMPOTENCY PROPERTY — recorded, not
    // papered over.
    //
    // Canon §4.6b property 3 says "a replay of the same idempotency_token
    // returns the existing revision with replayed = true instead of raising".
    // That holds SEQUENTIALLY, and the next test is its positive control. It
    // does NOT hold for two genuinely concurrent callers, and the ordering in
    // migration 0004 is exactly why: `app.submit_decision` probes
    // `decision_revision` for the token BEFORE it takes the row lock
    // ("idempotency precedes the lock"). A concurrent twin therefore cannot see
    // the leader's uncommitted insert — READ COMMITTED shows it nothing — falls
    // through to the `for update`, blocks, and then fails the
    // `submitted_at is null` re-check. So it raises ST010 and never reaches the
    // `dr_token_uq` unique index that would have produced
    // IdempotencyReplayError.
    //
    // The safety property holds (exactly one revision; a retry issued after the
    // commit replays correctly). The liveness property does not: a client
    // retrying in flight is told "not a submittable draft" rather than handed
    // its own earlier result. This assertion pins the behaviour the cluster
    // actually has, so a future reordering of that function shows up here as a
    // red test rather than as a silent change of contract.
    // ───────────────────────────────────────────────────────────────────────
    const error = asStatesmanError(expectRejected(followerResult, 'follower submit'), 'follower submit')
    expect(error).toBeInstanceOf(InvalidDecisionStateError)
    expect(error.sqlState).toBe('ST010')
  })

  it('control: a SEQUENTIAL replay of the same token DOES return the existing revision with replayed=true', async () => {
    const user = await seedUser()
    const decision = await createDraftDecision(user)
    const sharedToken = newId()

    // Without this control, the ST010 above could mean "idempotency is broken
    // entirely" rather than "idempotency does not survive overlap". Same token,
    // same decision, two separate transactions, no overlap.
    const first = await runAsUser(user, async (db) =>
      submitDecision(db, {
        decisionId: decision,
        idempotencyToken: sharedToken,
        ...revisionPayload('sequential-first'),
      }),
    )
    const second = await runAsUser(user, async (db) =>
      submitDecision(db, {
        decisionId: decision,
        idempotencyToken: sharedToken,
        ...revisionPayload('sequential-replay'),
      }),
    )

    expect(first.replayed).toBe(false)
    expect(first.revisionNo).toBe(1)
    expect(second.replayed).toBe(true)
    expect(second.revisionNo).toBe(1)
    expect(second.revisionId).toBe(first.revisionId)
    expect(await readRevisionNumbers(user, decision)).toEqual([1])
  })
})

/* ================================================================== *
 * 3. CONCURRENT APPEND
 * ================================================================== */

describe('concurrent append', () => {
  it('two concurrent appends with different tokens get distinct, contiguous revision numbers and no dr_no_uq violation escapes', async () => {
    const user = await seedUser()
    const decision = await createDraftDecision(user)
    await runAsUser(user, async (db) =>
      submitDecision(db, {
        decisionId: decision,
        idempotencyToken: newId(),
        ...revisionPayload('base'),
      }),
    )

    const leaderAppended = new Gate('leader completed append_revision')
    const followerAtCall = new Gate('follower about to call append_revision')
    const release = new Gate('release leader to commit')

    let leaderPid = 0
    let followerPid = 0

    const leader = runAsUser(user, async (db) => {
      leaderPid = await backendPid(db)
      const result = await appendRevision(db, {
        decisionId: decision,
        idempotencyToken: newId(),
        ...revisionPayload('leader-append'),
      })
      leaderAppended.fire()
      await release.wait()
      const window = await readOwnTxWindow(db)
      return { result, window }
    })

    const follower = runAsUser(user, async (db) => {
      followerPid = await backendPid(db)
      await leaderAppended.wait()
      followerAtCall.fire()
      const result = await appendRevision(db, {
        decisionId: decision,
        idempotencyToken: newId(),
        ...revisionPayload('follower-append'),
      })
      // Read AFTER the blocked call returns, so this window's closing instant is
      // past the leader's. Both transactions survive here, which is why the
      // privilege-free overlap proof is available in this test and not in the
      // double-submit ones, where the follower's transaction aborts.
      const window = await readOwnTxWindow(db)
      return { result, window }
    })

    const settled = settleTwo(leader, follower)
    let observed: Observed | undefined
    try {
      await followerAtCall.wait()
      observed = {
        probe: await waitForBlockDetail(followerPid, { timeoutMs: 2_500, pollIntervalMs: 25 }),
        simultaneity: await observeSimultaneousTransactions([leaderPid, followerPid]),
      }
    } finally {
      openAll(release)
    }
    const [leaderResult, followerResult] = await settled
    const { probe, simultaneity } = requireObserved(observed)

    // Neither call may surface a raw unique violation: the parent row lock inside
    // app.append_revision is supposed to serialise them BEFORE either computes
    // max(revision_no) + 1. A dr_no_uq escape would show up as a rejection here.
    const leaderValue = expectFulfilled(leaderResult, 'leader append')
    const followerValue = expectFulfilled(followerResult, 'follower append')

    expect(
      probe.blocked,
      `the follower should have waited on the parent row lock — ${describeProbe(probe)}`,
    ).toBe(true)
    expect(simultaneity.allOverlapping, simultaneity.detail).toBe(true)
    expect(
      windowsOverlap(leaderValue.window, followerValue.window),
      `measured windows do not intersect: ${describeWindows(leaderValue.window, followerValue.window)}`,
    ).toBe(true)

    expect(leaderValue.result.replayed).toBe(false)
    expect(followerValue.result.replayed).toBe(false)
    expect(leaderValue.result.revisionNo).toBe(2)
    expect(followerValue.result.revisionNo).toBe(3)
    expect(leaderValue.result.revisionNo).not.toBe(followerValue.result.revisionNo)
    expect(leaderValue.result.revisionId).not.toBe(followerValue.result.revisionId)

    // Distinct AND contiguous, read back from the table rather than inferred from
    // the two return values.
    const numbers = await readRevisionNumbers(user, decision)
    expect(numbers).toEqual([1, 2, 3])
    expect(new Set(numbers).size).toBe(numbers.length)
    for (let i = 1; i < numbers.length; i += 1) {
      const previous = numbers[i - 1]
      const current = numbers[i]
      if (previous === undefined || current === undefined) throw new Error('unreachable')
      expect(current - previous).toBe(1)
    }
  })
})

/* ================================================================== *
 * 4. NEGATIVE CONTROL FOR THE RACE ITSELF (V23)
 * ================================================================== */

describe('the race instrument itself', () => {
  it('an unguarded read-then-write overlaps completely while NEVER waiting on a lock, so overlap — not lock detection — is the concurrency instrument', async () => {
    const user = await seedUser()
    const decision = await createDraftDecision(user)
    await runAsUser(user, async (db) =>
      submitDecision(db, {
        decisionId: decision,
        idempotencyToken: newId(),
        ...revisionPayload('base'),
      }),
    )

    const leaderRead = new Gate('leader read max(revision_no) and took NO lock')
    const followerAtWrite = new Gate('follower about to insert, unguarded')
    const followerInserted = new Gate('follower insert returned')
    const release = new Gate('release both')

    let leaderPid = 0
    let followerPid = 0
    // The leader's own `next` and window have to be captured here rather than
    // returned, because its transaction aborts on the duplicate key and the
    // promise rejects before any return value escapes.
    let leaderNext = -1
    let leaderWindow: TxWindow | undefined

    // The leader reads and then does NOTHING. This is the shape V23 reproduced:
    // a read with no FOR UPDATE acquires no row lock, so there is nothing for a
    // concurrent writer to wait on.
    const leader = runAsUser(user, async (db) => {
      leaderPid = await backendPid(db)
      leaderNext = await readNextRevisionNo(db, decision)
      leaderRead.fire()
      await release.wait()
      // Read the window BEFORE the write that aborts this transaction. Its
      // closing instant is past the follower's own closing instant, which is
      // what lets the privilege-free overlap proof close the interval from this
      // side even though this promise ultimately rejects.
      leaderWindow = await readOwnTxWindow(db)
      await insertRevisionUnguarded(db, {
        decisionId: decision,
        revisionNo: leaderNext,
        idempotencyToken: newId(),
        payload: revisionPayload('leader-unguarded'),
      })
      return leaderNext
    })

    const follower = runAsUser(user, async (db) => {
      followerPid = await backendPid(db)
      await leaderRead.wait()
      const next = await readNextRevisionNo(db, decision)
      followerAtWrite.fire()
      await insertRevisionUnguarded(db, {
        decisionId: decision,
        revisionNo: next,
        idempotencyToken: newId(),
        payload: revisionPayload('follower-unguarded'),
      })
      followerInserted.fire()
      await release.wait()
      const window = await readOwnTxWindow(db)
      return { next, window }
    })

    const settled = settleTwo(leader, follower)
    let observed: Observed | undefined
    try {
      await followerAtWrite.wait()
      // This window OPENS before the follower's insert is issued and stays open
      // across it, so a Lock wait during that write would be sampled. The SAME
      // probe, with the same shape and the same timeout, returns true in the
      // guarded-append test above — which is the control proving this `false` is
      // sensitivity rather than blindness.
      const probe = await waitForBlockDetail(followerPid, { timeoutMs: 700, pollIntervalMs: 20 })
      await followerInserted.wait()
      observed = {
        probe,
        simultaneity: await observeSimultaneousTransactions([leaderPid, followerPid]),
      }
    } finally {
      // The follower's insert has already happened by this point, so the leader
      // is deterministically the loser whatever order the two are released in.
      // The release order only decides whether the leader waits briefly on an
      // uncommitted index entry before getting its 23505, which no assertion
      // below depends on.
      openAll(release)
    }
    const [leaderResult, followerResult] = await settled
    const { probe, simultaneity } = requireObserved(observed)

    const followerValue = expectFulfilled(followerResult, 'follower unguarded insert')
    const leaderError = asStatesmanError(
      expectRejected(leaderResult, 'leader unguarded insert'),
      'leader unguarded insert',
    )

    // 1. THE HAZARD: both transactions computed the SAME next revision number
    //    from their own snapshots. This comparison is evidence only because the
    //    instrument test above showed the helper can disagree with itself.
    expect(leaderNext).toBe(2)
    expect(followerValue.next).toBe(2)
    expect(followerValue.next).toBe(leaderNext)

    // 2. NO LOCK WAIT EVER APPEARED (V23), from an observer separately proven
    //    able to see one.
    expect(
      probe.blocked,
      `an unguarded read-then-write must not block — ${describeProbe(probe)}`,
    ).toBe(false)
    expect(
      probe.observedState,
      'the observer was blind, so "never blocked" here would not be a measurement (V24) — ' +
        describeProbe(probe),
    ).toBe(true)
    expect(probe.seen).not.toContain('active/Lock')

    // 3. ...AND YET THE TWO TRANSACTIONS OVERLAPPED. This is the whole point:
    //    had this test used lock-wait detection as its overlap probe, it would
    //    have concluded "not concurrent" about the most dangerous interleaving
    //    in the system. The rendezvous plus xact_start is the instrument for
    //    concurrency; lock detection only answers whether the GUARDED path
    //    serialises.
    expect(simultaneity.allOverlapping, simultaneity.detail).toBe(true)
    expect(simultaneity.missing).toEqual([])
    expect(simultaneity.inTransaction).toHaveLength(2)
    if (leaderWindow === undefined) {
      throw new Error('the leader never read its own transaction window')
    }
    expect(
      windowsOverlap(leaderWindow, followerValue.window),
      `measured windows do not intersect: ${describeWindows(leaderWindow, followerValue.window)}`,
    ).toBe(true)

    // 4. The damage lands at the LEADER's write, long after the overlap, as a
    //    retryable dr_no_uq conflict — not as a wait.
    expect(leaderError).toBeInstanceOf(RevisionNumberConflictError)
    expect(leaderError.sqlState).toBe('23505')
    expect(leaderError.constraintName).toBe('dr_no_uq')
    expect(leaderError.retryable).toBe(true)
    expect(leaderError.kind).toBe('revision_number_conflict')

    // 5. After-state: the follower's revision 2 survived and the leader's did
    //    not. Contrast the guarded path, which produced 2 AND 3 from the same
    //    interleaving.
    expect(await readRevisionNumbers(user, decision)).toEqual([1, 2])
  })
})
