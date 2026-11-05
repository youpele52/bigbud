import { useSyncExternalStore } from "react";
import type {
  ResourceAwarenessState,
  ResourceRuleMutation,
} from "@bigbud/contracts/system-monitor/awareness.ts";

let state: ResourceAwarenessState | null = null;
let error: string | null = null;
let snapshot: { state: ResourceAwarenessState | null; error: string | null } = { state, error };
const listeners = new Set<() => void>();
let dispose: (() => void) | undefined;
let generation = 0;

function publish(next: ResourceAwarenessState | null, failure: string | null = null): void {
  if (
    next?.stateSequence !== undefined &&
    state?.stateSequence !== undefined &&
    next.stateSequence < state.stateSequence
  )
    return;
  state = next;
  error = failure;
  snapshot = { state, error };
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    const bridge = window.desktopBridge;
    const current = ++generation;
    let live = false;
    dispose = bridge?.onResourceAwarenessState?.((next) => {
      live = true;
      publish(next, error);
    });
    void bridge
      ?.resourceAwarenessGet?.()
      .then((next) => {
        if (current === generation && !live) publish(next);
      })
      .catch((cause: unknown) => {
        if (current === generation && !live) publish(state, String(cause));
      });
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      generation++;
      dispose?.();
      dispose = undefined;
      publish(null);
    }
  };
}

export function useResourceAwareness() {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}

export async function mutateResourceAwareness(
  mutation: Omit<ResourceRuleMutation, "expectedRevision">,
): Promise<void> {
  const mutate = window.desktopBridge?.resourceAwarenessMutate;
  if (!mutate || !state) throw new Error("Desktop resource monitoring unavailable");
  try {
    const result = await mutate({ ...mutation, expectedRevision: state.preferences.revision });
    if (!state || result.preferences.revision >= state.preferences.revision) publish(result);
  } catch (cause) {
    publish(state, cause instanceof Error ? cause.message : String(cause));
    const next = await window.desktopBridge?.resourceAwarenessGet?.().catch(() => undefined);
    if (next) publish(next, error);
    throw cause;
  }
}
