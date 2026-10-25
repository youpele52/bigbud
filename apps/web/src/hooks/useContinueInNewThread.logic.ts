import type { ThreadId } from "@bigbud/contracts";
import { THREAD_FORKED_ACTIVITY_KIND } from "@bigbud/contracts/orchestration/orchestration.fork.ts";

import type { Thread } from "../models/types/app.types";
import { useStore } from "../stores/main";

type NavigationThread = Pick<Thread, "id" | "activities" | "deletingAt">;
/** Loaded threads plus the sidebar summaries, which also list threads not loaded in full. */
interface NavigationState {
  readonly threads: ReadonlyArray<NavigationThread>;
  readonly sidebarThreadsById?:
    | Readonly<Record<string, { readonly deletingAt?: string | null } | undefined>>
    | undefined;
}
interface ThreadStore {
  readonly getState: () => NavigationState;
  readonly subscribe: (listener: (state: NavigationState) => void) => () => void;
}

/** What the dispatched `thread.fork` was for; the server keeps an existing fork for the same. */
export interface ContinuedForkRequest {
  readonly pendingMessageId?: string | undefined;
  readonly failureEventId?: string | undefined;
}

/** The store marks a thread being deleted; a fully deleted one is simply gone. */
function isThreadDeleting(state: NavigationState, threadId: string): boolean {
  const deletingAt =
    state.threads.find((thread) => thread.id === threadId)?.deletingAt ??
    state.sidebarThreadsById?.[threadId]?.deletingAt ??
    null;
  return deletingAt !== null;
}

/** The newest fork the source recorded for this same message or failure. */
function recordedForkFor(
  source: NavigationThread | undefined,
  command: ContinuedForkRequest,
  accept: (forkThreadId: string) => boolean,
): ThreadId | null {
  const kept = source?.activities.findLast((activity) => {
    if (activity.kind !== THREAD_FORKED_ACTIVITY_KIND) return false;
    const payload = activity.payload as Record<string, unknown> | null;
    const sameRequest =
      (command.pendingMessageId !== undefined &&
        payload?.pendingMessageId === command.pendingMessageId) ||
      (command.failureEventId !== undefined && payload?.failureEventId === command.failureEventId);
    return sameRequest && typeof payload?.forkThreadId === "string" && accept(payload.forkThreadId);
  });
  const forkThreadId = (kept?.payload as { forkThreadId?: unknown } | undefined)?.forkThreadId;
  return typeof forkThreadId === "string" ? (forkThreadId as ThreadId) : null;
}

/**
 * The thread to open after "Continue in a new thread" or a carry: the requested fork once the
 * browser knows it (loaded or in the sidebar summaries), or the fork the server kept for this same
 * message or failure (a no-op decision). Never an unused id or an older fork made for something
 * else.
 */
export function resolveContinuedThreadId(
  input: NavigationState & {
    readonly sourceThreadId: ThreadId;
    readonly requestedThreadId: ThreadId;
    readonly command: ContinuedForkRequest;
  },
): ThreadId | null {
  const known = (threadId: string) =>
    input.sidebarThreadsById?.[threadId] !== undefined ||
    input.threads.some((thread) => thread.id === threadId);
  if (known(input.requestedThreadId)) return input.requestedThreadId;
  const source = input.threads.find((thread) => thread.id === input.sourceThreadId);
  return recordedForkFor(
    source,
    input.command,
    (threadId) => known(threadId) && !isThreadDeleting(input, threadId),
  );
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
  const resolve = (state: NavigationState) => resolveContinuedThreadId({ ...input, ...state });
  const immediate = resolve(store.getState());
  if (immediate) return Promise.resolve(immediate);
  return new Promise((done) => {
    const finish = (result: ThreadId | null) => {
      globalThis.clearTimeout(timer);
      unsubscribe();
      done(result);
    };
    const unsubscribe = store.subscribe((state) => {
      const target = resolve(state);
      if (target) finish(target);
    });
    // The server recorded a fork for this message that this browser has not loaded: open it (the
    // route loads it) instead of reporting that nothing appeared. A fork the store shows as being
    // deleted is skipped. A fully deleted fork leaves no trace in the store, so if the new fork's
    // events take longer than the wait, that deleted fork can still be opened (accepted residual).
    const timer = globalThis.setTimeout(() => {
      const state = store.getState();
      const source = state.threads.find((thread) => thread.id === input.sourceThreadId);
      finish(
        recordedForkFor(source, input.command, (threadId) => !isThreadDeleting(state, threadId)),
      );
    }, input.timeoutMs ?? 5_000);
  });
}
