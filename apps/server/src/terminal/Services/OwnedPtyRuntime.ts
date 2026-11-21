import type { RemoteAgentConnectionPool } from "../../remote-agent/remoteAgentConnectionPool.ts";
import type { RemoteAgentOwnerStore } from "../../remote-agent/remoteAgentOwners.ts";
import type { RemoteAgentControl } from "../../remote-agent/remoteAgentControl.ts";
import type {
  RemoteAgentHostPolicy,
  RemoteAgentHostResourceReport,
  RemoteAgentPtyActivity,
  RemoteAgentPtyLifecycleNotice,
} from "../../remote-agent/remoteAgentProtocol.ptyLifecycle.ts";
import type { PtyHostCapabilities } from "./PTY.ts";

/** Execution/ownership scope independent of the workspace's user-facing target label. */
export interface OwnedPtyRuntime {
  readonly targetId: string;
  readonly pool: RemoteAgentConnectionPool;
  readonly owners: () => RemoteAgentOwnerStore;
  readonly control: () => Promise<Pick<RemoteAgentControl, "registry">>;
  /** Positive evidence for read-only PID inspection; never permission to reap a child. */
  readonly pidNamespace: "backend-host" | "ssh-host";
  /** Host-wide lifecycle controls (protocol 1.9); absent where the runtime has no Rust host. */
  readonly host?: OwnedPtyHostControls;
}

export type OwnedPtyHostEvent =
  | { readonly type: "activity"; readonly value: RemoteAgentPtyActivity }
  | { readonly type: "notice"; readonly value: RemoteAgentPtyLifecycleNotice }
  | { readonly type: "resourceReport"; readonly value: RemoteAgentHostResourceReport };

export interface OwnedPtyHostNoticeReplay {
  readonly agentEpoch: string;
  readonly notices: ReadonlyArray<RemoteAgentPtyLifecycleNotice>;
  /** Notices after the requested id were already evicted from the host ring. */
  readonly gap: boolean;
}

/**
 * Each call resolves the host's current connection. Requests the host cannot serve (an agent
 * before 1.9, or a capability it does not advertise) reject with code `UNSUPPORTED` without
 * sending anything, so an old agent never sees an unknown frame.
 */
export interface OwnedPtyHostControls {
  readonly capabilities: () => Promise<PtyHostCapabilities>;
  /** Returns the effective, host-clamped policy. */
  readonly updatePolicy: (
    policy: RemoteAgentHostPolicy,
    signal?: AbortSignal,
  ) => Promise<RemoteAgentHostPolicy>;
  /** Returns the number of PTYs the host closed. */
  readonly closeAll: (
    input: { readonly reason: "quit" | "update"; readonly managedOnly: boolean },
    signal?: AbortSignal,
  ) => Promise<number>;
  readonly replayNotices: (
    input: { readonly expectedEpoch: string; readonly afterNoticeId: number },
    signal?: AbortSignal,
  ) => Promise<OwnedPtyHostNoticeReplay>;
  /** Subscribes to the current connection only; resubscribe after the host reconnects. */
  readonly subscribe: (listener: (event: OwnedPtyHostEvent) => void) => Promise<() => void>;
}
