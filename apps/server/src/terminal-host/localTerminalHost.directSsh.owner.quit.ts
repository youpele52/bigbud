/**
 * Default-quit close for direct SSH PTYs hosted by the native Rust SSH owner (plan S3, dev-only).
 * The durable owner rows of the configured targets are the snapshot. A connection prefix only
 * nominates a candidate; the close authority is the exact captured lease, which is rechecked
 * against the current row here and again inside the lifecycle's confirmed close. An unavailable
 * owner or an unconfirmed outcome counts as unreachable and keeps the durable reservation: no
 * retry by pane, no new SSH, no legacy fallback.
 *
 * @module localTerminalHost.directSsh.owner.quit
 */
import type { RemoteAgentOwner, RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import type { OwnedPtyLocalSshClient } from "../terminal/Services/OwnedPtyRuntime.ts";
import {
  nativeDirectSshBinding,
  NATIVE_SSH_CONNECTION_PREFIX,
} from "./localTerminalHost.directSsh.owner.lifecycle.ts";
import type { NativeDirectSshTerminalBinding } from "./localTerminalHost.directSsh.owner.port.ts";

/** Same shape as the manager's `TerminalQuitCloser`, plus a cheap presence check. */
export interface NativeDirectSshQuitCloser {
  readonly hasHosts: () => boolean;
  readonly closeAll: (
    input: { readonly reason: "quit" | "update"; readonly managedOnly: boolean },
    signal?: AbortSignal,
  ) => Promise<{ readonly closed: number; readonly unreachable: number }>;
}

interface Candidate {
  readonly route: RemoteAgentOwner;
  readonly binding: NativeDirectSshTerminalBinding;
}

const PAGE = 100;
const MAX_PAGES = 64;

const sameLease = (left: RemoteAgentOwner, right: RemoteAgentOwner) =>
  left.ownerKey === right.ownerKey &&
  left.target === right.target &&
  left.epoch === right.epoch &&
  left.connectionId === right.connectionId &&
  left.resourceId === right.resourceId &&
  left.reservationId === right.reservationId &&
  !right.shellLaunch;

/** Only rows that may hold a live native PTY; prepared rows have dispatched nothing. */
const possiblyLive = (route: RemoteAgentOwner) =>
  route.connectionId.startsWith(NATIVE_SSH_CONNECTION_PREFIX) &&
  !route.shellLaunch &&
  (route.state === "may-have-been-sent" || route.state === "outcome-unknown");

export function makeNativeDirectSshQuitCloser(input: {
  /** Fixed targets (dev), or the live target set read at quit time (production). */
  readonly targets: ReadonlyArray<string> | (() => Promise<ReadonlyArray<string>>);
  readonly owners: () => RemoteAgentOwnerStore;
  readonly lifecycle: OwnedPtyLocalSshClient;
}): NativeDirectSshQuitCloser {
  const snapshot = async (signal?: AbortSignal) => {
    const store = input.owners();
    const list = store.listTerminalOwners;
    if (!list) throw new Error("The owner store cannot list terminal leases.");
    const found: Candidate[] = [];
    const targets = typeof input.targets === "function" ? await input.targets() : input.targets;
    for (const target of targets) {
      let after = "";
      for (let page = 0; ; page += 1) {
        signal?.throwIfAborted();
        if (page === MAX_PAGES) throw new Error("Too many terminal leases to snapshot.");
        const { owners, nextCursor } = await list(target, after, PAGE);
        for (const route of owners)
          if (route.target === target && possiblyLive(route))
            found.push({ route, binding: nativeDirectSshBinding(route) });
        if (!nextCursor) break;
        after = nextCursor;
      }
    }
    return found;
  };

  const closeOne = async ({ route }: Candidate, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    // Recheck the captured lease: a replacement or a settled row is not this quit's to close.
    const current = await input.owners().get(route.ownerKey);
    if (!current || !sameLease(route, current)) return "skipped" as const;
    if (current.state === "terminal") return "skipped" as const;
    try {
      await input.lifecycle.close(route, signal);
      return "closed" as const;
    } catch {
      return "unreachable" as const;
    }
  };

  return {
    hasHosts: () => typeof input.targets === "function" || input.targets.length > 0,
    closeAll: async (_request, signal) => {
      let candidates: Candidate[];
      try {
        candidates = await snapshot(signal);
      } catch {
        // Nothing provable about any lease: report one unreachable host, close nothing.
        return { closed: 0, unreachable: 1 };
      }
      const outcomes = await Promise.all(
        candidates.map((candidate) =>
          closeOne(candidate, signal).catch(() => "unreachable" as const),
        ),
      );
      return {
        closed: outcomes.filter((outcome) => outcome === "closed").length,
        unreachable: outcomes.filter((outcome) => outcome === "unreachable").length,
      };
    },
  };
}

const closers = new WeakMap<object, NativeDirectSshQuitCloser>();

/** Registers the closer for one wrapped PTY adapter (the opted-in development graph only). */
export function registerNativeDirectSshQuitCloser(
  adapter: object,
  closer: NativeDirectSshQuitCloser,
): void {
  closers.set(adapter, closer);
}

/** The native closer of this exact adapter, if the development opt-in installed one. */
export function nativeDirectSshQuitCloserFor(
  adapter: object,
): NativeDirectSshQuitCloser | undefined {
  return closers.get(adapter);
}
