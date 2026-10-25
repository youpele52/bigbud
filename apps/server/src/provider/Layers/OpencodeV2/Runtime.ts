import { Effect } from "effect";
import { settleV2RuntimeReservation } from "./Runtime.activation.ts";
import {
  shouldPollV2Runtime,
  hasV2RetainedReservation,
  repairV2RetainedReservation,
} from "./Runtime.settlement.ts";
import type {
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import { prepareV2RuntimeSession, releaseV2PreparedSession } from "./Runtime.preparation.ts";
import { replyV2Permission, replyV2Form } from "./Runtime.interactions.ts";
import type { V2IsolatedRuntimeOptions, V2RuntimeSession } from "./Runtime.types.ts";
import { v2Request } from "./Client.ts";
import { observeV2ProcessLifecycle } from "./Runtime.lifecycle.ts";
import { normalizeV2Catalog } from "./Catalog.ts";
import { reconcileV2Runtime, v2RuntimeProcessLost } from "./Runtime.recovery.ts";
import { readV2Thread } from "./Runtime.read.ts";
import { recoverV2Session, V2StartAttempt } from "./Runtime.start.ts";
import {
  respondV2Permission,
  respondV2Form,
  interruptV2Execution,
  installV2UnsafePermissionRejector,
} from "./Runtime.replies.ts";
import { emitV2RuntimeEvent, isV2FinalLifecycleEvent } from "./Runtime.events.ts";
import { needsV2FinalRepair } from "./Runtime.finalization.ts";
import { V2RuntimeTeardown } from "./Runtime.teardown.ts";
import { V2RuntimeMutations } from "./Runtime.mutations.ts";
import { sendV2Turn } from "./Runtime.send.ts";
import { installV2UnsupportedFormCanceller } from "./Runtime.forms.unsupported.ts";
import { runAuthorizedV2, runV2Cleanup, currentV2RequestContext } from "./Client.guard.ts";
import { inspectV2Turn } from "./Runtime.inspect.ts";
import { registerV2RuntimeOwner } from "./Runtime.registration.owner.ts";
import type { V2ProcessConfig } from "./ServerManager.child.ts";
import { watchV2OutputPublication } from "./Runtime.publication.failure.ts";
import { attachV2OwnedFamily } from "./Runtime.family.ts";
import { retireV2FailedStart } from "./Runtime.start.failure.ts";

/** Owned preview execution engine shared by application routing and disposable conformance harnesses. */
export class OpencodeV2Runtime<C extends V2ProcessConfig = V2ProcessConfig> {
  readonly sessions = new Map<ThreadId, V2RuntimeSession>();
  private readonly starting = new Map<ThreadId, V2StartAttempt>();
  /** Retiring an owner cannot discard an in-progress native session creation. */
  hasPendingStart(threadId: ThreadId) {
    return this.starting.has(threadId);
  }
  readonly teardown: V2RuntimeTeardown;
  readonly mutations = new V2RuntimeMutations();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(readonly options: V2IsolatedRuntimeOptions<C>) {
    this.teardown = new V2RuntimeTeardown({
      sessions: this.sessions,
      serialize: (owner, run) => this.exclusive(owner, run),
      emit: (owner, event) => this.emit(owner, event),
      finalizeLoss: (owner) => this.processLost(owner),
    });
    const interval = options.pollIntervalMs ?? 1000;
    if (
      !Number.isFinite(interval) ||
      interval < 100 ||
      !Number.isSafeInteger(options.maxSessions ?? 25) ||
      (options.maxSessions ?? 25) < 1
    )
      throw new Error("V2 runtime bounds rejected.");
    this.timer = setInterval(() => {
      for (const session of this.sessions.values()) {
        if (shouldPollV2Runtime(session)) {
          this.scheduleRepair(session, false);
        }
      }
    }, interval);
    this.timer.unref();
  }

  private exclusive<T>(session: V2RuntimeSession, run: () => Promise<T>): Promise<T> {
    const pending = session.operation.then(run, run);
    session.operation = pending.catch(() => {});
    return pending;
  }

  get(threadId: ThreadId): V2RuntimeSession {
    const session = this.sessions.get(threadId);
    if (!session || session.stopped) throw new Error("V2 session is not owned by this runtime.");
    return session;
  }

  withSession<T>(threadId: ThreadId, operation: () => Promise<T>): Promise<T> {
    const session = this.get(threadId);
    return this.authorized(() =>
      this.exclusive(session, async () => {
        if (this.get(threadId) !== session) throw new Error("V2 stale session operation owner.");
        session.consentPermit?.assertCurrent();
        return operation();
      }),
    );
  }

  authorized<T>(run: () => Promise<T>) {
    return runAuthorizedV2(
      this.options.consent,
      this.options.config.sharedService?.registrationFile,
      run,
    );
  }
  withCleanupSession<T>(threadId: ThreadId, operation: () => Promise<T>): Promise<T> {
    const session = this.get(threadId);
    return runV2Cleanup(session.sharedTransport, session.native.id, () =>
      this.exclusive(session, async () => {
        if (this.get(threadId) !== session) throw new Error("V2 stale cleanup owner.");
        return operation();
      }),
    );
  }

  async emit(session: V2RuntimeSession, event: ProviderRuntimeEvent, validate?: () => void) {
    const lifecycle = session.stopped && isV2FinalLifecycleEvent(event);
    const epoch = session.epoch;
    const hubGeneration = session.lease.hub.generation(session.native.id);
    const dirtyGeneration = session.dirtyGeneration;
    const fence = () => {
      validate?.();
      const current = this.sessions.get(session.threadId);
      // Owned isolated shutdown already drains its admitted final output in this queue.
      // Shared host-user execution instead rejects output arriving after owner disposal.
      const settlingIsolated = session.stopped && !session.sharedTransport;
      if (
        (current && current !== session) ||
        (!lifecycle &&
          !settlingIsolated &&
          (current !== session ||
            session.stopped ||
            session.epoch !== epoch ||
            session.dirtyGeneration !== dirtyGeneration ||
            session.lease.hub.generation(session.native.id) !== hubGeneration))
      )
        throw new Error("V2 stale event owner/generation rejected.");
    };
    const publish = () => emitV2RuntimeEvent(session, event, this.options.emit, fence);
    if (!lifecycle) watchV2OutputPublication(this, session, event, epoch);
    return lifecycle
      ? runV2Cleanup(session.sharedTransport, session.native.id, publish)
      : publish();
  }

  start(input: ProviderSessionStartInput, attempt = new V2StartAttempt(), disableTools = false) {
    return this.authorized(() => this.startAuthorized(input, attempt, disableTools));
  }

  private async startAuthorized(
    input: ProviderSessionStartInput,
    attempt = new V2StartAttempt(),
    disableTools = false,
  ) {
    this.mutations.assertSafe();
    await Effect.runPromise(this.options.journal.assertOwnerAvailable(input.threadId));
    currentV2RequestContext()?.permit.assertCurrent();
    if (
      this.closed ||
      attempt.controller.signal.aborted ||
      this.starting.has(input.threadId) ||
      this.teardown.has(input.threadId) ||
      this.sessions.has(input.threadId) ||
      this.starting.size + this.teardown.capacity() >= (this.options.maxSessions ?? 25)
    )
      throw new Error("V2 session capacity/ownership rejected.");
    this.starting.set(input.threadId, attempt);
    let session: V2RuntimeSession | undefined;
    try {
      const created = await prepareV2RuntimeSession(
        this.options,
        input,
        this.mutations,
        attempt.controller.signal,
        disableTools,
      );
      if (created.activation?.token) attempt.phase = "reserved";
      session = {
        ...created,
        ...(this.options.config.sharedService
          ? {
              sharedTransport: this.options.config.sharedService.registrationFile,
              consentPermit: this.options.consent?.capture(),
            }
          : {}),
        unregister: () => {},
        unsubscribeDeath: () => {},
      };
      currentV2RequestContext()?.permit.assertCurrent();
      this.mutations.assertSafe();
      const owner = session;
      if (this.closed || attempt.controller.signal.aborted) {
        await releaseV2PreparedSession(owner);
        throw new Error("V2 late session start disposed.");
      }
      const unregister = registerV2RuntimeOwner(this, owner, (run) => this.exclusive(owner, run));
      const unsubscribeDeath = observeV2ProcessLifecycle(owner.lease.process, () => {
        owner.stopped = true;
        owner.coding?.revoke();
        void this.exclusive(owner, () => this.processLost(owner)).catch(() =>
          this.scheduleRepair(owner),
        );
      });
      // All callbacks must reference the same mutable owner.
      Object.assign(owner, { unregister, unsubscribeDeath });
      session = owner;
      this.sessions.set(input.threadId, owner);
      await attachV2OwnedFamily(this, owner);
      installV2UnsafePermissionRejector(this, owner);
      installV2UnsupportedFormCanceller(this, owner);
      await this.options.codingBridge?.attach(owner, this);
      attempt.owner = owner;
      // Startup repair participates in the same queue as hub/poll/user operations.
      await this.exclusive(owner, () => recoverV2Session(this, owner));
      await this.options.threadBridge?.attach(owner, this);
      if (
        owner.activation?.token &&
        (owner.row?.state === "dispatch-intent" || owner.row?.state === "accepted")
      ) {
        owner.activation.gate.nativeRunning(owner.activation.token);
        attempt.phase = "native-running";
      }
      await settleV2RuntimeReservation(this, owner);
      if (!owner.activation?.token) attempt.phase = "settled";
      attempt.controller.signal.throwIfAborted();
      currentV2RequestContext()?.permit.assertCurrent();
      owner.consentPermit?.assertCurrent();
      return owner.session;
    } catch (error) {
      if (session?.activation?.token) {
        session.activation.phase = "uncertain";
        attempt.phase = "uncertain";
      }
      if (session) {
        await retireV2FailedStart(this, session);
      }
      throw error;
    } finally {
      if (this.starting.get(input.threadId) === attempt) this.starting.delete(input.threadId);
    }
  }

  async cancelStart(attempt: V2StartAttempt) {
    attempt.controller.abort();
    if (attempt.owner) await this.stop(attempt.owner.threadId, attempt.owner);
  }

  scheduleRepair(session: V2RuntimeSession, invalidate = true) {
    try {
      session.consentPermit?.assertCurrent();
    } catch {
      return;
    }
    if (invalidate) session.dirtyGeneration++;
    if (session.repairQueued || (session.stopped && !needsV2FinalRepair(session)) || this.closed)
      return;
    session.repairQueued = true;
    void this.authorized(() =>
      this.exclusive(session, async () => {
        session.consentPermit?.assertCurrent();
        const generation = session.dirtyGeneration;
        const hubGeneration = session.lease.hub.generation(session.native.id);
        try {
          await this.reconcile(session);
        } finally {
          session.repairQueued = false;
          if (
            session.dirtyGeneration !== generation ||
            session.lease.hub.generation(session.native.id) !== hubGeneration
          )
            this.scheduleRepair(session, false);
        }
      }),
    ).catch(() => {
      session.repairQueued = false;
    });
  }

  async send(input: ProviderSendTurnInput) {
    return this.authorized(() => sendV2Turn(this, input));
  }

  async reconcile(session: V2RuntimeSession) {
    session.consentPermit?.assertCurrent();
    return this.authorized(async () => {
      if (
        hasV2RetainedReservation(session) &&
        !session.family?.live &&
        !needsV2FinalRepair(session) &&
        !session.publicationUnconfirmed &&
        !session.lease.hub.isDirty(session.native.id)
      )
        return repairV2RetainedReservation(this, session);
      const result = await reconcileV2Runtime(this, session);
      await settleV2RuntimeReservation(this, session);
      return result;
    });
  }

  private async processLost(session: V2RuntimeSession) {
    return v2RuntimeProcessLost(this, session);
  }

  async inspect(threadId: ThreadId, turnId: TurnId) {
    return inspectV2Turn(this, threadId, turnId);
  }

  async interrupt(threadId: ThreadId, turnId?: TurnId) {
    return interruptV2Execution(this, threadId, turnId);
  }

  async respondPermission(
    threadId: ThreadId,
    id: string,
    decision: Parameters<typeof replyV2Permission>[2],
  ) {
    return respondV2Permission(this, threadId, id, decision);
  }

  async respondForm(threadId: ThreadId, id: string, answers: Parameters<typeof replyV2Form>[2]) {
    return respondV2Form(this, threadId, id, answers);
  }

  async read(threadId: ThreadId) {
    const session = this.get(threadId);
    return this.withSession(threadId, () => readV2Thread(session, this.options.journal));
  }

  async catalog(threadId: ThreadId) {
    const session = this.get(threadId);
    return this.withSession(threadId, async () => {
      const catalog = await v2Request("model.list", (signal) =>
        session.lease.process.client.model.list(
          { location: { directory: session.native.location.directory } },
          { signal },
        ),
      );
      return normalizeV2Catalog(catalog, session.native.location.directory);
    });
  }

  async stop(threadId: ThreadId, expected?: V2RuntimeSession) {
    if (!expected) this.starting.get(threadId)?.controller.abort();
    const owner = expected ?? this.sessions.get(threadId);
    const familyFence =
      owner && (!expected || this.sessions.get(threadId) === expected)
        ? owner.family?.fence()
        : undefined;
    await runV2Cleanup(owner?.sharedTransport, owner?.native.id ?? "", async () => {
      const settled = await Promise.allSettled([
        familyFence,
        owner?.familyControl?.fence(),
        this.teardown.stop(threadId, expected),
      ]);
      const failed = settled.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    });
  }

  async close() {
    this.closed = true;
    for (const attempt of this.starting.values()) attempt.controller.abort();
    clearInterval(this.timer);
    this.teardown.beginShutdown();
    try {
      await this.teardown.drain();
    } finally {
      await this.options.manager.close();
      this.teardown.releaseDead();
    }
    this.mutations.assertSafe();
  }
}
