import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./atomRegistry";

export const MAX_CONFIG_NO_PROGRESS_FAILURES = 3;

export type ConfigFailureCategory =
  | "subscription_failed"
  | "application_failed"
  | "fallback_failed"
  | "incompatible"
  | "stream_completed"
  | "protocol_failed"
  | "initial_snapshot_timeout";

export interface ServerConfigReadiness {
  readonly generation: number;
  readonly stream: "pending" | "live" | "retrying" | "exhausted";
  readonly fallback: "idle" | "pending" | "succeeded" | "failed";
  readonly failure: ConfigFailureCategory | null;
  readonly failureAt: string | null;
  readonly failures: number;
  readonly maxFailures: number;
  readonly hasSnapshot: boolean;
}

const INITIAL_READINESS: ServerConfigReadiness = {
  generation: 0,
  stream: "pending",
  fallback: "idle",
  failure: null,
  failureAt: null,
  failures: 0,
  maxFailures: MAX_CONFIG_NO_PROGRESS_FAILURES,
  hasSnapshot: false,
};

export const serverConfigReadinessAtom = Atom.make(INITIAL_READINESS).pipe(
  Atom.keepAlive,
  Atom.withLabel("server-config-readiness"),
);

let retryOwner: {
  readonly generation: number;
  readonly retry: () => void;
  readonly isStopped: () => boolean;
} | null = null;

/** Registers the one config retry owner for this renderer without reconnecting unrelated RPCs. */
export function registerServerConfigRetry(
  generation: number,
  retry: () => void,
  isStopped: () => boolean = () => true,
): () => void {
  const owner = { generation, retry, isStopped };
  retryOwner = owner;
  return () => {
    if (retryOwner === owner) retryOwner = null;
  };
}

export function retryServerConfigSync(options?: { readonly onlyIfStopped?: boolean }): void {
  const owner = retryOwner;
  if (!owner || owner.generation !== getServerConfigReadiness().generation) return;
  if (options?.onlyIfStopped && !owner.isStopped()) return;
  owner.retry();
}

export function getServerConfigReadiness(): ServerConfigReadiness {
  return appAtomRegistry.get(serverConfigReadinessAtom);
}

/** Starts a synchronization owner without discarding an already loaded snapshot. */
export function beginServerConfigReadiness(hasSnapshot: boolean): number {
  const generation = getServerConfigReadiness().generation + 1;
  appAtomRegistry.set(serverConfigReadinessAtom, {
    ...INITIAL_READINESS,
    generation,
    hasSnapshot,
    fallback: hasSnapshot ? "idle" : "pending",
  });
  return generation;
}

/** Keeps stale synchronization callbacks from changing the current readiness state. */
export function updateServerConfigReadiness(
  generation: number,
  update: Partial<Omit<ServerConfigReadiness, "generation">>,
): void {
  const current = getServerConfigReadiness();
  if (current.generation !== generation) return;
  appAtomRegistry.set(serverConfigReadinessAtom, { ...current, ...update });
}

export function useServerConfigReadiness(): ServerConfigReadiness {
  return useAtomValue(serverConfigReadinessAtom);
}
