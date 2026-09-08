import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type { ServerProviderModel } from "@bigbud/contracts/server/server.providers.ts";
import { describe, expect, it, vi } from "vitest";

import { CODEX_SPARK_MODEL } from "../provider/codexAccount";
import { startSession, type StartSessionOps } from "./codexAppServerManager.startSession";
import type {
  CodexAppServerStartSessionInput,
  CodexSessionContext,
} from "./codexAppServerManager.types";
import { asThreadId } from "./codexAppServerManager.test.helpers";

const processMocks = vi.hoisted(() => ({
  startCodexAppServerProcess: vi.fn(),
}));
const readlineMocks = vi.hoisted(() => ({
  createInterface: vi.fn(() => ({ close: vi.fn() })),
}));

vi.mock("node:readline", () => ({ default: readlineMocks }));
vi.mock("./codexAppServerManager.process", () => processMocks);

const models = [
  model("gpt-current-codex", "medium", ["medium", "max", "ultra", "future-depth"]),
  model("gpt-next-codex", "high", ["high", "ultra"]),
  model("gpt-5.5", "high", ["high"]),
  model(CODEX_SPARK_MODEL, "high", ["high"]),
] satisfies ReadonlyArray<ServerProviderModel>;

function model(slug: string, defaultEffort: string, efforts: ReadonlyArray<string>) {
  return {
    slug,
    name: slug,
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: efforts.map((value) => ({
        value,
        label: value,
        ...(value === defaultEffort ? { isDefault: true } : {}),
      })),
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    },
  } satisfies ServerProviderModel;
}

function modelListResponse(catalog = models): unknown {
  return {
    data: catalog.map((entry) => ({
      model: entry.slug,
      displayName: entry.name,
      supportedReasoningEfforts: entry.capabilities?.reasoningEffortLevels.map(
        ({ value }) => value,
      ),
      defaultReasoningEffort: entry.capabilities?.reasoningEffortLevels.find(
        ({ isDefault }) => isDefault,
      )?.value,
    })),
  };
}

function fakeChild(): ChildProcessWithoutNullStreams {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
    exitCode: null,
  }) as unknown as ChildProcessWithoutNullStreams;
}

function baseInput(
  overrides: Partial<CodexAppServerStartSessionInput> = {},
): CodexAppServerStartSessionInput {
  return {
    threadId: asThreadId("caller-thread"),
    binaryPath: "codex",
    cwd: "/workspace",
    runtimeMode: "full-access",
    model: "gpt-current-codex",
    ...overrides,
  };
}

function createHarness(options?: {
  readonly catalogResponse?: unknown;
  readonly modelListError?: Error;
  readonly accountResponse?: unknown;
  readonly accountReadError?: Error;
  readonly threadStartResponse?: unknown;
  readonly threadStartError?: Error;
  readonly threadResumeResponse?: unknown;
  readonly threadResumeError?: Error;
}) {
  const child = fakeChild();
  processMocks.startCodexAppServerProcess.mockReturnValue(child);
  const sessions: StartSessionOps["sessions"] = new Map();
  const sendRequest = vi.fn(
    async (
      _context: CodexSessionContext,
      method: string,
      _params: unknown,
      _timeoutMs?: number,
    ) => {
      switch (method) {
        case "initialize":
          return {};
        case "model/list":
          if (options?.modelListError) {
            throw options.modelListError;
          }
          return options?.catalogResponse ?? modelListResponse();
        case "account/read":
          if (options?.accountReadError) {
            throw options.accountReadError;
          }
          return (
            options?.accountResponse ?? {
              account: { type: "chatgpt", planType: "pro" },
            }
          );
        case "thread/resume":
          if (options?.threadResumeError) {
            throw options.threadResumeError;
          }
          return options?.threadResumeResponse ?? { thread: { id: "provider-resumed" } };
        case "thread/start":
          if (options?.threadStartError) {
            throw options.threadStartError;
          }
          return options?.threadStartResponse ?? { thread: { id: "provider-new" } };
        default:
          throw new Error(`Unexpected request: ${method}`);
      }
    },
  );
  const updateSession = vi.fn(
    (context: CodexSessionContext, updates: Partial<CodexSessionContext["session"]>) => {
      context.session = { ...context.session, ...updates };
    },
  );
  const ops: StartSessionOps = {
    runPromise: vi.fn(async () => undefined),
    sessions,
    sendRequest: sendRequest as StartSessionOps["sendRequest"],
    writeMessage: vi.fn(),
    attachProcessListeners: vi.fn(),
    updateSession,
    emitEvent: vi.fn(),
    emitLifecycleEvent: vi.fn(),
    emitErrorEvent: vi.fn(),
    stopSession: vi.fn(),
  };

  return { child, ops, sendRequest, sessions, updateSession };
}

