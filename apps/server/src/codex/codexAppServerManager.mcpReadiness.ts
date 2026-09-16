import { readObject, readString } from "./codexAppServerManager.protocol.ts";
import type { JsonRpcNotification } from "./codexAppServerManager.types.ts";

export const CODEX_MCP_STARTUP_STATUS_UPDATED = "mcpServer/startupStatus/updated";
export const CODEX_REQUIRED_MCP_READINESS_TIMEOUT_MS = 10_000;

type ReadinessStatus = "ready" | "failed" | "pending";

interface ReadinessEntry {
  readonly status: ReadinessStatus;
  failureReason?: string;
}

interface AttemptState {
  readonly id: number;
  readonly requestedThreadId: string | undefined;
  readonly observedThreadIds: Set<string>;
  abandoned: boolean;
}

interface Waiter {
  readonly attempt: AttemptState;
  readonly providerThreadId: string;
  readonly serverNames: ReadonlyArray<string>;
  readonly isActive: () => boolean;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface CodexMcpReadinessAttempt {
  readonly id: number;
  readonly abandon: () => void;
}

export interface CodexMcpReadinessTracker {
  readonly observe: (notification: JsonRpcNotification) => void;
  readonly beginAttempt: (requestedThreadId?: string) => CodexMcpReadinessAttempt;
  readonly waitFor: (
    attempt: CodexMcpReadinessAttempt,
    providerThreadId: string,
    serverNames: ReadonlyArray<string>,
    isActive: () => boolean,
  ) => Promise<void>;
  readonly cancel: (reason?: Error) => void;
  readonly dispose: () => void;
  readonly pendingWaiterCount: () => number;
}

function sanitizeFailureReason(value: unknown): string | undefined {
  const reason = typeof value === "string" ? value : undefined;
  if (!reason) return undefined;
  const normalized = reason.replace(/\s+/gu, " ").trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

function readFailureReason(params: Record<string, unknown>): string | undefined {
  const direct = sanitizeFailureReason(params.failureReason);
  if (direct) return direct;
  const error = readObject(params, "error");
  return sanitizeFailureReason(params.error) ?? sanitizeFailureReason(error?.message);
}

function readStatus(params: Record<string, unknown>): ReadinessStatus {
  const status = readString(params, "status")?.toLowerCase();
  if (status === "ready") return "ready";
  if (status === "failed") return "failed";
  return "pending";
}

function requiredNames(serverNames: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(serverNames.filter((name) => name.trim().length > 0))];
}

function failureError(serverName: string, reason: string | undefined): Error {
  return new Error(
    `Required Codex MCP server '${serverName}' failed to start${reason ? `: ${reason}` : "."}`,
  );
}

export function createCodexMcpReadinessTracker(): CodexMcpReadinessTracker {
  const statuses = new Map<string, Map<string, ReadinessEntry>>();
  const ignoredThreadIds = new Set<string>();
  let activeAttempt: AttemptState | undefined;
  let nextAttemptId = 1;
  let waiter: Waiter | undefined;
  let closed = false;

  const clearWaiter = (): Waiter | undefined => {
    const current = waiter;
    if (!current) return undefined;
    if (current.timer !== undefined) clearTimeout(current.timer);
    waiter = undefined;
    return current;
  };

  const finishWaiter = (error?: Error): void => {
    const current = clearWaiter();
    if (!current) return;
    if (error) current.reject(error);
    else current.resolve();
  };

  const evaluate = (): void => {
    const current = waiter;
    if (!current) return;
    if (closed || current.attempt.abandoned) {
      finishWaiter(new Error("Codex MCP readiness attempt was abandoned."));
      return;
    }
    if (!current.isActive()) {
      finishWaiter(new Error("Codex session stopped while waiting for MCP readiness."));
      return;
    }

    const serverStatuses = statuses.get(current.providerThreadId);
    for (const serverName of current.serverNames) {
      const entry = serverStatuses?.get(serverName);
      if (entry?.status === "failed") {
        finishWaiter(failureError(serverName, entry.failureReason));
        return;
      }
    }
    for (const serverName of current.serverNames) {
      const entry = serverStatuses?.get(serverName);
      if (entry?.status !== "ready") return;
    }
    finishWaiter();
  };

  const abandon = (attempt: AttemptState): void => {
    if (attempt.abandoned) return;
    attempt.abandoned = true;
    if (attempt.requestedThreadId) ignoredThreadIds.add(attempt.requestedThreadId);
    for (const threadId of attempt.observedThreadIds) ignoredThreadIds.add(threadId);
    if (attempt.requestedThreadId) statuses.delete(attempt.requestedThreadId);
    for (const threadId of attempt.observedThreadIds) statuses.delete(threadId);
    if (activeAttempt === attempt) activeAttempt = undefined;
    if (waiter?.attempt === attempt) {
      finishWaiter(new Error("Codex MCP readiness attempt was abandoned."));
    }
  };

  const beginAttempt = (requestedThreadId?: string): CodexMcpReadinessAttempt => {
    if (activeAttempt) abandon(activeAttempt);
    const attempt: AttemptState = {
      id: nextAttemptId++,
      requestedThreadId,
      observedThreadIds: new Set(),
      abandoned: false,
    };
    activeAttempt = attempt;
    return { id: attempt.id, abandon: () => abandon(attempt) };
  };

  const observe = (notification: JsonRpcNotification): void => {
    if (closed || notification.method !== CODEX_MCP_STARTUP_STATUS_UPDATED) return;
    const params = readObject(notification.params);
    const providerThreadId = readString(params, "threadId");
    const serverName = readString(params, "name");
    if (!providerThreadId || !serverName || ignoredThreadIds.has(providerThreadId)) return;
    activeAttempt?.observedThreadIds.add(providerThreadId);

    const status = readStatus(params!);
    const serverStatuses = statuses.get(providerThreadId) ?? new Map<string, ReadinessEntry>();
    const previous = serverStatuses.get(serverName);
    if (previous?.status === "failed") return;
    const nextEntry: ReadinessEntry = { status };
    if (status === "failed") {
      const failureReason = readFailureReason(params!);
      if (failureReason) nextEntry.failureReason = failureReason;
    }
    serverStatuses.set(serverName, nextEntry);
    statuses.set(providerThreadId, serverStatuses);
    evaluate();
  };

  const waitFor = (
    attemptRef: CodexMcpReadinessAttempt,
    providerThreadId: string,
    serverNames: ReadonlyArray<string>,
    isActive: () => boolean,
  ): Promise<void> => {
    const names = requiredNames(serverNames);
    if (names.length === 0) return Promise.resolve();
    const attempt = activeAttempt;
    if (!attempt || attemptRef.id !== attempt.id || attempt.abandoned) {
      return Promise.reject(new Error("Codex MCP readiness attempt is no longer active."));
    }
    if (closed || ignoredThreadIds.has(providerThreadId)) {
      return Promise.reject(new Error("Codex MCP readiness thread is no longer active."));
    }
    return new Promise<void>((resolve, reject) => {
      waiter = {
        attempt,
        providerThreadId,
        serverNames: names,
        isActive,
        resolve,
        reject,
        timer: undefined,
      };
      waiter.timer = setTimeout(() => {
        const missing = names.filter(
          (name) => statuses.get(providerThreadId)?.get(name)?.status !== "ready",
        );
        finishWaiter(
          new Error(
            `Timed out after ${CODEX_REQUIRED_MCP_READINESS_TIMEOUT_MS}ms waiting for required Codex MCP server(s): ${missing.join(", ")}.`,
          ),
        );
      }, CODEX_REQUIRED_MCP_READINESS_TIMEOUT_MS);
      evaluate();
    });
  };

  const cancel = (
    reason = new Error("Codex app-server stopped while waiting for MCP readiness."),
  ) => {
    if (closed) return;
    closed = true;
    finishWaiter(reason);
    activeAttempt = undefined;
    statuses.clear();
    ignoredThreadIds.clear();
  };

  const dispose = (): void => {
    cancel(new Error("Codex MCP readiness tracker disposed."));
  };

  return {
    observe,
    beginAttempt,
    waitFor,
    cancel,
    dispose,
    pendingWaiterCount: () => (waiter ? 1 : 0),
  };
}
