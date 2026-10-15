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

/** What the dispatched `thread.fork` was for; the server keeps an existing fork for the same. */
export interface ContinuedForkRequest {
  readonly pendingMessageId?: string | undefined;
  readonly failureEventId?: string | undefined;
}

/**
 * The thread to open after "Continue in a new thread" or a carry: the requested fork once it
 * exists, or the fork the server kept for this same message or failure (a no-op decision). Never
 * an unused id, an older fork made for something else, or a fork the store does not show.
 */
export function resolveContinuedThreadId(input: {
  readonly sourceThreadId: ThreadId;
  readonly requestedThreadId: ThreadId;
  readonly command: ContinuedForkRequest;
  readonly threads: ReadonlyArray<NavigationThread>;
}): ThreadId | null {
  const { command } = input;
  const exists = (threadId: unknown) => input.threads.some((thread) => thread.id === threadId);
  if (exists(input.requestedThreadId)) return input.requestedThreadId;
  const source = input.threads.find((thread) => thread.id === input.sourceThreadId);
  const kept = source?.activities.findLast((activity) => {
    if (activity.kind !== THREAD_FORKED_ACTIVITY_KIND) return false;
    const payload = activity.payload as Record<string, unknown> | null;
    const sameRequest =
      (command.pendingMessageId !== undefined &&
        payload?.pendingMessageId === command.pendingMessageId) ||
      (command.failureEventId !== undefined && payload?.failureEventId === command.failureEventId);
    return sameRequest && exists(payload?.forkThreadId);
  });
  const forkThreadId = (kept?.payload as { forkThreadId?: unknown } | undefined)?.forkThreadId;
  return typeof forkThreadId === "string" ? (forkThreadId as ThreadId) : null;
}

/** Resolves once the store shows the continued thread, or null after `timeoutMs`. */
export function waitForContinuedThread(
  input: {
    readonly sourceThreadId: ThreadId;
    readonly requestedThreadId: ThreadId;
    readonly command: ContinuedForkRequest;
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
