/**
 * Protocol 1.9 terminal lifecycle client (frames 83-95; plan §8.5-§8.10, §9.1).
 *
 * Every request is feature-detected against the connection's hello: without the capability the
 * call rejects with `UNSUPPORTED` and nothing is sent, so agents before 1.9 never see an unknown
 * frame. A host that advertises the capability but still refuses gets the same code back.
 * Unsolicited activity, notice and resource frames are always consumed by one router per
 * connection, so they can never fill the connection's bounded unclaimed-frame set.
 *
 * @module remoteAgentPtyClient.lifecycle
 */
import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type {
  OwnedPtyHostControls,
  OwnedPtyHostEvent,
} from "../terminal/Services/OwnedPtyRuntime.ts";
import type {
  PtyHostActivity,
  PtyHostCapabilities,
  PtyHostLifecycleNotice,
  PtySpawnHostLifecycle,
  PtyViewState,
} from "../terminal/Services/PTY.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import {
  REMOTE_AGENT_LIFECYCLE_UNSUPPORTED,
  REMOTE_AGENT_TERMINAL_LIFECYCLE_CAPABILITY,
  REMOTE_AGENT_TERMINAL_LOCAL_LAUNCH_CAPABILITY,
  REMOTE_AGENT_TERMINAL_QUERY_RESPONDER_CAPABILITY,
  REMOTE_AGENT_TERMINAL_SCREEN_CAPABILITY,
  REMOTE_AGENT_TERMINAL_SPOOL_CAPABILITY,
  type RemoteAgentPtyCreateLifecycleFields,
} from "./remoteAgentProtocol.ptyLifecycle.ts";
import { RemoteAgentPtyError } from "./remoteAgentPtyClient.types.ts";

type Connection = Pick<RemoteAgentConnection, "supportsCapability" | "request" | "onFrame">;

export const REMOTE_AGENT_LIFECYCLE_REQUEST_TIMEOUT_MS = 15_000;

export function remoteAgentHostCapabilities(
  connection: Pick<RemoteAgentConnection, "supportsCapability">,
): PtyHostCapabilities {
  const has = (name: string) => connection.supportsCapability?.(name) === true;
  return {
    screen: has(REMOTE_AGENT_TERMINAL_SCREEN_CAPABILITY),
    lifecycle: has(REMOTE_AGENT_TERMINAL_LIFECYCLE_CAPABILITY),
    spool: has(REMOTE_AGENT_TERMINAL_SPOOL_CAPABILITY),
    queryResponder: has(REMOTE_AGENT_TERMINAL_QUERY_RESPONDER_CAPABILITY),
    localLaunch: has(REMOTE_AGENT_TERMINAL_LOCAL_LAUNCH_CAPABILITY),
  };
}

