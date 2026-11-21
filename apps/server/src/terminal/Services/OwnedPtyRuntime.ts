import type { RemoteAgentConnectionPool } from "../../remote-agent/remoteAgentConnectionPool.ts";
import type { RemoteAgentOwnerStore } from "../../remote-agent/remoteAgentOwners.ts";
import type { RemoteAgentControl } from "../../remote-agent/remoteAgentControl.ts";
import type {
  RemoteAgentHostPolicy,
  RemoteAgentHostResourceReport,
  RemoteAgentPtyActivity,
  RemoteAgentPtyLifecycleNotice,
} from "../../remote-agent/remoteAgentProtocol.ptyLifecycle.ts";
import type { PtyHostCapabilities, PtyScreenSnapshot, PtyScreenSnapshotInput } from "./PTY.ts";

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
  /** Every generation of a multi-generation host (the local terminal host only). */
  readonly hostGenerations?: OwnedPtyHostGenerations;
}

/** One host PTY as its supervisor reports it; absence never proves an exit. */
export interface OwnedPtyHostInventoryEntry {
  readonly ptyId: string;
  /** The owner-row connection binding (generation) that reported it. */
  readonly connectionId: string;
  readonly state: string;
  /** The host lost the PTY (a host crash); only a cold screen remains. */
  readonly lost: boolean;
  /** `busy` | `idle` | `idle_warning`, where the host reports activity. */
  readonly activityState?: string;
  readonly lastUsedMs?: number;
  readonly lifecycleManaged: boolean;
}

/** A host generation that cannot be reconnected and was left running (plan §7.3 item 5). */
export interface OwnedPtyDrainingHostNotice {
  readonly generation: number;
  readonly reason: "unreachable" | "incompatible";
  /** The one-time toast was never raised for this generation before. */
  readonly firstTime: boolean;
  readonly canClose: boolean;
}

/**
 * Controls that address every reachable generation, not only the admitted one: quit close-all
 * and policy must reach draining hosts too. Nothing here launches a host.
 */
export interface OwnedPtyHostGenerations {
  /** Resolves once adoption finished (successfully or not). */
  readonly ready: () => Promise<void>;
  /** Changes whenever the admitted host connection changes; undefined with no host. */
  readonly admittedKey: () => Promise<string | undefined>;
  readonly inventory: (signal?: AbortSignal) => Promise<ReadonlyArray<OwnedPtyHostInventoryEntry>>;
  /** Pushes the policy to every reachable lifecycle-capable generation. */
  readonly updatePolicy: (policy: RemoteAgentHostPolicy, signal?: AbortSignal) => Promise<void>;
  readonly closeAll: (
    input: { readonly reason: "quit" | "update"; readonly managedOnly: boolean },
    signal?: AbortSignal,
  ) => Promise<{ readonly closed: number; readonly unreachable: number }>;
  /** A screen copy of a PTY the host still knows (a lost PTY's cold screen). */
  readonly coldSnapshot: (
    ptyId: string,
    input: PtyScreenSnapshotInput,
  ) => Promise<PtyScreenSnapshot>;
  readonly drainingNotices: () => ReadonlyArray<OwnedPtyDrainingHostNotice>;
  /** User-confirmed "Close them": only start-time-verified PIDs are signalled. */
  readonly closeDrainingHosts: () => Promise<{
    readonly closed: number;
    readonly remaining: number;
  }>;
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
