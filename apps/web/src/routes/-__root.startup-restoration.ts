import {
  ThreadId,
  type GetThreadOwnershipResult,
  type NativeApi,
  type ProjectId,
} from "@bigbud/contracts";

import { isVisibleThread } from "../logic/thread/threadVisibility.logic";
import { useStore } from "../stores/main";

export type StartupRouteIntent =
  | { kind: "root" }
  | { kind: "explicit-thread"; threadId: ThreadId }
  | { kind: "non-thread" };

export interface StartupRestorationCandidate {
  expectedProjectId: ProjectId | null;
  isPersisted: boolean;
  source: "server" | "persisted";
  threadId: ThreadId;
}

export type StartupCandidateValidation = "valid" | "stale" | "unavailable";
export type StartupRestorationOutcome =
  | "explicit-thread"
  | "non-thread"
  | "restored"
  | "fresh"
  | "unavailable"
  | "cancelled";

const NON_THREAD_ROUTE_PREFIXES = ["/automations", "/plugins", "/settings", "/usage"] as const;

export function resolveStartupRouteIntent(pathname: string): StartupRouteIntent {
  if (pathname === "/") {
    return { kind: "root" };
  }
  if (
    NON_THREAD_ROUTE_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    )
  ) {
    return { kind: "non-thread" };
  }
  if (!/^\/[^/]+$/.test(pathname)) {
    return { kind: "non-thread" };
  }
  try {
    const value = decodeURIComponent(pathname.slice(1));
    return value.length > 0 && value.trim() === value
      ? { kind: "explicit-thread", threadId: ThreadId.makeUnsafe(value) }
      : { kind: "non-thread" };
  } catch {
    return { kind: "non-thread" };
  }
}

export function resolveRootRestorationCandidates(input: {
  bootstrapProjectId: ProjectId | null;
  bootstrapThreadId: ThreadId | null;
  persistedThreadId: ThreadId | null;
}): StartupRestorationCandidate[] {
  const candidates: StartupRestorationCandidate[] = [];
  if (input.bootstrapProjectId && input.bootstrapThreadId) {
    candidates.push({
      expectedProjectId: input.bootstrapProjectId,
      isPersisted: input.persistedThreadId === input.bootstrapThreadId,
      source: "server",
      threadId: input.bootstrapThreadId,
    });
  }
  if (
    input.persistedThreadId &&
    !candidates.some((candidate) => candidate.threadId === input.persistedThreadId)
  ) {
    candidates.push({
      expectedProjectId: null,
      isPersisted: true,
      source: "persisted",
      threadId: input.persistedThreadId,
    });
  }
  return candidates;
}

export function classifyStartupCandidate(input: {
  candidate: StartupRestorationCandidate;
  ownership: GetThreadOwnershipResult;
}): StartupCandidateValidation {
  const { candidate, ownership } = input;
  if (ownership.status === "unavailable") {
    return "unavailable";
  }
  if (ownership.status !== "active") {
    return "stale";
  }
  if (candidate.expectedProjectId && ownership.projectId !== candidate.expectedProjectId) {
    return "stale";
  }

  const state = useStore.getState();
  const thread = state.threads.find((entry) => entry.id === candidate.threadId);
  const project = state.projects.find((entry) => entry.id === ownership.projectId);
  const hydration = state.threadHydrationById[candidate.threadId];
  if (!thread || !isVisibleThread(thread) || thread.projectId !== ownership.projectId) {
    return thread ? "stale" : "unavailable";
  }
  if (thread.archivedAt !== null || thread.deletingAt != null || project?.deletingAt != null) {
    return "stale";
  }
  return hydration?.status === "complete" || hydration?.status === "loaded"
    ? "valid"
    : "unavailable";
}

export async function validateStartupRestorationCandidate(input: {
  api: Pick<NativeApi, "orchestration">;
  candidate: StartupRestorationCandidate;
}): Promise<StartupCandidateValidation> {
  try {
    const ownership = await input.api.orchestration.resolveThreadOwnership({
      threadId: input.candidate.threadId,
    });
    return classifyStartupCandidate({ candidate: input.candidate, ownership });
  } catch {
    return "unavailable";
  }
}

export async function runCoalescedStartupFreshChat(input: {
  inFlight: { current: { promise: Promise<void>; runId: number } | null };
  isCurrent: () => boolean;
  runId: number;
  start: () => Promise<void> | void;
}): Promise<void> {
  while (input.isCurrent()) {
    const active = input.inFlight.current;
    if (active) {
      try {
        await active.promise;
      } catch {
        // A newer run retries after an older failed attempt settles.
      }
      if (!input.isCurrent() || active.runId === input.runId) return;
      continue;
    }

    const attempt = Promise.resolve().then(async () => {
      if (input.isCurrent()) await input.start();
    });
    const operation = { promise: attempt, runId: input.runId };
    input.inFlight.current = operation;
    try {
      await attempt;
    } finally {
      if (input.inFlight.current === operation) input.inFlight.current = null;
    }
    return;
  }
}

export async function restoreStartupContext(input: {
  pathname: string;
  bootstrapProjectId: ProjectId | null;
  bootstrapThreadId: ThreadId | null;
  persistedThreadId: ThreadId | null;
  bootstrap: (threadId: ThreadId | null) => Promise<unknown>;
  validate: (candidate: StartupRestorationCandidate) => Promise<StartupCandidateValidation>;
  clearPersistedThread: () => void;
  isCurrent: () => boolean;
  navigateToThread: (threadId: ThreadId) => Promise<unknown>;
  startFreshChat: () => Promise<unknown>;
}): Promise<StartupRestorationOutcome> {
  const routeIntent = resolveStartupRouteIntent(input.pathname);
  if (routeIntent.kind === "explicit-thread") {
    await input.bootstrap(routeIntent.threadId);
    return input.isCurrent() ? "explicit-thread" : "cancelled";
  }
  if (routeIntent.kind === "non-thread") {
    await input.bootstrap(null);
    return input.isCurrent() ? "non-thread" : "cancelled";
  }

  const candidates = resolveRootRestorationCandidates(input);
  if (candidates.length === 0) {
    try {
      await input.bootstrap(null);
    } catch {
      return "unavailable";
    }
    if (!input.isCurrent()) return "cancelled";
  }
  for (const candidate of candidates) {
    try {
      await input.bootstrap(candidate.threadId);
    } catch {
      return "unavailable";
    }
    if (!input.isCurrent()) return "cancelled";
    const validation = await input.validate(candidate);
    if (!input.isCurrent()) return "cancelled";
    if (validation === "unavailable") {
      return "unavailable";
    }
    if (validation === "valid") {
      if (!input.isCurrent()) return "cancelled";
      await input.navigateToThread(candidate.threadId);
      return "restored";
    }
    if (candidate.isPersisted) {
      if (!input.isCurrent()) return "cancelled";
      input.clearPersistedThread();
    }
  }
  if (!input.isCurrent()) return "cancelled";
  await input.startFreshChat();
  return "fresh";
}