/** Normalised without touching the file system; the host still canonicalises the root. */
function canonicalTerminalCwd(cwd: string): string {
  const normalized = posix.normalize(cwd);
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

/** §8.10: one shared, reference-counted workspace root per target and cwd. */
export function remoteAgentTerminalWorkspaceHandle(target: string, cwd: string): string {
  const digest = createHash("sha256")
    .update(target)
    .update(Buffer.from([0]))
    .update(canonicalTerminalCwd(cwd))
    .digest("hex");
  return `terminal-root-${digest.slice(0, 32)}`;
}

/**
 * Shared per-cwd roots need the host's reference count (R5, advertised with terminal.lifecycle).
 * Older hosts reject a second open of the same handle, so they keep one handle per PTY.
 */
export function remoteAgentPtyWorkspaceHandle(
  connection: Pick<RemoteAgentConnection, "supportsCapability">,
  input: { readonly target: string; readonly cwd: string; readonly resourceId: string },
): string {
  return remoteAgentHostCapabilities(connection).lifecycle
    ? remoteAgentTerminalWorkspaceHandle(input.target, input.cwd)
    : `terminal-${input.resourceId}`;
}

export interface RemoteAgentPtyCreateDefaults extends PtySpawnHostLifecycle {
  readonly localLaunch?: boolean;
  readonly spool?: boolean;
  readonly screenScrollbackRows?: number;
}

/** Additive create fields, each sent only when the host advertises its capability. */
export function remoteAgentPtyCreateLifecycleFields(
  connection: Pick<RemoteAgentConnection, "supportsCapability">,
  requested: RemoteAgentPtyCreateDefaults,
): RemoteAgentPtyCreateLifecycleFields {
  const capabilities = remoteAgentHostCapabilities(connection);
  const { lifecycleManaged, activitySource, evictPtyId, screenScrollbackRows } = requested;
  return {
    ...(capabilities.lifecycle && lifecycleManaged ? { lifecycleManaged: true } : {}),
    ...(capabilities.lifecycle && activitySource ? { activitySource } : {}),
    ...(capabilities.lifecycle && evictPtyId ? { evictPtyId } : {}),
    ...(capabilities.localLaunch && requested.localLaunch ? { localLaunch: true } : {}),
    ...(capabilities.spool && requested.spool ? { spool: true } : {}),
    ...(capabilities.screen && screenScrollbackRows !== undefined ? { screenScrollbackRows } : {}),
  };
}

/** Consumes every unsolicited lifecycle frame on one connection and fans it out. */
class LifecycleEventRouter {
  readonly listeners = new Set<(event: OwnedPtyHostEvent) => void>();

  constructor(connection: Connection) {
    connection.onFrame((frame) => this.route(frame));
  }

  private route(frame: RemoteAgentFrame): boolean {
    let event: OwnedPtyHostEvent;
    if (frame.type === "ptyActivity") event = { type: "activity", value: frame.value };
    else if (frame.type === "ptyLifecycleNotice") event = { type: "notice", value: frame.value };
    else if (frame.type === "hostResourceReport")
      event = { type: "resourceReport", value: frame.value };
    else return false;
    for (const listener of this.listeners) listener(event);
    return true;
  }
}

const routers = new WeakMap<Connection, LifecycleEventRouter>();

/** Installs the connection's router once (it lives as long as the connection) and subscribes. */
export function subscribeRemoteAgentLifecycleEvents(
  connection: Connection,
  listener?: (event: OwnedPtyHostEvent) => void,
): () => void {
  let router = routers.get(connection);
  if (!router) {
    router = new LifecycleEventRouter(connection);
    routers.set(connection, router);
  }
  if (!listener) return () => undefined;
  const listeners = router.listeners;
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type ResponseOf<T extends RemoteAgentFrame["type"]> = Extract<RemoteAgentFrame, { type: T }>;

/** One correlated lifecycle request; refusals reject with the host's code. */
export async function requestRemoteAgentLifecycle<T extends RemoteAgentFrame["type"]>(
  connection: Connection,
  capability: string,
  frame: RemoteAgentFrame & { readonly value: { readonly requestId: string } },
  responseType: T,
  signal?: AbortSignal,
): Promise<ResponseOf<T>["value"]> {
  if (!connection.supportsCapability?.(capability))
    throw new RemoteAgentPtyError(
      REMOTE_AGENT_LIFECYCLE_UNSUPPORTED,
      `This terminal host does not support ${capability}.`,
    );
  const requestId = frame.value.requestId;
  const timeout = AbortSignal.timeout(REMOTE_AGENT_LIFECYCLE_REQUEST_TIMEOUT_MS);
  const response = await connection.request(
    frame,
    (candidate) =>
      candidate.type === responseType &&
      (candidate.value as { requestId?: string }).requestId === requestId,
    signal ? AbortSignal.any([signal, timeout]) : timeout,
  );
  if (response.type !== responseType)
    throw new RemoteAgentPtyError("PTY_LIFECYCLE_UNKNOWN", "Lifecycle response is unknown.");
  const value = response.value as {
    readonly accepted: boolean;
    readonly errorCode: string;
    readonly errorMessage?: string;
  };
  if (!value.accepted)
    throw new RemoteAgentPtyError(
      value.errorCode || "PTY_LIFECYCLE_REJECTED",
      value.errorMessage || "The terminal host refused the lifecycle request.",
    );
  return response.value as unknown as ResponseOf<T>["value"];
}

interface PendingViewState {
  readonly state: PtyViewState;
  readonly signal: AbortSignal | undefined;
  readonly settle: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
}

/** Per-PTY lifecycle controls that follow the PTY's current connection across reconnects. */
export class RemoteAgentPtyLifecycle {
  private pending: PendingViewState | undefined;
  private pumping = false;
  private readonly activity = new Set<(activity: PtyHostActivity) => void>();
  private readonly notices = new Set<(notice: PtyHostLifecycleNotice) => void>();
  private unsubscribe: (() => void) | undefined;
  evictedPtyId: string | undefined;

  constructor(
    private readonly ptyId: string,
    private readonly connection: () => Connection,
    private readonly signal: AbortSignal,
  ) {}

  capabilities(): PtyHostCapabilities {
    return remoteAgentHostCapabilities(this.connection());
  }

  /** Call whenever the PTY starts listening to a (new) connection. */
  bind(connection: Connection): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    // Only lifecycle hosts send these frames; older connections get no extra listener.
    if (!remoteAgentHostCapabilities(connection).lifecycle) return;
    this.unsubscribe = subscribeRemoteAgentLifecycleEvents(connection, (event) => {
      if (event.type === "resourceReport" || event.value.ptyId !== this.ptyId) return;
      if (event.type === "activity") for (const listener of this.activity) listener(event.value);
      else for (const listener of this.notices) listener(event.value);
    });
  }

  unbind(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  onActivity(callback: (activity: PtyHostActivity) => void): () => void {
    this.activity.add(callback);
    return () => this.activity.delete(callback);
  }

  onNotice(callback: (notice: PtyHostLifecycleNotice) => void): () => void {
    this.notices.add(callback);
    return () => this.notices.delete(callback);
  }

  async keepOpen(signal?: AbortSignal): Promise<void> {
    const requestId = randomUUID();
    await requestRemoteAgentLifecycle(
      this.connection(),
      REMOTE_AGENT_TERMINAL_LIFECYCLE_CAPABILITY,
      { type: "ptyKeepOpenRequest", value: { requestId, ptyId: this.ptyId } },
      "ptyKeepOpenResponse",
      this.requestSignal(signal),
    );
  }

  /** Latest wins: one push in flight; queued pushes collapse and settle with the newest. */
  setViewState(state: PtyViewState, signal?: AbortSignal): Promise<void> {
    if (!this.capabilities().lifecycle)
      return Promise.reject(
        new RemoteAgentPtyError(
          REMOTE_AGENT_LIFECYCLE_UNSUPPORTED,
          "This terminal host does not support terminal.lifecycle.",
        ),
      );
    return new Promise<void>((resolve, reject) => {
      const settle = [...(this.pending?.settle ?? []), { resolve, reject }];
      this.pending = { state, signal, settle };
      if (!this.pumping) void this.pump();
    });
  }

  private async pump(): Promise<void> {
    this.pumping = true;
    try {
      while (this.pending) {
        const { state, signal, settle } = this.pending;
        this.pending = undefined;
        try {
          await this.sendViewState(state, signal);
          for (const waiter of settle) waiter.resolve();
        } catch (error) {
          for (const waiter of settle) waiter.reject(error);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async sendViewState(state: PtyViewState, signal?: AbortSignal): Promise<void> {
    await requestRemoteAgentLifecycle(
      this.connection(),
      REMOTE_AGENT_TERMINAL_LIFECYCLE_CAPABILITY,
      {
        type: "ptyViewStateRequest",
        value: {
          requestId: randomUUID(),
          ptyId: this.ptyId,
          viewState: state.viewState,
          rendererAttached: state.rendererAttached,
          ownerBusyHint: state.ownerBusyHint ?? "",
          themeFg: state.themeFg ?? "",
          themeBg: state.themeBg ?? "",
          ackedSequence: state.ackedSequence ?? 0,
        },
      },
      "ptyViewStateResponse",
      this.requestSignal(signal),
    );
  }

  private requestSignal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.signal]) : this.signal;
  }
}

/** Host-wide controls over whichever connection `connect` currently returns. */
export function makeRemoteAgentHostControls(
  connect: () => Promise<Connection>,
): OwnedPtyHostControls {
  const lifecycle = REMOTE_AGENT_TERMINAL_LIFECYCLE_CAPABILITY;
  return {
    capabilities: async () => remoteAgentHostCapabilities(await connect()),
    updatePolicy: async (policy, signal) => {
      const value = { requestId: randomUUID(), policy };
      const response = await requestRemoteAgentLifecycle(
        await connect(),
        lifecycle,
        { type: "hostPolicyUpdateRequest", value },
        "hostPolicyUpdateResponse",
        signal,
      );
      return response.effective;
    },
    closeAll: async (input, signal) => {
      const value = { requestId: randomUUID(), ...input };
      const response = await requestRemoteAgentLifecycle(
        await connect(),
        lifecycle,
        { type: "ptyCloseAllRequest", value },
        "ptyCloseAllResponse",
        signal,
      );
      return response.closedCount;
    },
    replayNotices: async (input, signal) => {
      const value = { requestId: randomUUID(), ...input };
      const response = await requestRemoteAgentLifecycle(
        await connect(),
        lifecycle,
        { type: "hostNoticeReplayRequest", value },
        "hostNoticeReplayResponse",
        signal,
      );
      return { agentEpoch: response.agentEpoch, notices: response.notices, gap: response.gap };
    },
    subscribe: async (listener) => subscribeRemoteAgentLifecycleEvents(await connect(), listener),
  };
}
