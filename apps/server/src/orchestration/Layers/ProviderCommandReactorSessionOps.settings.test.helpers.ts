import {
  DEFAULT_SERVER_SETTINGS,
  OrchestrationThread,
  type ProviderKind,
  type ProviderSession,
  ThreadId,
  TurnId,
} from "@bigbud/contracts";
import { Effect, Schema } from "effect";
import { vi } from "vitest";

import type { ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import type { SessionOpServices } from "./ProviderCommandReactorSessionOps.types.ts";

export const createdAt = "2026-09-11T00:00:00.000Z";
export const threadId = ThreadId.makeUnsafe("captured-settings-thread");

export function makeSettingsHarness(provider: ProviderKind = "codex") {
  let thread = Schema.decodeUnknownSync(OrchestrationThread)({
    id: threadId,
    projectId: "settings-project",
    title: "Captured settings",
    modelSelection: { provider, model: "default-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    messages: [],
    activities: [],
    checkpoints: [],
    session: null,
    providerRuntimeExecutionTargetId: "local",
    workspaceExecutionTargetId: "ssh:devbox",
    executionTargetId: "ssh:devbox",
  });
  let activeSession: ProviderSession | undefined;
  const start: ProviderServiceShape["startSession"] = (_, input) =>
    Effect.sync(() => {
      activeSession = {
        threadId,
        provider,
        status: "ready",
        runtimeMode: input.runtimeMode,
        model: input.modelSelection?.model ?? "default-model",
        sessionEpoch: input.sessionEpoch ?? 0,
        resumeCursor: input.resumeCursor ?? { cursor: "resume" },
        createdAt,
        updatedAt: createdAt,
      };
      return activeSession;
    });
  const startSession = vi.fn(start);
  const startSessionFresh = vi.fn(start);
  const sendTurn = vi.fn<ProviderServiceShape["sendTurn"]>(() =>
    Effect.succeed({ threadId, turnId: TurnId.makeUnsafe("captured-turn") }),
  );
  const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(() =>
    Effect.sync(() => {
      activeSession = undefined;
    }),
  );
  const setThreadSession = vi.fn<SessionOpServices["setThreadSession"]>((input) =>
    Effect.sync(() => {
      thread = {
        ...thread,
        session: {
          ...input.session,
          sessionEpoch: input.session.sessionEpoch ?? thread.session?.sessionEpoch ?? 0,
        },
      };
    }),
  );
  const assertRuntimeStartAllowed = vi.fn<SessionOpServices["assertRuntimeStartAllowed"]>(
    () => Effect.void,
  );
  const getCapabilities = vi.fn<ProviderServiceShape["getCapabilities"]>(() =>
    Effect.succeed({ sessionModelSwitch: "in-session" }),
  );
  const services = {
    orchestrationEngine: {
      getReadModel: () =>
        Effect.succeed({
          snapshotSequence: 0,
          threads: [thread],
          projects: [],
          updatedAt: createdAt,
        }),
    },
    providerService: {
      startSession,
      startSessionFresh,
      sendTurn,
      stopSession,
      getCapabilities,
      listSessions: () => Effect.succeed(activeSession ? [activeSession] : []),
    },
    serverSettingsService: { getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) },
    serverConfig: { stateDir: "/unused-settings-test", mode: "desktop" },
    threadModelSelections: new Map(),
    capabilityContextStates: new Map(),
    setThreadSession,
    assertRuntimeStartAllowed,
    resolveThread: () => Effect.succeed(thread),
  } as unknown as SessionOpServices;
  return {
    services,
    startSession,
    startSessionFresh,
    sendTurn,
    stopSession,
    setThreadSession,
    assertRuntimeStartAllowed,
    getCapabilities,
    get thread() {
      return thread;
    },
    updateThread: (patch: Partial<OrchestrationThread>) => {
      thread = { ...thread, ...patch };
    },
    get activeSession() {
      return activeSession;
    },
    setActiveSession: (session: ProviderSession | undefined) => {
      activeSession = session;
    },
    settle: () => {
      if (thread.session)
        thread = { ...thread, session: { ...thread.session, status: "ready", activeTurnId: null } };
    },
  };
}
