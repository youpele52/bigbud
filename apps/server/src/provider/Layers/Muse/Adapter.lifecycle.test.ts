import { ThreadId, TurnId } from "@bigbud/contracts/core/baseSchemas";
import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { makeMuseAdapterShape, type MuseAdapterDeps } from "./Adapter.ts";
import type {
  MuseHostFactory,
  MuseNotification,
  MuseServerRequest,
  MuseTransport,
} from "./Client.ts";

interface FakeCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function makeFakeHost() {
  const calls: Array<FakeCall> = [];
  let counter = 0;
  let options: Parameters<MuseHostFactory>[0] | undefined;
  let runningTurn: string | undefined;
  let model = "muse-spark-1.3";
  const emit = (notification: MuseNotification) => options?.onNotification?.(notification);
  const transport: MuseTransport = {
    initializeResult: {
      grantedCapabilities: ["sessionMcp"],
      sessionDurability: "durable",
      serverVersion: "1.4.14",
      museHome: "/fake-muse-home",
    },
    mintCommandId: () => `00000000-0000-7000-8000-${String(++counter).padStart(12, "0")}`,
    command: async (method, params) => {
      calls.push({ method, params });
      if (method === "session/start" || method === "session/resume") {
        if (typeof params.modelId === "string") model = params.modelId;
        return {
          session: {
            sessionId: params.sessionId,
            activeTurnId: null,
            modelId: model,
            providerId: "meta",
          },
          viewCursor: "cursor-1",
          history: { mode: "inline" },
          pendingRequests: [],
        };
      }
      if (method === "session/setModel") {
        // Mirrors the native host: the selection is a `ModelSelection` object,
        // and a bare `modelId` is rejected as invalid params.
        const selection = params.model as { modelId?: string } | undefined;
        if (!selection?.modelId) {
          throw new Error("Invalid params: session/setModel invalid params: missing field `model`");
        }
        model = selection.modelId;
        return { commandId: params.commandId, status: "accepted" };
      }
      if (method === "turn/start") {
        const turnId = String(params.commandId);
        if (runningTurn) {
          return {
            commandId: params.commandId,
            status: "accepted",
            turnId,
            disposition: "queued",
            startedNewTurn: false,
          };
        }
        runningTurn = turnId;
        queueMicrotask(() => {
          emit({ method: "turn/started", params: { turnId, sessionId: params.sessionId } });
          emit({
            method: "item/completed",
            params: {
              item: {
                itemId: "item-1",
                kind: "agentMessage",
                status: "completed",
                turnId,
                text: "done",
              },
              sessionId: params.sessionId,
            },
          });
          emit({
            method: "turn/completed",
            params: { turnId, terminal: "completed", sessionId: params.sessionId },
          });
          runningTurn = undefined;
        });
        return {
          commandId: params.commandId,
          status: "accepted",
          turnId,
          disposition: "started",
          startedNewTurn: true,
        };
      }
      if (method === "turn/unqueue") {
        queueMicrotask(() =>
          emit({
            method: "turn/unqueued",
            params: {
              turnId: params.turnId,
              commandId: "original-submission",
              sessionId: params.sessionId,
            },
          }),
        );
        return { commandId: params.commandId, status: "accepted", turnId: params.turnId };
      }
      if (method === "turn/cancel") {
        const turnId = params.turnId;
        queueMicrotask(() => {
          emit({
            method: "turn/completed",
            params: { turnId, terminal: "cancelled", sessionId: params.sessionId },
          });
          runningTurn = undefined;
        });
        return { commandId: params.commandId, status: "accepted", turnId: params.turnId };
      }
      return {
        commandId: params.commandId,
        status: "accepted",
        terminal: true,
        approvalId: params.approvalId,
      };
    },
    request: async (method, params) => {
      calls.push({ method, params: {} });
      if (method === "account/read") return { state: "accountLogin", credentialRequired: true };
      if (method === "session/read")
        return {
          session: {
            sessionId: params?.sessionId,
            activeTurnId: runningTurn ?? null,
            modelId: model,
          },
        };
      return {};
    },
    onNotification: () => undefined,
    onServerRequest: () => undefined,
    close: async () => undefined,
  };
  const factory: MuseHostFactory = async (hostOptions) => {
    options = hostOptions;
    return transport;
  };
  return {
    calls,
    factory,
    emit,
    request: (request: MuseServerRequest) =>
      options?.onServerRequest?.(request) ?? Promise.resolve({}),
  };
}

