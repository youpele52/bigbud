import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { Effect } from "effect";

import { makeMuseAdapterShape, type MuseAdapterDeps } from "./Adapter.ts";
import type {
  MuseHostFactory,
  MuseHostOptions,
  MuseNotification,
  MuseServerRequest,
  MuseTransport,
} from "./Client.ts";
import type { MuseSessionState } from "./Adapter.types.ts";

export const threadId = ThreadId.makeUnsafe("muse-hardening");
export const startInput = {
  threadId,
  cwd: process.cwd(),
  runtimeMode: "auto-accept-edits" as const,
  modelSelection: { provider: "muse" as const, model: "muse-spark-1.3", subProviderID: "meta" },
};

/** Deterministic transport: no SDK runtime, native process, credentials or provider traffic. */
export function makeMuseTestHost() {
  let counter = 0;
  let options: MuseHostOptions | undefined;
  let nativeSessionId = "native";
  let modelId = startInput.modelSelection.model;
  let closed = 0;
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const transport: { -readonly [Key in keyof MuseTransport]: MuseTransport[Key] } = {
    initializeResult: {
      grantedCapabilities: ["sessionMcp"],
      sessionDurability: "durable",
      museHome: "/fake-home",
    },
    mintCommandId: () => `cmd-${++counter}`,
    command: async (method, params) => {
      calls.push({ method, params });
      if (method === "session/start" || method === "session/resume") {
        nativeSessionId = String(params.sessionId);
        return {
          session: { sessionId: nativeSessionId, activeTurnId: null, modelId, providerId: "meta" },
          viewCursor: "v",
          history: { mode: "inline" },
          pendingRequests: [],
        };
      }
      if (method === "session/setModel")
        modelId = String((params.model as { modelId: string }).modelId);
      return {
        commandId: params.commandId,
        status: "accepted",
        turnId: params.turnId ?? params.commandId,
        approvalId: params.approvalId,
        userInputId: params.userInputId,
        terminal: true,
        disposition: "started",
        startedNewTurn: true,
      };
    },
    request: async (method) =>
      method === "account/read"
        ? { state: "accountLogin", credentialRequired: true }
        : { session: { sessionId: nativeSessionId, activeTurnId: null, modelId } },
    onNotification: () => undefined,
    onServerRequest: () => undefined,
    close: async () => {
      closed++;
    },
  };
  const factory: MuseHostFactory = async (value) => {
    options = value;
    return transport;
  };
  return {
    transport,
    factory,
    calls,
    closed: () => closed,
    options: () => options,
    sessionId: () => nativeSessionId,
    emit: (notification: MuseNotification) => options?.onNotification?.(notification),
    request: (request: MuseServerRequest) => options!.onServerRequest!(request),
    adapter: (overrides: Partial<MuseAdapterDeps> = {}) =>
      makeMuseAdapterShape({
        hostFactory: factory,
        getSettings: Effect.succeed({ enabled: true, binaryPath: "muse" }),
        platformQualified: true,
        ...overrides,
      }),
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Direct callback tests avoid scheduler sleeps and expose pending/journal ownership. */
export function makeMuseTestState(host = makeMuseTestHost()): MuseSessionState {
  return {
    threadId,
    transport: host.transport,
    nativeSessionId: "native",
    workspace: process.cwd(),
    model: startInput.modelSelection.model,
    subProviderID: "meta",
    runtimeMode: "auto-accept-edits",
    sessionEpoch: 3,
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00.000Z",
    activeTurnId: undefined,
    lastSettledTurnId: undefined,
    items: new Map(),
    queuedTurns: new Map(),
    inFlightStarts: new Map(),
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    journalTurns: new Map(),
    cleanupBridge: async () => undefined,
    closed: false,
  };
}

export function approvalParams(sessionId = "native") {
  return {
    sessionId,
    approvalId: "approval",
    turnId: "turn",
    itemId: "item",
    toolName: "bash",
    availableChoices: [
      { choiceId: "allow", decision: "approved", label: "Allow once", scope: "once" },
    ],
    currentRequirementId: { approvalId: "approval", sourceIndex: 0 },
    subject: { kind: "shell", command: "ls" },
  };
}
