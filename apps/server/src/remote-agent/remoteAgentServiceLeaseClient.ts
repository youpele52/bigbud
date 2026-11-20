import { readFile } from "node:fs/promises";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import { assertRemoteAgentRuntimeHello } from "./remoteAgentCompatibility.ts";
import type {
  RemoteAgentServiceLeaseController as Controller,
  RemoteAgentServiceLeaseResponse as Response,
  RemoteAgentServiceLeaseStart as Start,
} from "./remoteAgentProtocol.serviceLease.ts";
import { NativeLeaseIo } from "./remoteAgentServiceLease.io.ts";
import {
  NativeLeaseTokens,
  type AttachingNativeLease,
  type PendingOriginalNativeLease,
  type VerifiedNativeLease,
} from "./remoteAgentServiceLease.tokens.ts";
export type {
  AttachingNativeLease,
  PendingOriginalNativeLease,
  VerifiedNativeLease,
  ConfirmedNativeLeaseExit,
  ConfirmedNativeCancelFence,
  OriginalNeverInvoked,
} from "./remoteAgentServiceLease.tokens.ts";
import {
  nativeLeaseBindingView,
  equalNativeLeaseBinding,
  type NativeLeaseRestore,
} from "./remoteAgentServiceLease.identity.ts";
import type { OriginalNativeLeaseAttempt } from "./remoteAgentServiceLease.attempt.ts";
export type {
  NativeLeaseBindingView,
  NativeLeaseEvidence,
  NativeLeaseExitEvidence,
  NativeLeaseCancellationEvidence,
  NativeLeaseRestore,
} from "./remoteAgentServiceLease.identity.ts";
export type { OriginalNativeLeaseAttempt } from "./remoteAgentServiceLease.attempt.ts";
/** Resume outcome. Only "live" is readiness; "attaching" needs a verified successor socket. */
export type NativeLeaseResumption =
  | { readonly state: "live"; readonly lease: VerifiedNativeLease }
  | { readonly state: "attaching"; readonly attaching: AttachingNativeLease };
const originalClients = new WeakSet<object>();
async function actualController(): Promise<Controller> {
  const [stat, boot] = await Promise.all([
    readFile(`/proc/${process.pid}/stat`, "utf8"),
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
  ]);
  const started = stat.slice(stat.lastIndexOf(") ") + 2).split(/\s+/)[19];
  if (
    stat.length > 8192 ||
    boot.length > 64 ||
    !started ||
    !/^\d+$/.test(started) ||
    !boot.trim() ||
    process.pid <= 1
  )
    throw Error("Actual native owner controller identity unavailable.");
  return Object.freeze({ pid: process.pid, boot: boot.trim(), started });
}
const sameController = (a: Controller | undefined, b: Controller) =>
  !!a && a.pid === b.pid && a.boot === b.boot && a.started === b.started;
const validController = (a: Controller | undefined) =>
  !!a &&
  Number.isInteger(a.pid) &&
  a.pid > 1 &&
  a.boot.length > 0 &&
  a.boot.length <= 64 &&
  /^\d{1,32}$/.test(a.started);