const threadId = ThreadId.makeUnsafe("thread-muse-1");

function deps(
  fake: ReturnType<typeof makeFakeHost>,
  overrides: Partial<MuseAdapterDeps> = {},
): MuseAdapterDeps {
  return {
    hostFactory: fake.factory,
    getSettings: Effect.succeed({ enabled: true, binaryPath: "muse" }),
    platformQualified: true,
    ...overrides,
  };
}

const startInput = {
  threadId,
  cwd: "/workspace",
  runtimeMode: "auto-accept-edits" as const,
  modelSelection: { provider: "muse" as const, model: "muse-spark-1.3", subProviderID: "meta" },
};

describe("Muse adapter lifecycle", () => {
  it("starts with the qualified mapping, sends a turn, and streams canonical events", async () => {
    const fake = makeFakeHost();
    const events: Array<string> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* makeMuseAdapterShape(deps(fake));
        const fiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => events.push(event.type)),
        ).pipe(Effect.forkDetach);
        yield* Effect.sleep(10);
        const session = yield* adapter.startSession(startInput);
        expect(session.provider).toBe("muse");
        expect((session.resumeCursor as { nativeSessionId: string }).nativeSessionId).toBeTruthy();
        const start = fake.calls.find((call) => call.method === "session/start");
        expect(start?.params.permissionProfile).toBe(":ask-me");
        expect(start?.params.approvalMode).toBe("promptUnmatched");
        const turn = yield* adapter.sendTurn({ threadId, input: "hello" });
        expect(turn.turnId).toBeTruthy();
        yield* Effect.sleep(30);
        yield* Fiber.interrupt(fiber);
      }),
    );
    expect(events).toEqual(["session.started", "turn.started", "item.completed", "turn.completed"]);
  });

  it("switches the native model with the SDK ModelSelection shape before the turn", async () => {
    const fake = makeFakeHost();
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* makeMuseAdapterShape(deps(fake));
        yield* adapter.startSession(startInput);
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "switch",
          modelSelection: {
            provider: "muse",
            model: "muse-spark-1.2-contributor",
            subProviderID: "meta",
            options: { reasoningEffort: "high" },
          },
        });
        expect(turn.turnId).toBeTruthy();
        const setModel = fake.calls.find((call) => call.method === "session/setModel");
        expect(setModel?.params.model).toEqual({
          modelId: "muse-spark-1.2-contributor",
          providerId: "meta",
        });
        expect(setModel?.params.modelId).toBeUndefined();
        const start = fake.calls.find((call) => call.method === "turn/start");
        expect(start?.params.reasoningEffort).toBe("high");
        expect((turn.resumeCursor as { model: string }).model).toBe("muse-spark-1.2-contributor");
        // A non-native effort tier fails closed before any turn/start.
        const before = fake.calls.filter((call) => call.method === "turn/start").length;
        expect(
          yield* Effect.exit(
            adapter.sendTurn({
              threadId,
              input: "again",
              modelSelection: {
                provider: "muse",
                model: "muse-spark-1.2-contributor",
                options: { reasoningEffort: "turbo" },
              },
            }),
          ),
        ).toMatchObject({ _tag: "Failure" });
        expect(fake.calls.filter((call) => call.method === "turn/start")).toHaveLength(before);
      }),
    );
  });

  it("fails closed on unqualified modes, sentinel models, attachments and plan mode", async () => {
    const fake = makeFakeHost();
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* makeMuseAdapterShape(deps(fake));
        expect(
          yield* Effect.exit(adapter.startSession({ ...startInput, runtimeMode: "full-access" })),
        ).toMatchObject({ _tag: "Failure" });
        expect(
          yield* Effect.exit(
            adapter.startSession({
              ...startInput,
              modelSelection: { provider: "muse", model: "default" },
            }),
          ),
        ).toMatchObject({ _tag: "Failure" });
        yield* adapter.startSession(startInput);
        expect(
          yield* Effect.exit(adapter.sendTurn({ threadId, input: "hi", interactionMode: "plan" })),
        ).toMatchObject({ _tag: "Failure" });
        expect(fake.calls.some((call) => call.method === "turn/start")).toBe(false);
      }),
    );
  });

  it("refuses session start on a host that cannot enforce its sandbox", async () => {
    const fake = makeFakeHost();
    const factory: MuseHostFactory = async (options) => {
      const transport = await fake.factory(options);
      return {
        ...transport,
        initializeResult: {
          ...transport.initializeResult,
          sandboxAvailability: "unavailable",
          sandboxUnavailableReason: "bubblewrapUnavailable",
        },
      };
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* makeMuseAdapterShape(deps(fake, { hostFactory: factory }));
        const exit = yield* Effect.exit(adapter.startSession(startInput));
        expect(exit).toMatchObject({ _tag: "Failure" });
        expect(JSON.stringify(exit)).toContain("bubblewrap");
        expect(fake.calls.some((call) => call.method === "session/start")).toBe(false);
        expect(fake.calls.some((call) => call.method === "account/read")).toBe(false);
      }),
    );
  });

  it("stays unavailable while the platform gate is unqualified", async () => {
    const fake = makeFakeHost();
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* makeMuseAdapterShape(deps(fake, { platformQualified: false }));
        expect(yield* Effect.exit(adapter.startSession(startInput))).toMatchObject({
          _tag: "Failure",
        });
        expect(fake.calls).toHaveLength(0);
      }),
    );
  });

  it("declares fail-closed capabilities", async () => {
    const fake = makeFakeHost();
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* makeMuseAdapterShape(deps(fake));
        expect(adapter.capabilities.turnControl?.continuation).toBe(false);
        expect(adapter.capabilities.turnControl?.interruptTarget).toBe("exact-turn");
        expect(adapter.capabilities.supportsAttachments).toBe(false);
        expect(adapter.capabilities.conversationFork).toBe("unsupported");
        expect(adapter.capabilities.conversationRewind).toBe("unsupported");
        // providerSubagent gate: native Muse subagents are not projected or
        // controlled in this milestone; the declaration stays gated.
        expect(adapter.capabilities.subagents?.support).toBe("gated");
      }),
    );
  });

  it("decides approvals only with offered choices and never maps localPersistent to session", async () => {
    const fake = makeFakeHost();
    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* makeMuseAdapterShape(deps(fake));
        yield* adapter.startSession(startInput);
        yield* Effect.promise(() =>
          fake.request({
            method: "approval/request",
            params: {
              approvalId: "ap-1",
              sessionId: String(
                fake.calls.find((call) => call.method === "session/start")?.params.sessionId,
              ),
              turnId: "t-1",
              itemId: "item-1",
              toolName: "bash",
              availableChoices: [
                {
                  choiceId: "allow_once",
                  decision: "approved",
                  label: "Allow once",
                  scope: "once",
                },
                {
                  choiceId: "allow_local",
                  decision: "approvedPolicyAmendment",
                  label: "Always",
                  scope: "localPersistent",
                },
                { choiceId: "abort", decision: "abort", label: "Abort", scope: "once" },
              ],
              currentRequirementId: { approvalId: "ap-1", sourceIndex: 0 },
              subject: { kind: "shell", command: "ls" },
            },
          }),
        );
        // No session-scope choice exists, so acceptForSession must refuse.
        expect(
          yield* Effect.exit(
            adapter.respondToRequest(threadId, "ap-1:0" as never, "acceptForSession"),
          ),
        ).toMatchObject({ _tag: "Failure" });
        yield* adapter.respondToRequest(threadId, "ap-1:0" as never, "accept");
        const decide = fake.calls.find((call) => call.method === "approval/decide");
        expect(decide?.params.choiceId).toBe("allow_once");
        expect(decide?.params.requirementId).toEqual({ approvalId: "ap-1", sourceIndex: 0 });
        expect(TurnId.makeUnsafe("x")).toBeTruthy();
      }),
    );
  });
});
