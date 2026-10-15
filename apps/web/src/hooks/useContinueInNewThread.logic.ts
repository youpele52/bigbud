import type { ThreadId } from "@bigbud/contracts";
import { THREAD_FORKED_ACTIVITY_KIND } from "@bigbud/contracts/orchestration/orchestration.fork.ts";

import type { Thread } from "../models/types/app.types";
import { useStore } from "../stores/main";

type NavigationThread = Pick<Thread, "id" | "activities">;
interface ThreadStore {
  readonly getState: () => { readonly threads: ReadonlyArray<NavigationThread> };
  readonly subscribe: (
    listener: (state: { readonly threads: ReadonlyArray<NavigationThread> }) => void,
  ) => () => void;
}

/**
 * The thread to open after "Continue in a new thread": the requested fork once it exists, or the
 * fork the server kept instead (a fork already recorded for this source), never an unused id.
 */
export function resolveContinuedThreadId(input: {
  readonly sourceThreadId: ThreadId;
  readonly requestedThreadId: ThreadId;
  readonly threads: ReadonlyArray<NavigationThread>;
}): ThreadId | null {
  if (input.threads.some((thread) => thread.id === input.requestedThreadId)) {
    return input.requestedThreadId;
  }
  const source = input.threads.find((thread) => thread.id === input.sourceThreadId);
  const forked = source?.activities.findLast(
    (activity) => activity.kind === THREAD_FORKED_ACTIVITY_KIND,
  );
  const payload = forked?.payload as { forkThreadId?: unknown } | null | undefined;
  return typeof payload?.forkThreadId === "string" ? (payload.forkThreadId as ThreadId) : null;
}

/** Resolves once the store shows the continued thread, or null after `timeoutMs`. */
export function waitForContinuedThread(
  input: {
    readonly sourceThreadId: ThreadId;
    readonly requestedThreadId: ThreadId;
    readonly timeoutMs?: number;
  },
  store: ThreadStore = useStore as unknown as ThreadStore,
): Promise<ThreadId | null> {
  const resolve = (threads: ReadonlyArray<NavigationThread>) =>
    resolveContinuedThreadId({ ...input, threads });
  const immediate = resolve(store.getState().threads);
  if (immediate) return Promise.resolve(immediate);
  return new Promise((done) => {
    const finish = (result: ThreadId | null) => {
      globalThis.clearTimeout(timer);
      unsubscribe();
      done(result);
    };
    const unsubscribe = store.subscribe((state) => {
      const target = resolve(state.threads);
      if (target) finish(target);
    });
    const timer = globalThis.setTimeout(() => finish(null), input.timeoutMs ?? 5_000);
  });
}
