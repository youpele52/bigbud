import { type ThreadId } from "@bigbud/contracts";
import { type Thread } from "../../../models/types";
import { useStore } from "../../../stores/main";

export function threadHasStarted(thread: Thread | null | undefined): boolean {
  return Boolean(thread && (thread.latestTurn !== null || thread.session !== null));
}

export async function waitForThreadToExist(
  threadId: ThreadId,
  timeoutMs = 3_000,
): Promise<boolean> {
  const getThread = () => useStore.getState().threads.find((thread) => thread.id === threadId);
  if (getThread()) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = useStore.subscribe((state) => {
      if (!state.threads.some((thread) => thread.id === threadId)) {
        return;
      }
      finish(true);
    });

    if (getThread()) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

export async function waitForStartedServerThread(
  threadId: ThreadId,
  timeoutMs = 1_000,
): Promise<boolean> {
  const getThread = () => useStore.getState().threads.find((thread) => thread.id === threadId);
  const thread = getThread();

  if (threadHasStarted(thread)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = useStore.subscribe((state) => {
      if (!threadHasStarted(state.threads.find((nextThread) => nextThread.id === threadId))) {
        return;
      }
      finish(true);
    });

    if (threadHasStarted(getThread())) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

export async function waitForThreadToDisappear(
  threadId: ThreadId,
  timeoutMs = 15_000,
): Promise<boolean> {
  const getThread = () => useStore.getState().threads.find((thread) => thread.id === threadId);
  if (!getThread()) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = useStore.subscribe((state) => {
      if (state.threads.some((thread) => thread.id === threadId)) {
        return;
      }
      finish(true);
    });

    if (!getThread()) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}