function requestParams(sendRequest: ReturnType<typeof vi.fn>, method: string) {
  const call = sendRequest.mock.calls.find((entry) => entry[1] === method);
  expect(call).toBeDefined();
  return call?.[2] as Record<string, unknown>;
}

describe("Codex start-session model selection", () => {
  it.each(["max", "ultra", "future-depth"])(
    "forwards exact dynamic effort %s to thread/start and commits it",
    async (effort) => {
      const { ops, sendRequest, sessions } = createHarness();

      const session = await startSession(baseInput({ effort }), ops);

      expect(sendRequest.mock.calls.find((entry) => entry[1] === "model/list")?.[3]).toBe(5_000);
      const params = requestParams(sendRequest, "thread/start");
      expect(params).toMatchObject({
        model: "gpt-current-codex",
        config: { model_reasoning_effort: effort },
      });
      expect(params).not.toHaveProperty("effort");
      const context = sessions.get(asThreadId("caller-thread"));
      expect(context?.activeModelCatalog).toHaveLength(models.length);
      expect(context?.effectiveModelSelection).toEqual({
        model: "gpt-current-codex",
        effort,
      });
      expect(session).toMatchObject({
        status: "ready",
        model: "gpt-current-codex",
        resumeCursor: { threadId: "provider-new" },
      });
    },
  );

  it("uses the same nested effort config for thread/resume", async () => {
    const { ops, sendRequest } = createHarness();

    await startSession(
      baseInput({ effort: "ultra", resumeCursor: { threadId: "provider-old" } }),
      ops,
    );

    const params = requestParams(sendRequest, "thread/resume");
    expect(params).toMatchObject({
      threadId: "provider-old",
      model: "gpt-current-codex",
      config: { model_reasoning_effort: "ultra" },
    });
    expect(params).not.toHaveProperty("effort");
  });

  it("preserves nested effort config when resume falls back to thread/start", async () => {
    const { ops, sendRequest } = createHarness({
      threadResumeError: new Error("thread/resume: thread not found"),
    });

    await startSession(
      baseInput({ effort: "future-depth", resumeCursor: { threadId: "provider-old" } }),
      ops,
    );

    expect(requestParams(sendRequest, "thread/start")).toMatchObject({
      model: "gpt-current-codex",
      config: { model_reasoning_effort: "future-depth" },
    });
  });

  it("uses a discovered model default when startup effort is omitted", async () => {
    const { ops, sendRequest, sessions } = createHarness();

    await startSession(baseInput(), ops);

    expect(requestParams(sendRequest, "thread/start")).toMatchObject({
      config: { model_reasoning_effort: "medium" },
    });
    expect(sessions.get(asThreadId("caller-thread"))?.effectiveModelSelection).toEqual({
      model: "gpt-current-codex",
      effort: "medium",
    });
  });

  it("starts without effort when model discovery is unavailable and none was requested", async () => {
    const { ops, sendRequest, sessions } = createHarness({
      modelListError: new Error("discovery failed"),
    });

    await startSession(baseInput(), ops);

    const params = requestParams(sendRequest, "thread/start");
    expect(params).not.toHaveProperty("config");
    expect(sessions.get(asThreadId("caller-thread"))?.effectiveModelSelection).toEqual({
      model: "gpt-current-codex",
      effort: undefined,
    });
  });

  it.each([
    {
      kind: "unsupported-effort",
      input: baseInput({ effort: "Ultra" }),
      harnessOptions: undefined,
    },
    {
      kind: "unknown-model",
      input: baseInput({ model: "gpt-unknown-codex" }),
      harnessOptions: undefined,
    },
    {
      kind: "catalog-unavailable",
      input: baseInput({ effort: "ultra" }),
      harnessOptions: { modelListError: new Error("discovery failed") },
    },
    {
      kind: "catalog-unavailable",
      input: baseInput({ effort: "ultra" }),
      harnessOptions: { catalogResponse: { data: null } },
    },
    {
      kind: "unknown-model",
      input: baseInput({ effort: "ultra" }),
      harnessOptions: { catalogResponse: modelListResponse([]) },
    },
  ] as const)("rejects $kind before opening a thread", async ({ kind, input, harnessOptions }) => {
    const harness = createHarness(harnessOptions);

    await expect(startSession(input, harness.ops)).rejects.toMatchObject({
      name: "CodexModelSelectionError",
      kind,
    });
    expect(harness.sendRequest).not.toHaveBeenCalledWith(
      expect.anything(),
      "thread/start",
      expect.anything(),
    );
    const context = harness.sessions.get(asThreadId("caller-thread"));
    expect(context?.effectiveModelSelection).toBeUndefined();
  });

  it("starts configured custom models without unverified effort capabilities", async () => {
    const { ops, sendRequest, sessions } = createHarness();

    await startSession(baseInput({ model: "custom-model", customModels: ["custom-model"] }), ops);

    expect(requestParams(sendRequest, "thread/start")).toMatchObject({ model: "custom-model" });
    const customModel = sessions
      .get(asThreadId("caller-thread"))
      ?.activeModelCatalog?.find((entry) => entry.slug === "custom-model");
    expect(customModel).toMatchObject({ isCustom: true });
    expect(customModel?.capabilities?.reasoningEffortLevels).toEqual([]);
  });

  it("rejects explicit effort for an unverified configured custom model", async () => {
    const harness = createHarness();

    await expect(
      startSession(
        baseInput({
          model: "custom-model",
          effort: "ultra",
          customModels: ["custom-model"],
        }),
        harness.ops,
      ),
    ).rejects.toMatchObject({ kind: "unsupported-effort" });
    expect(harness.sendRequest).not.toHaveBeenCalledWith(
      expect.anything(),
      "thread/start",
      expect.anything(),
    );
  });

  it("does not commit selection when thread/start fails", async () => {
    const { ops, sessions, updateSession } = createHarness({
      threadStartError: new Error("thread/start failed"),
    });

    await expect(startSession(baseInput({ effort: "max" }), ops)).rejects.toThrow(
      "thread/start failed",
    );

    const context = sessions.get(asThreadId("caller-thread"));
    expect(context?.effectiveModelSelection).toBeUndefined();
    expect(updateSession).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "ready" }),
    );
  });

  it("does not commit selection for a malformed successful response", async () => {
    const { ops, sessions } = createHarness({ threadStartResponse: { thread: {} } });

    await expect(startSession(baseInput({ effort: "max" }), ops)).rejects.toThrow(
      "thread/start response did not include a thread id",
    );

    expect(sessions.get(asThreadId("caller-thread"))?.effectiveModelSelection).toBeUndefined();
  });

  it.each([
    ["pro account", { account: { type: "chatgpt", planType: "pro" } }, CODEX_SPARK_MODEL],
    ["plus account", { account: { type: "chatgpt", planType: "plus" } }, "gpt-5.5"],
    ["API key", { account: { type: "apiKey" } }, "gpt-5.5"],
  ] as const)("resolves Spark for a %s", async (_label, accountResponse, expectedModel) => {
    const { ops, sendRequest } = createHarness({ accountResponse });

    await startSession(baseInput({ model: CODEX_SPARK_MODEL }), ops);

    expect(requestParams(sendRequest, "thread/start")).toMatchObject({
      model: expectedModel,
    });
  });

  it("falls back from Spark when account discovery fails", async () => {
    const { ops, sendRequest } = createHarness({
      accountReadError: new Error("account/read failed"),
    });

    await startSession(baseInput({ model: CODEX_SPARK_MODEL }), ops);

    expect(requestParams(sendRequest, "thread/start")).toMatchObject({ model: "gpt-5.5" });
  });
});
