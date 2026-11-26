import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { runWithAbortableDeadline } from "../../RequestDeadline.ts";
import type { PickerProofProductionProxyClient } from "../../../ssh/sshOwnerPickerProof.client.productionProxy.ts";
import type { ProofOpencodeState } from "../../../ssh/sshOwnerPickerProof.codec.opencode.ts";
import { PickerProofOwnerError } from "../../../ssh/sshOwnerPickerProof.codec.wire.ts";
import { assertDevelopmentVersion } from "./Compatibility.ts";
import { makeOwnedClient, v2Request } from "./Client.ts";
import type { OwnedV2Process, V2IsolatedProcessConfig } from "./ServerManager.types.ts";

/**
 * Owner-selected OpenCode v2 transport for direct SSH targets.
 *
 * The owner launches `serve --stdio`, selects the executable, argv, remote port,
 * local listener and forward spec, and generates the server credential. The
 * server therefore never spawns from this process and never receives an
 * executable, argv, port or forward that a caller chose.
 *
 * @module ServerManager.sshOwner
 */

const POLL_MS = 33;
const READY_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 2_000;

export interface V2SshOwnerStartRequest {
  readonly provider: "opencodeV2";
  /**
   * Runtime target identity. A v2 lease is scoped to one target and workspace,
   * not to one thread, so this is the acquisition identity the owner binds.
   */
  readonly runtimeTargetId: string;
  readonly executionTargetId: string;
  /** Authorized workspace root; the owner refuses any other root. */
  readonly cwd: string;
  /** Resolved provider setting; the owner refuses any other executable. */
  readonly binaryPath: string;
}

export interface V2SshOwnerLease {
  readonly ownerEpoch: string;
  readonly targetGeneration: string;
  readonly leaseId: string;
}

export type V2SshOwnerExit =
  | { readonly kind: "exited"; readonly code: number }
  | { readonly kind: "signaled"; readonly signal: string };

export type V2SshOwnerCloseOutcome = "confirmed" | "unconfirmed";

export interface V2SshOwnerStart {
  readonly lease: V2SshOwnerLease;
  /** Ready only after the owner verified its remote server and local listener. */
  readonly ready: Promise<{ readonly localPort: number; readonly password: string }>;
  readonly exit: Promise<V2SshOwnerExit>;
  /**
   * Cancel only this reservation. Resolves `confirmed` only when the owner
   * reported `closed` or `exited` for this lease; `unconfirmed` when the lane
   * was lost or rejected, so the remote child may still be alive.
   */
  readonly cancel: () => Promise<V2SshOwnerCloseOutcome>;
}

/** The exact owner operations this transport needs; a bound production target. */
export type V2SshOwnerClient = Pick<
  PickerProofProductionProxyClient,
  "openOpencodeV2" | "opencodeV2Status" | "closeOpencodeV2"
>;

export interface V2SshOwner {
  readonly startProvider: (request: V2SshOwnerStartRequest) => V2SshOwnerStart;
}

/** A profile or platform where the owner cannot provide v2 remains typed-refused. */
function failedStartCleanup(error: unknown, cleanup: unknown): AggregateError {
  return new AggregateError([error, cleanup], "OpenCode v2 SSH owner start cleanup failed.", {
    cause: error,
  });
}

export class V2SshOwnerUnavailable extends Error {
  constructor(
    readonly reason: "profile" | "platform" | "recipe",
    message = "OpenCode v2 SSH bootstrap is not verified for this profile or platform; runtime unavailable.",
  ) {
    super(message);
    this.name = "V2SshOwnerUnavailable";
  }
}

/**
 * Drives one owner lease until the owner reports a verified ready result. A
 * close request is acknowledged only after the owner confirms teardown.
 */
