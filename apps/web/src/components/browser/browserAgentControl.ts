import type { BrowserAction, BrowserResult } from "@bigbud/contracts";

interface BrowserTabAgentHandler {
  readonly execute: (action: BrowserAction) => Promise<BrowserResult>;
}

const handlers = new Map<string, BrowserTabAgentHandler>();
const pendingHandlers = new Map<string, Array<(handler: BrowserTabAgentHandler) => void>>();
const BROWSER_READY_RETRY_DELAY_MS = 50;
const BROWSER_READY_TIMEOUT_MS = 5_000;

function isNotReadyError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("not ready");
}

export function registerBrowserTabAgentHandler(tabId: string, handler: BrowserTabAgentHandler) {
  handlers.set(tabId, handler);
  const pending = pendingHandlers.get(tabId) ?? [];
  pendingHandlers.delete(tabId);
  for (const resolve of pending) {
    resolve(handler);
  }
  return () => {
    if (handlers.get(tabId) === handler) {
      handlers.delete(tabId);
    }
  };
}

export function waitForBrowserTabAgentHandler(tabId: string): Promise<BrowserTabAgentHandler> {
  const existing = handlers.get(tabId);
  if (existing) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      const pending = pendingHandlers.get(tabId) ?? [];
      pendingHandlers.set(
        tabId,
        pending.filter((candidate) => candidate !== resolveWhenReady),
      );
      reject(new Error("The visible browser tab did not become ready."));
    }, 5_000);
    const resolveWhenReady = (handler: BrowserTabAgentHandler) => {
      window.clearTimeout(timer);
      resolve(handler);
    };
    pendingHandlers.set(tabId, [...(pendingHandlers.get(tabId) ?? []), resolveWhenReady]);
  });
}

export async function executeBrowserTabActionWhenReady<T>(
  execute: () => Promise<T>,
  isReady: (result: T) => boolean = () => true,
): Promise<T> {
  const deadline = Date.now() + BROWSER_READY_TIMEOUT_MS;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const result = await execute();
      if (isReady(result)) {
        return result;
      }
      lastError = new Error("The visible browser tab is not ready.");
    } catch (error) {
      if (!isNotReadyError(error)) {
        throw error;
      }
      lastError = error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, BROWSER_READY_RETRY_DELAY_MS));
  }

  throw lastError ?? new Error("The visible browser tab did not become ready.");
}
