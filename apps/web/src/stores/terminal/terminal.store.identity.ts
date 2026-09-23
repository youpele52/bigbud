import {
  ThreadId,
  type ProviderKind,
  type TerminalEvent,
  type TerminalSessionSnapshot,
} from "@bigbud/contracts";

import { selectTerminalEventEntries, terminalEventBufferKey } from "./helpers.store";

export interface TerminalAgentVersion {
  readonly updatedAt: string;
  readonly runtimeGeneration: string | null;
  readonly status: "running" | "terminated" | "closed";
  readonly retiredGenerations: ReadonlyArray<string>;
}

export interface TerminalAgentIdentityState {
  terminalAgentProviderByKey: Record<string, ProviderKind | null>;
  terminalAgentVersionByKey: Record<string, TerminalAgentVersion>;
}

interface AgentCandidate {
  readonly updatedAt: string;
  readonly runtimeGeneration: string | null;
  readonly provider: ProviderKind | null | undefined;
  readonly kind: "start" | "identity" | "end";
}

function identitySlice(state: TerminalAgentIdentityState): TerminalAgentIdentityState {
  return {
    terminalAgentProviderByKey: state.terminalAgentProviderByKey,
    terminalAgentVersionByKey: state.terminalAgentVersionByKey,
  };
}

function candidateFromSnapshot(snapshot: TerminalSessionSnapshot): AgentCandidate {
  return {
    updatedAt: snapshot.updatedAt,
    runtimeGeneration: snapshot.runtimeGeneration ?? null,
    provider: snapshot.status === "running" ? snapshot.activeAgentProvider : null,
    kind: snapshot.status === "running" ? "start" : "end",
  };
}

function candidateFromEvent(event: TerminalEvent): AgentCandidate | null {
  if (event.type === "started" || event.type === "restarted") {
    return candidateFromSnapshot(event.snapshot);
  }
  if (event.type === "agentIdentity") {
    return {
      updatedAt: event.createdAt,
      runtimeGeneration: event.runtimeGeneration ?? null,
      provider: event.provider,
      kind: "identity",
    };
  }
  if (event.type === "exited" || event.type === "error") {
    return {
      updatedAt: event.createdAt,
      runtimeGeneration: event.runtimeGeneration ?? null,
      provider: null,
      kind: "end",
    };
  }
  return null;
}

function applyCandidate(
  state: TerminalAgentIdentityState,
  key: string,
  candidate: AgentCandidate,
): { state: TerminalAgentIdentityState; blocked: boolean } {
  const current = state.terminalAgentVersionByKey[key];
  if (current) {
    const sameGeneration =
      candidate.runtimeGeneration !== null &&
      candidate.runtimeGeneration === current.runtimeGeneration;
    if (
      (candidate.runtimeGeneration !== null &&
        current.retiredGenerations.includes(candidate.runtimeGeneration)) ||
      (current.status === "closed" && candidate.kind !== "start") ||
      ((current.status === "closed" || current.status === "terminated") && sameGeneration)
    ) {
      return { state: identitySlice(state), blocked: true };
    }
    if (candidate.updatedAt <= current.updatedAt) {
      return {
        state: identitySlice(state),
        blocked: candidate.kind !== "start" || !sameGeneration,
      };
    }
  }

  const retiredGenerations = current ? [...current.retiredGenerations] : [];
  if (
    current?.runtimeGeneration &&
    current.runtimeGeneration !== candidate.runtimeGeneration &&
    !retiredGenerations.includes(current.runtimeGeneration)
  ) {
    retiredGenerations.push(current.runtimeGeneration);
  }
  const terminalAgentProviderByKey = { ...state.terminalAgentProviderByKey };
  if (candidate.provider === undefined) {
    delete terminalAgentProviderByKey[key];
  } else {
    terminalAgentProviderByKey[key] = candidate.provider;
  }
  return {
    state: {
      terminalAgentProviderByKey,
      terminalAgentVersionByKey: {
        ...state.terminalAgentVersionByKey,
        [key]: {
          updatedAt: candidate.updatedAt,
          runtimeGeneration: candidate.runtimeGeneration,
          status: candidate.kind === "end" ? "terminated" : "running",
          retiredGenerations,
        },
      },
    },
    blocked: false,
  };
}

export function applyTerminalAgentEvent(
  state: TerminalAgentIdentityState,
  event: TerminalEvent,
): { state: TerminalAgentIdentityState; blocked: boolean } {
  const candidate = candidateFromEvent(event);
  if (!candidate) return { state: identitySlice(state), blocked: false };
  const key = terminalEventBufferKey(ThreadId.makeUnsafe(event.threadId), event.terminalId);
  return applyCandidate(state, key, candidate);
}

export function hydrateTerminalAgentFromSnapshot(
  state: TerminalAgentIdentityState & {
    terminalEventEntriesByKey: Record<string, ReadonlyArray<{ id: number; event: TerminalEvent }>>;
  },
  snapshot: TerminalSessionSnapshot,
): TerminalAgentIdentityState {
  const threadId = ThreadId.makeUnsafe(snapshot.threadId);
  const key = terminalEventBufferKey(threadId, snapshot.terminalId);
  let next = applyCandidate(state, key, candidateFromSnapshot(snapshot)).state;
  for (const entry of selectTerminalEventEntries(
    state.terminalEventEntriesByKey,
    threadId,
    snapshot.terminalId,
  )) {
    if (entry.event.createdAt <= snapshot.updatedAt) continue;
    next = applyTerminalAgentEvent(next, entry.event).state;
  }
  return next;
}

export function closeTerminalAgentIdentity(
  state: TerminalAgentIdentityState,
  key: string,
): TerminalAgentIdentityState {
  const current = state.terminalAgentVersionByKey[key];
  const retiredGenerations = current ? [...current.retiredGenerations] : [];
  if (current?.runtimeGeneration && !retiredGenerations.includes(current.runtimeGeneration)) {
    retiredGenerations.push(current.runtimeGeneration);
  }
  const terminalAgentProviderByKey = { ...state.terminalAgentProviderByKey };
  delete terminalAgentProviderByKey[key];
  return {
    terminalAgentProviderByKey,
    terminalAgentVersionByKey: {
      ...state.terminalAgentVersionByKey,
      [key]: {
        updatedAt: current?.updatedAt ?? new Date().toISOString(),
        runtimeGeneration: current?.runtimeGeneration ?? null,
        status: "closed",
        retiredGenerations,
      },
    },
  };
}