/** New dedicated direct local proxy only; never reuse the PTY connection/listeners. */
export async function connectNativeServiceLeaseClient(
  connection: RemoteAgentConnection,
  input: {
    readonly nativeEpoch: string;
    readonly stateDir: string;
    readonly expectedRuntime?: RemoteAgentRuntime;
  },
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const hello = await Promise.race([
      connection.handshake(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Error("Managed native handshake deadline elapsed.")), 5000);
      }),
    ]);
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (input.expectedRuntime) assertRemoteAgentRuntimeHello(input.expectedRuntime, hello);
    const capabilities = hello.capabilities.filter((cap) => cap.name === "service.lease");
    const capability = capabilities[0];
    if (
      hello.agentEpoch !== input.nativeEpoch ||
      hello.protocolMinor < 8 ||
      !connection.supportsCapability("service.lease") ||
      capabilities.length !== 1 ||
      !capability ||
      capability.major !== 1 ||
      !Number.isInteger(capability.minor) ||
      capability.minor < 1
    )
      throw Error("Managed native service lease capability unavailable.");
    return makeClient(
      new NativeLeaseIo(connection),
      new NativeLeaseTokens(input.nativeEpoch, input.stateDir),
      await actualController(),
      capability.minor,
    );
  } catch (cause) {
    await connection.closeConfirmed();
    throw cause;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function makeClient(
  io: NativeLeaseIo,
  tokens: NativeLeaseTokens,
  controller: Controller,
  capabilityMinor: number,
) {
  const requireActivation = () => {
    io.assertOpen();
    if (capabilityMinor < 2) throw Error("Native guard-v2 activation capability unavailable.");
  };
  function reply(token: PendingOriginalNativeLease, value: Response, bootstrap = false) {
    const record = tokens.original(token);
    if (
      !value.accepted ||
      !equalNativeLeaseBinding(value.binding, record.reference.binding) ||
      (!bootstrap && value.bootstrap.length)
    )
      throw Error("Native lease operation was refused or remains uncertain.");
    return value;
  }
  function correlate(token: PendingOriginalNativeLease, value: Response, state: string) {
    reply(token, value, true);
    if (
      value.state !== state ||
      !Number.isSafeInteger(value.generation) ||
      value.generation < 1 ||
      value.originalChildPid <= 1 ||
      !validController(value.originalController) ||
      !sameController(value.currentController, controller)
    )
      throw Error("Native lease grant is not correlated to the actual controller.");
  }
  function live(token: PendingOriginalNativeLease, value: Response) {
    correlate(token, value, "spawned");
    return tokens.grant(token, value);
  }
  /** Native took over the original child for this controller; its socket is not verified yet. */
  function successor(token: PendingOriginalNativeLease, value: Response) {
    correlate(token, value, "attaching");
    if (
      !validController(value.previousController) ||
      sameController(value.previousController, controller) ||
      !value.bootstrap.length
    )
      throw Error("Native successor takeover lacks a distinct prior controller or bootstrap.");
  }
  function resumption(token: PendingOriginalNativeLease, value: Response): NativeLeaseResumption {
    if (value.state !== "attaching") return { state: "live", lease: live(token, value) };
    successor(token, value);
    return { state: "attaching", attaching: tokens.attaching(token, value) };
  }
  async function query(
    token: PendingOriginalNativeLease,
    kind: "serviceLeaseStatusRequest" | "serviceLeaseResumeRequest",
    signal?: AbortSignal,
  ) {
    const { reference: start } = tokens.original(token);
    return io.request(
      (id) => ({
        type: kind,
        value: { requestId: id, binding: start.binding, capability: start.capability },
      }),
      signal,
    );
  }
  async function control(
    token: PendingOriginalNativeLease,
    action: string,
    generation: number,
    signal?: AbortSignal,
  ) {
    const { reference: start } = tokens.original(token);
    return reply(
      token,
      await io.request(
        (id) => ({
          type: "serviceLeaseControlRequest",
          value: {
            requestId: id,
            binding: start.binding,
            capability: start.capability,
            action,
            generation,
          },
        }),
        signal,
      ),
    );
  }
  const client = Object.freeze({
    assertActivationCapability: requireActivation,
    beginAttempt() {
      requireActivation();
      return tokens.beginAttempt();
    },
    attemptNonce: (token: OriginalNativeLeaseAttempt) => tokens.attemptNonce(token),
    prepareStart(attempt: OriginalNativeLeaseAttempt, input: Start) {
      requireActivation();
      return tokens.prepare(attempt, input);
    },
    /** Retained canonical intent only. It can never produce OriginalNeverInvoked. */
    restorePending(input: NativeLeaseRestore) {
      io.assertOpen();
      return tokens.restore(input);
    },
    binding: (token: PendingOriginalNativeLease) => tokens.binding(token),
    original: (token: PendingOriginalNativeLease) => tokens.originalView(token),
    exitEvidence: tokens.exitView.bind(tokens),
    originalNeverInvoked: (token: PendingOriginalNativeLease) => tokens.neverInvoked(token),
    cancellationEvidence: tokens.cancellation.bind(tokens),
    evidence: tokens.view.bind(tokens),
    async start(token: PendingOriginalNativeLease, signal?: AbortSignal) {
      requireActivation();
      signal?.throwIfAborted();
      const start = tokens.invoke(token);
      const response = await io.request(
        (id) => ({ type: "serviceLeaseStartRequest", value: { ...start, requestId: id } }),
        signal,
      );
      reply(token, response);
      return live(token, response);
    },
    async reconcile(token: PendingOriginalNativeLease, signal?: AbortSignal) {
      const response = reply(token, await query(token, "serviceLeaseStatusRequest", signal));
      if (response.state === "exited")
        return { state: "exited" as const, exit: tokens.terminal(token, response) };
      if (response.state === "cancelled")
        return { state: "cancelled" as const, cancellation: tokens.cancelled(token, response) };
      if (response.state === "spawned")
        return { state: "live" as const, lease: live(token, response) };
      throw Error("Original native acceptance remains uncertain; preserve its assets and pin.");
    },
    /** Resume #1. A legacy native only knows "spawned"; any other state is refused. */
    async resume(
      token: PendingOriginalNativeLease,
      signal?: AbortSignal,
    ): Promise<NativeLeaseResumption> {
      requireActivation();
      return resumption(token, await query(token, "serviceLeaseResumeRequest", signal));
    },
    /** Resume #2 after sealing the new upstream socket; native verifies it before "spawned". */
    async attach(
      attaching: AttachingNativeLease,
      signal?: AbortSignal,
    ): Promise<NativeLeaseResumption> {
      requireActivation();
      const { pending, evidence } = tokens.attachingPending(attaching);
      const value = reply(pending, await query(pending, "serviceLeaseResumeRequest", signal), true);
      if (value.generation !== evidence.generation)
        throw Error("Native successor generation changed while attaching.");
      if (value.state === "attaching") {
        successor(pending, value);
        return { state: "attaching", attaching };
      }
      const lease = live(pending, value);
      tokens.retireAttaching(attaching);
      return { state: "live", lease };
    },
    async cancelPending(token: PendingOriginalNativeLease, signal?: AbortSignal) {
      const response = await control(token, "cancel-pending", 0, signal);
      if (
        response.state !== "cancelled" ||
        response.generation !== 0 ||
        response.originalChildPid !== 0 ||
        response.originalController ||
        response.currentController
      )
        throw Error("Native pending start has no confirmed cancellation fence.");
      return tokens.cancelled(token, response);
    },
    async stopOriginal(token: PendingOriginalNativeLease, signal?: AbortSignal) {
      const response = await control(token, "stop-original", 0, signal);
      if (response.state === "cancelled")
        return { state: "cancelled" as const, cancellation: tokens.cancelled(token, response) };
      if (response.state !== "exited" || response.generation !== 0)
        throw Error("Original native scope exit is unconfirmed.");
      return { state: "exited" as const, exit: tokens.terminal(token, response) };
    },
    async detach(lease: VerifiedNativeLease | AttachingNativeLease, signal?: AbortSignal) {
      const value = tokens.granted(lease);
      const response = await control(value.pending, "detach", value.evidence.generation, signal);
      if (response.state !== "detached" || response.generation !== value.evidence.generation)
        throw Error("Native detach is unconfirmed.");
      value.record.bootstrap = [];
      value.record.attached = false;
    },
    withBootstrap<A>(
      lease: VerifiedNativeLease | AttachingNativeLease,
      consume: (environment: ReadonlyArray<{ readonly name: string; readonly value: string }>) => A,
    ): A {
      requireActivation();
      const value = tokens.granted(lease);
      if (!value.record.attached || !value.record.bootstrap.length)
        throw Error("Private native bootstrap unavailable.");
      return consume(value.record.bootstrap.map((item) => Object.freeze({ ...item })));
    },
    async inventory(signal?: AbortSignal) {
      const value = await io.request(
        (id) => ({
          type: "serviceLeaseStatusRequest",
          value: { requestId: id, binding: undefined, capability: new Uint8Array() },
        }),
        signal,
      );
      if (!value.accepted || value.bootstrap.length || value.generation !== 0)
        throw Error("Native current inventory unavailable.");
      // This is diagnostic current inventory, never an older-epoch cleanup grant.
      return Object.freeze({
        state: value.state,
        binding: value.binding ? Object.freeze(nativeLeaseBindingView(value.binding)) : undefined,
        originalChildPid: value.originalChildPid,
      });
    },
    async dispose() {
      try {
        await io.dispose();
      } finally {
        tokens.clear();
      }
    },
  });
  originalClients.add(client);
  return client;
}
export type NativeServiceLeaseClient = Awaited<ReturnType<typeof connectNativeServiceLeaseClient>>;

/** Reject structural objects/proxies before using this owner as cleanup authority. */
export function assertOriginalNativeServiceLeaseClient(client: NativeServiceLeaseClient): void {
  if (!originalClients.has(client))
    throw Error("Original authenticated native owner-client instance required.");
}