export function makeV2SshOwner(
  client: V2SshOwnerClient,
  targetId: string,
  binding: () => { readonly ownerEpoch: Uint8Array; readonly targetGeneration: Uint8Array },
  serviceBinary: string,
): V2SshOwner {
  return {
    startProvider(request) {
      if (
        request.provider !== "opencodeV2" ||
        request.executionTargetId !== targetId ||
        request.binaryPath !== serviceBinary
      )
        throw new PickerProofOwnerError("operationDenied");
      const { ownerEpoch, targetGeneration } = binding();
      const lease = {
        ownerEpoch: Buffer.from(ownerEpoch).toString("hex"),
        targetGeneration: Buffer.from(targetGeneration).toString("hex"),
        leaseId: randomBytes(32).toString("hex"),
      };
      const ready = Promise.withResolvers<{ localPort: number; password: string }>();
      const exit = Promise.withResolvers<V2SshOwnerExit>();
      const closed = Promise.withResolvers<V2SshOwnerCloseOutcome>();
      for (const promise of [ready.promise, exit.promise, closed.promise])
        void promise.catch(() => undefined);
      let cancelled = false;
      let closeSent = false;
      let refusal: PickerProofOwnerError | undefined;
      const ticket = Buffer.from(lease.leaseId, "hex");
      const correlate = (state: ProofOpencodeState) => {
        if (!Buffer.from(state.lease).equals(ticket))
          throw new PickerProofOwnerError("protocolError");
        return state;
      };
      const run = async () => {
        let state = correlate(
          await client.openOpencodeV2(ticket, {
            // v2 leases are workspace-scoped; the owner validates the shape.
            threadId: request.runtimeTargetId,
            sessionEpoch: 0,
            cwd: request.cwd,
            transport: "v2",
          }),
        );
        for (;;) {
          switch (state.phase) {
            case "ready":
              if (!cancelled) {
                if (state.password === undefined) {
                  // Retire this lease before reporting the violation, so the
                  // caller never receives a listener it cannot authenticate.
                  refusal = new PickerProofOwnerError("protocolError");
                  cancelled = true;
                  break;
                }
                ready.resolve({ localPort: state.localPort, password: state.password });
              }
              break;
            case "starting":
            case "closing":
              break;
            case "exited":
              closed.resolve("confirmed");
              exit.resolve({ kind: "exited", code: state.exitCode });
              ready.reject(new PickerProofOwnerError("transportLost"));
              return;
            case "closed":
            case "lost":
            case "rejected":
              closed.resolve(state.phase === "closed" ? "confirmed" : "unconfirmed");
              throw (
                refusal ??
                new PickerProofOwnerError(
                  state.phase === "rejected" ? "operationDenied" : "transportLost",
                )
              );
            case "unconfirmed":
              throw new PickerProofOwnerError("outcomeUnknown");
          }
          if (cancelled && !closeSent) {
            closeSent = true;
            state = correlate(await client.closeOpencodeV2(ticket));
          } else {
            await delay(POLL_MS);
            state = correlate(await client.opencodeV2Status(ticket));
          }
        }
      };
      void run().catch((cause: unknown) => {
        ready.reject(cause);
        exit.reject(cause);
        closed.reject(cause);
      });
      return {
        lease,
        ready: ready.promise,
        exit: exit.promise,
        cancel() {
          cancelled = true;
          return closed.promise;
        },
      };
    },
  };
}

/**
 * Acquires one remote v2 server through the owner. The endpoint handed to the
 * SDK is the owner's local listener and its credential; nothing is spawned
 * locally and no SSH argument is assembled here.
 */
export async function startOwnedV2SshProcess(
  config: V2IsolatedProcessConfig,
  owner: V2SshOwner,
): Promise<OwnedV2Process> {
  if (config.runtimeTargetId === "local") throw new V2SshOwnerUnavailable("platform");
  // The owner binds the authorized workspace root. A remote target without one
  // is refused rather than falling back to a local profile path.
  if (!config.workspaceRoot) throw new V2SshOwnerUnavailable("profile");
  const request = {
    provider: "opencodeV2" as const,
    runtimeTargetId: config.runtimeTargetId,
    executionTargetId: config.runtimeTargetId,
    cwd: config.workspaceRoot,
    binaryPath: config.binaryPath,
  };
  const start = owner.startProvider(request);
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  let closing: Promise<void> | undefined;
  let lost = false;
  let exited = false;
  // A confirmed owner teardown is physical-exit evidence for the native lane:
  // the owner only acknowledges `closeOpencodeV2` after its supervised child is
  // gone. Without this the manager retains the generation forever.
  let closedConfirmed = false;
  const notify = () => {
    if (lost || closing) return;
    lost = true;
    lifetime.abort();
    for (const listener of listeners) listener();
    listeners.clear();
  };
  const close = () => {
    if (closing) return closing;
    closing = runWithAbortableDeadline({
      operation: "OpenCode v2 SSH owner teardown confirmation",
      timeoutMs: CLOSE_TIMEOUT_MS,
      run: () => start.cancel(),
    }).then((outcome) => {
      // Only an explicit owner confirmation frees the native slot; a lost or
      // rejected lane leaves `hasExited()` false because the child may live.
      if (outcome === "confirmed") closedConfirmed = true;
    });
    lifetime.abort();
    return closing;
  };
  void start.exit.then(
    (outcome) => {
      exited = outcome.kind === "exited";
      notify();
    },
    () => notify(),
  );
  const ended = start.exit.then(
    () => {
      throw new PickerProofOwnerError("transportLost");
    },
    (error: unknown) => {
      throw error;
    },
  );
  const readiness = Promise.race([start.ready, ended]);
  void readiness.catch(() => undefined);
  try {
    const { localPort, password } = await runWithAbortableDeadline({
      operation: "OpenCode v2 SSH owner readiness",
      timeoutMs: READY_TIMEOUT_MS,
      run: () => readiness,
    });
    if (lost) throw new PickerProofOwnerError("transportLost");
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65_535)
      throw new PickerProofOwnerError("protocolError");
    if (!password) throw new PickerProofOwnerError("protocolError");
    const endpoint = `http://127.0.0.1:${localPort}`;
    const client = makeOwnedClient({ endpoint, password });
    const info = await v2Request("server.info", (signal) => client.server.info({ signal }));
    assertDevelopmentVersion(info.version);
    if (lost) throw new PickerProofOwnerError("transportLost");
    return {
      client,
      isRunning: () => !lifetime.signal.aborted && !exited,
      hasExited: () => closedConfirmed || exited,
      onDeath: (listener) => {
        if (closing) return () => undefined;
        if (lost) {
          listener();
          return () => undefined;
        }
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw failedStartCleanup(error, cleanup);
    }
    throw error;
  }
}
