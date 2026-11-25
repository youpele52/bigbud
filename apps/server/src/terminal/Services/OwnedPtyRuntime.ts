import type { RemoteAgentConnectionPool } from "../../remote-agent/remoteAgentConnectionPool.ts";
import type { RemoteAgentOwnerStore } from "../../remote-agent/remoteAgentOwners.ts";
import type { RemoteAgentControl } from "../../remote-agent/remoteAgentControl.ts";
import type { RemoteAgentOwner } from "../../remote-agent/remoteAgentOwners.ts";
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
  /**
   * Direct SSH through the local terminal host (plan M7): the PTY runs a local `ssh` client for a
   * non-local target. Its PIDs, files and terminal inventory are not the target's, so remote
   * inspection reads the in-band shell PID, and paste staging and discovery never use this
   * runtime. Liveness and close address one owner's host PTY directly.
   */
  readonly localSshClient?: OwnedPtyLocalSshClient;
  /** Startup-bound root of the selected native fixture, not a renderer path. */
  readonly nativeSshWorkspaceRoot?: string;
  /**
   * Liveness and confirmed close (terminate, then a verified exit) of one owner's PTY in the local
   * terminal host, without attaching to it: a thread deletion closes host panes no view reopened.
   */
  readonly hostPtys?: OwnedPtyLocalSshClient;
}

/** `unknown`: the host (or the owner's generation) cannot be reached, so nothing is proven. */
export type OwnedPtyHostedStatus = "live" | "gone" | "unknown";

export interface OwnedPtyLocalSshClient {
  /** Recognize this client's durable loss marker without calling or starting the host. */
  readonly isHostLost?: (owner: RemoteAgentOwner) => boolean;
  readonly status: (owner: RemoteAgentOwner, signal?: AbortSignal) => Promise<OwnedPtyHostedStatus>;
  /** Close with terminate (the host's escalation) and confirm the exit; rejects otherwise. */
  readonly close: (owner: RemoteAgentOwner, signal?: AbortSignal) => Promise<void>;
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
  /** The supervisor reaped the child and recorded its exit. */
  readonly verifiedExit?: boolean;
}

/**
 * One attached generation's inventory. `unreachable` means it could not be listed, which proves
 * nothing about its PTYs; `ok` lists them, so a PTY absent from it (in that epoch) is gone.
 */
export type OwnedPtyHostGenerationInventory =
  | {
      readonly status: "ok";
      readonly connectionId: string;
      readonly expectedEpoch: string;
      readonly entries: ReadonlyArray<OwnedPtyHostInventoryEntry>;
    }
  | {
      readonly status: "unreachable";
      readonly connectionId: string;
      readonly expectedEpoch: string;
      readonly cause: string;
    };

/** Every PTY the reachable generations list; unreachable ones contribute nothing. */
export function reachableHostInventoryEntries(
  generations: ReadonlyArray<OwnedPtyHostGenerationInventory>,
): ReadonlyArray<OwnedPtyHostInventoryEntry> {
  return generations.flatMap((generation) =>
    generation.status === "ok" ? generation.entries : [],
  );
}

/** One generation's notices after its persisted cursor; the cursor has moved past them. */
export interface OwnedPtyHostGenerationReplay {
  readonly generation: number;
  readonly agentEpoch: string;
  readonly notices: ReadonlyArray<RemoteAgentPtyLifecycleNotice>;
  /** Notices after the cursor were evicted from the host's ring: the list is incomplete. */
  readonly gap: boolean;
  /** No cursor existed (first sight of this generation): notices only set the baseline. */
  readonly baseline: boolean;
  /** The newest notice id now recorded for this generation. */
  readonly lastNoticeId: number;
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
  /** Per attached generation, in attach order; an unreachable one is reported, never dropped. */
  readonly inventory: (
    signal?: AbortSignal,
  ) => Promise<ReadonlyArray<OwnedPtyHostGenerationInventory>>;
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
  /**
   * Notices each reachable generation emitted after its persisted cursor (`HostNoticeReplay`),
   * then the cursor is advanced. An epoch change restarts the cursor at 0 in the new epoch.
   */
  readonly replayNotices: (
    signal?: AbortSignal,
  ) => Promise<ReadonlyArray<OwnedPtyHostGenerationReplay>>;
  /**
   * A notice the admitted host delivered live: its cursor advances (debounced, monotonic), so a
   * backend crash before the next replay cannot recount it as an offline close.
   */
  readonly recordSeenNotice: (noticeId: number) => void;
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
