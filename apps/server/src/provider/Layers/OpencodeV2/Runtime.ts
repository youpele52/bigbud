import { Effect } from "effect";
import type { OpenCodeEvent } from "@opencode/client";
import { RuntimeItemId } from "@bigbud/contracts/core/baseSchemas";
import type {
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import { prepareV2RuntimeSession, releaseV2PreparedSession } from "./Runtime.preparation.ts";
import { correlatedProjection, readV2Messages, runtimeEventBase } from "./Runtime.projection.ts";
import { pendingV2Interactions, replyV2Permission, replyV2Form } from "./Runtime.interactions.ts";
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
import { v2RuntimeStatus } from "./Runtime.status.ts";
import { emitV2RuntimeEvent } from "./Runtime.events.ts";
import { needsV2FinalRepair } from "./Runtime.finalization.ts";
import { V2RuntimeTeardown } from "./Runtime.teardown.ts";
import { V2RuntimeMutations } from "./Runtime.mutations.ts";
import { sendV2Turn } from "./Runtime.send.ts";
import { installV2UnsupportedFormCanceller } from "./Runtime.forms.unsupported.ts";

/** Owned preview execution engine shared by application routing and disposable conformance harnesses. */
export class OpencodeV2Runtime {
  readonly sessions = new Map<ThreadId, V2RuntimeSession>();
  private readonly starting = new Map<ThreadId, V2StartAttempt>();
  readonly teardown: V2RuntimeTeardown;
  readonly mutations = new V2RuntimeMutations();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(readonly options: V2IsolatedRuntimeOptions) {
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
        if (
          session.stopped
            ? needsV2FinalRepair(session)
            : session.row &&
              (session.row.state !== "terminal" ||
                !session.terminalDelivered ||
                session.lease.hub.isDirty(session.native.id))
        ) {
          this.scheduleRepair(session);
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
    return this.exclusive(session, async () => {
      if (this.get(threadId) !== session) throw new Error("V2 stale session operation owner.");
      return operation();
    });
  }

  async emit(session: V2RuntimeSession, event: ProviderRuntimeEvent) {
    return emitV2RuntimeEvent(session, event, this.options.emit);
  }

  async start(
    input: ProviderSessionStartInput,
    attempt = new V2StartAttempt(),
    disableTools = false,
  ) {
    this.mutations.assertSafe();
    await Effect.runPromise(this.options.journal.assertOwnerAvailable(input.threadId));
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
      session = { ...created, unregister: () => {}, unsubscribeDeath: () => {} };
      this.mutations.assertSafe();
      const owner = session;
      if (this.closed || attempt.controller.signal.aborted) {
        await releaseV2PreparedSession(owner);
        throw new Error("V2 late session start disposed.");
      }
      const unregister = owner.lease.hub.register({
        nativeSessionId: owner.native.id,
        location: owner.native.location.directory,
        onEvent: (event, signal) =>
          this.exclusive(owner, async () => {
            if (!signal.aborted) await this.onEvent(owner, event);
          }),
        onDirty: () => {
          this.scheduleRepair(owner);
        },
      });
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
      installV2UnsafePermissionRejector(this, owner);
      installV2UnsupportedFormCanceller(this, owner);
      await this.options.codingBridge?.attach(owner, this);
      attempt.owner = owner;
      // Startup repair participates in the same queue as hub/poll/user operations.
      await this.exclusive(owner, () => recoverV2Session(this, owner));
      attempt.controller.signal.throwIfAborted();
      return owner.session;
    } catch (error) {
      if (session) {
        session.stopped = true;
        session.coding?.revoke();
        session.unregister();
        session.unsubscribeDeath();
        if (this.sessions.get(input.threadId) === session) this.sessions.delete(input.threadId);
        await releaseV2PreparedSession(session);
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

  scheduleRepair(session: V2RuntimeSession) {
    session.dirtyGeneration++;
    if (session.repairQueued || (session.stopped && !needsV2FinalRepair(session)) || this.closed)
      return;
    session.repairQueued = true;
    void this.exclusive(session, async () => {
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
          this.scheduleRepair(session);
      }
    }).catch(() => {});
  }

  async send(input: ProviderSendTurnInput) {
    return sendV2Turn(this, input);
  }

  private async onEvent(session: V2RuntimeSession, event: OpenCodeEvent) {
    if (session.stopped || !session.row || session.row.state !== "accepted") return;
    if (event.type === "session.text.delta" || event.type === "session.reasoning.delta") {
      if (!session.messages.has(event.data.assistantMessageID)) {
        const projection = correlatedProjection(session, await readV2Messages(session));
        if (!projection) {
          return;
        }
        for (const message of projection.assistants) session.messages.set(message.id, message);
      }
      const message = session.messages.get(event.data.assistantMessageID);
      if (
        !message ||
        message.type !== "assistant" ||
        message.time.completed !== undefined ||
        session.stopped
      )
        return;
      await this.emit(session, {
        ...runtimeEventBase(session, event.id, event.created),
        itemId: RuntimeItemId.makeUnsafe(
          event.type === "session.text.delta"
            ? event.data.assistantMessageID
            : `${event.data.assistantMessageID}:reasoning`,
        ),
        type: "content.delta",
        payload: {
          streamKind: event.type === "session.text.delta" ? "assistant_text" : "reasoning_text",
          delta: event.data.delta,
          contentIndex: event.data.ordinal,
        },
      });
    } else await this.reconcile(session);
  }

  async reconcile(session: V2RuntimeSession) {
    return reconcileV2Runtime(this, session);
  }

  private async processLost(session: V2RuntimeSession) {
    return v2RuntimeProcessLost(this, session);
  }

  async inspect(threadId: ThreadId, turnId: TurnId) {
    const session = this.get(threadId);
    return this.exclusive(session, async () => {
      await this.reconcile(session);
      const observedAt = new Date().toISOString();
      if (!session.row || session.row.turnId !== turnId)
        return { status: "missing" as const, observedAt };
      const projection = correlatedProjection(session, await readV2Messages(session));
      if (projection?.idle && session.row.state === "terminal")
        return {
          status:
            projection.idle.outcome === "succeeded"
              ? ("completed" as const)
              : projection.idle.outcome === "failed"
                ? ("failed" as const)
                : ("unavailable" as const),
          observedAt,
          ...(projection.idle.outcome === "succeeded"
            ? { completionEvidence: { source: "v2.correlated-idle" } }
            : { errorEvidence: { source: "v2.correlated-idle" } }),
        };
      if ((await pendingV2Interactions(session)).length)
        return { status: "waiting-for-user" as const, observedAt };
      const active = await v2Request("session.active", (signal) =>
        session.lease.process.client.session.active({ signal }),
      );
      return {
        status:
          active[session.native.id] && projection ? ("running" as const) : ("unavailable" as const),
        observedAt,
      };
    });
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
    return this.exclusive(session, () => readV2Thread(session, this.options.journal));
  }

  async catalog(threadId: ThreadId) {
    const session = this.get(threadId);
    const catalog = await v2Request("model.list", (signal) =>
      session.lease.process.client.model.list(
        { location: { directory: session.native.location.directory } },
        { signal },
      ),
    );
    return normalizeV2Catalog(catalog, session.native.location.directory);
  }

  async stop(threadId: ThreadId, expected?: V2RuntimeSession) {
    if (!expected) this.starting.get(threadId)?.controller.abort();
    await this.teardown.stop(threadId, expected);
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
