import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { TextGenerationError } from "@bigbud/contracts/workspace/git.errors.ts";

import type { AcpSessionRuntimeShape } from "../../provider/acp/AcpSessionRuntime.ts";
import type { CursorAcpRuntimeInput } from "../../provider/acp/CursorAcpSupport.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { TextGeneration, type MetadataTextGenerationAttempt } from "../Services/TextGeneration.ts";
import { makeCursorTextGenerationLive } from "./CursorTextGeneration.ts";
import { runMetadataGenerationAttempt } from "./MetadataTextGeneration.ts";

const mocked = vi.hoisted(() => ({ useRuntime: vi.fn() }));
vi.mock("../../provider/acp/CursorAcpSupport.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../provider/acp/CursorAcpSupport.ts")>()),
  withCursorAcpRuntime: mocked.useRuntime,
}));

type Outcome = "valid" | "empty" | "invalid" | "cancelled" | "transport" | "timeout" | "setup";
function fixture(outcome: Outcome, refuse = false) {
  const calls: string[] = [];
  let notify: Parameters<AcpSessionRuntimeShape["handleSessionUpdate"]>[0] | undefined;
  const runtime = {
    handleSessionUpdate: (handler: typeof notify) =>
      Effect.sync(() => {
        notify = handler;
      }),
    start: () =>
      Effect.sync(() => {
        calls.push("start");
      }),
    setMode: () => Effect.void,
    setModel: (model: string) =>
      Effect.gen(function* () {
        calls.push("model");
        expect(model).toBe("captured-model");
        if (outcome === "setup") return yield* Effect.fail(new Error("private setup error"));
      }),
    getConfigOptions: Effect.succeed([]),
    prompt: () =>
      Effect.gen(function* () {
        calls.push("prompt");
        expect(calls).toEqual(["start", "model", "fence", "prompt"]);
        if (outcome === "timeout") return yield* Effect.never;
        if (outcome === "transport")
          return yield* Effect.fail(new Error("private transport error"));
        yield* notify!({
          sessionId: "fixture",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text:
                outcome === "invalid"
                  ? "not json"
                  : outcome === "empty"
                    ? ""
                    : JSON.stringify({ title: "Repair durable metadata recovery" }),
            },
          },
        });
        return { stopReason: outcome === "cancelled" ? "cancelled" : "end_turn" };
      }),
  };
  const providerSettings = {
    ...DEFAULT_SERVER_SETTINGS.providers,
    cursor: { ...DEFAULT_SERVER_SETTINGS.providers.cursor, binaryPath: "/captured-agent" },
  };
  mocked.useRuntime.mockImplementation(
    (input: CursorAcpRuntimeInput, use: (r: AcpSessionRuntimeShape) => unknown) => {
      expect(input.cursorSettings).toEqual(providerSettings.cursor);
      return use(runtime as unknown as AcpSessionRuntimeShape);
    },
  );
  const beforeDispatch = vi.fn(() =>
    Effect.gen(function* () {
      calls.push("fence");
      expect(calls).toEqual(["start", "model", "fence"]);
      if (refuse)
        return yield* new TextGenerationError({
          operation: "fixture",
          detail: "refused",
          metadataOutcome: "unavailable",
        });
    }),
  );
  const attempt: MetadataTextGenerationAttempt = {
    selection: { provider: "cursor", model: "captured-model" },
    executionTarget: "local",
    providerSettings,
    beforeDispatch,
  };
  const settingsRead = vi.fn(() => DEFAULT_SERVER_SETTINGS);
  const layer = makeCursorTextGenerationLive({ timeoutMs: 25 }).pipe(
    Layer.provide(
      Layer.succeed(ServerSettingsService, {
        getSettings: Effect.sync(settingsRead),
      } as unknown as typeof ServerSettingsService.Service),
    ),
    Layer.provide(NodeServices.layer),
  );
  const run = Effect.gen(function* () {
    const service = yield* TextGeneration;
    return yield* runMetadataGenerationAttempt({
      operation: "generateThreadTitle",
      attempt,
      generate: (metadataAttempt) =>
        service.generateThreadTitle({
          cwd: "/fixture",
          message: "Repair metadata recovery",
          modelSelection: attempt.selection,
          metadataAttempt,
        }),
    }).pipe(Effect.result);
  }).pipe(Effect.provide(layer));
  return { run, calls, beforeDispatch, settingsRead };
}

describe("Cursor metadata prompt submission", () => {
  it("uses captured settings and fences after setup, before the prompt", async () => {
    const f = fixture("valid");
    const result = await Effect.runPromise(f.run);
    expect(result._tag).toBe("Success");
    expect(f.calls).toEqual(["start", "model", "fence", "prompt"]);
    expect(f.beforeDispatch).toHaveBeenCalledTimes(1);
    expect(f.settingsRead).not.toHaveBeenCalled();
  });

  it("does not prompt if the durable claim is refused", async () => {
    const f = fixture("valid", true);
    const result = await Effect.runPromise(f.run);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.metadataOutcome).toBe("unavailable");
    expect(f.calls).not.toContain("prompt");
  });

  it.each([
    ["setup", "unavailable"],
    ["empty", "failed"],
    ["invalid", "failed"],
    ["cancelled", "cancelled"],
    ["transport", "uncertain"],
    ["timeout", "uncertain"],
  ] as const)("classifies %s as %s without hidden retry", async (outcome, expected) => {
    const f = fixture(outcome);
    const result = await Effect.runPromise(f.run);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.metadataOutcome).toBe(expected);
      expect(JSON.stringify(result.failure)).not.toContain("private");
    }
    expect(f.calls.filter((call) => call === "prompt")).toHaveLength(outcome === "setup" ? 0 : 1);
    expect(f.beforeDispatch).toHaveBeenCalledTimes(outcome === "setup" ? 0 : 1);
    expect(f.settingsRead).not.toHaveBeenCalled();
  });
});
