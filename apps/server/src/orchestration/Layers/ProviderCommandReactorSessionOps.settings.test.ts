import { type ModelSelection, TurnId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ProviderValidationError } from "../../provider/Errors.ts";
import { ensureSessionForThread, sendTurnForThread } from "./ProviderCommandReactorSessionOps.ts";
import {
  createdAt,
  makeSettingsHarness,
  threadId,
} from "./ProviderCommandReactorSessionOps.settings.test.helpers.ts";

vi.mock("./ProviderCommandReactorSessionOps.threadContext.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ProviderCommandReactorSessionOps.threadContext.ts")>()),
  resolveAndExportThreadContextPath: () => Effect.void,
}));

const captured = {
  modelSelection: { provider: "codex", model: "captured-model" } satisfies ModelSelection,
  runtimeMode: "approval-required" as const,
  interactionMode: "plan" as const,
};
const turnInput = { threadId, createdAt, messageText: "Accepted prompt", ...captured };

describe("captured provider execution settings", () => {
  it("uses captured settings for start, status, capability context and send without mutating defaults", async () => {
    const h = makeSettingsHarness();
    await Effect.runPromise(sendTurnForThread(h.services)(turnInput));
    expect(h.startSession.mock.calls[0]?.[1]).toMatchObject({
      runtimeMode: captured.runtimeMode,
      modelSelection: captured.modelSelection,
      providerRuntimeExecutionTargetId: "local",
      workspaceExecutionTargetId: "ssh:devbox",
      sessionEpoch: 1,
    });
    expect(h.setThreadSession.mock.calls.map(([input]) => input.session.runtimeMode)).toEqual([
      "approval-required",
      "approval-required",
      "approval-required",
    ]);
    expect(h.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      modelSelection: captured.modelSelection,
      interactionMode: "plan",
      sessionEpoch: 1,
      input: expect.stringContaining("- runtime: approval-required"),
    });
    expect(h.thread).toMatchObject({
      runtimeMode: "full-access",
      interactionMode: "default",
      modelSelection: { model: "default-model" },
    });

    h.settle();
    await Effect.runPromise(
      sendTurnForThread(h.services)({
        threadId,
        createdAt,
        messageText: "Legacy defaulted prompt",
      }),
    );
    expect(h.startSession.mock.calls[1]?.[1]).toMatchObject({
      runtimeMode: "full-access",
      modelSelection: { model: "default-model" },
    });
    expect(h.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      modelSelection: { model: "default-model" },
      interactionMode: "default",
    });
  });

  it("reuses a matching live runtime despite drifted thread defaults", async () => {
    const h = makeSettingsHarness();
    await Effect.runPromise(ensureSessionForThread(h.services)(threadId, createdAt, captured));
    await Effect.runPromise(ensureSessionForThread(h.services)(threadId, createdAt, captured));
    expect(h.startSession).toHaveBeenCalledTimes(1);
    expect(h.activeSession?.runtimeMode).toBe("approval-required");
  });

  it("publishes the effective runtime when reusing a session after a defaulted start projection", async () => {
    const h = makeSettingsHarness();
    await Effect.runPromise(sendTurnForThread(h.services)(turnInput));
    h.updateThread({
      session: {
        ...h.thread.session!,
        status: "starting",
        activeTurnId: null,
        runtimeMode: "full-access",
      },
    });
    await Effect.runPromise(sendTurnForThread(h.services)(turnInput));
    expect(h.startSession).toHaveBeenCalledTimes(1);
    expect(h.thread.session?.runtimeMode).toBe("approval-required");
  });

  it("restarts a mismatched live runtime with captured settings and preserves the resume/epoch boundary", async () => {
    const h = makeSettingsHarness();
    await Effect.runPromise(ensureSessionForThread(h.services)(threadId, createdAt));
    await Effect.runPromise(ensureSessionForThread(h.services)(threadId, createdAt, captured));
    expect(h.startSession).toHaveBeenCalledTimes(2);
    expect(h.startSession.mock.calls[1]?.[1]).toMatchObject({
      runtimeMode: "approval-required",
      modelSelection: captured.modelSelection,
      resumeCursor: { cursor: "resume" },
      sessionEpoch: 2,
    });
    expect(h.setThreadSession.mock.calls[2]?.[0]).toMatchObject({
      expectedSessionEpoch: 1,
      advanceSessionEpoch: true,
    });
  });

  it("compares the live runtime, not a stale matching projection", async () => {
    const h = makeSettingsHarness();
    await Effect.runPromise(ensureSessionForThread(h.services)(threadId, createdAt));
    h.updateThread({ session: { ...h.thread.session!, runtimeMode: "approval-required" } });
    await Effect.runPromise(ensureSessionForThread(h.services)(threadId, createdAt, captured));
    expect(h.startSession).toHaveBeenCalledTimes(2);
    expect(h.activeSession?.runtimeMode).toBe("approval-required");
  });

  it("carries captured runtime through a fresh inactive restart", async () => {
    const h = makeSettingsHarness();
    await Effect.runPromise(
      ensureSessionForThread(h.services)(threadId, createdAt, {
        ...captured,
        restartFreshIfInactive: true,
      }),
    );
    expect(h.startSession).not.toHaveBeenCalled();
    expect(h.startSessionFresh.mock.calls[0]?.[1]).toMatchObject({
      runtimeMode: "approval-required",
      modelSelection: captured.modelSelection,
    });
  });

  it("resolves legacy defaults once across context-limit recovery", async () => {
    const h = makeSettingsHarness();
    h.sendTurn.mockImplementationOnce(() =>
      Effect.sync(() => {
        h.updateThread({
          runtimeMode: "approval-required",
          interactionMode: "plan",
          modelSelection: captured.modelSelection,
        });
      }).pipe(
        Effect.andThen(
          Effect.fail(
            new ProviderValidationError({
              operation: "sendTurn",
              issue: "maximum context length exceeded",
            }),
          ),
        ),
      ),
    );
    await Effect.runPromise(
      sendTurnForThread(h.services)({ threadId, createdAt, messageText: "Retry this same prompt" }),
    );
    expect(h.startSession.mock.calls.map(([, input]) => input.runtimeMode)).toEqual([
      "full-access",
      "full-access",
    ]);
    expect(
      h.sendTurn.mock.calls.map(([input]) => [input.modelSelection?.model, input.interactionMode]),
    ).toEqual([
      ["default-model", "default"],
      ["default-model", "default"],
    ]);
  });

  it("uses captured settings when the adapter requires a model-change restart", async () => {
    const h = makeSettingsHarness();
    h.getCapabilities.mockImplementation(() =>
      Effect.succeed({ sessionModelSwitch: "restart-session" }),
    );
    await Effect.runPromise(ensureSessionForThread(h.services)(threadId, createdAt));
    await Effect.runPromise(sendTurnForThread(h.services)(turnInput));
    expect(h.startSession.mock.calls[1]?.[1]).toMatchObject({
      modelSelection: captured.modelSelection,
      runtimeMode: "approval-required",
      sessionEpoch: 2,
    });
    expect(h.startSession.mock.calls[1]?.[1].resumeCursor).toBeUndefined();
    expect(h.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      modelSelection: captured.modelSelection,
      interactionMode: "plan",
    });
  });

  it("does not stop ongoing provider work or send another turn", async () => {
    const h = makeSettingsHarness();
    await Effect.runPromise(ensureSessionForThread(h.services)(threadId, createdAt));
    h.setActiveSession({
      ...h.activeSession!,
      status: "running",
      activeTurnId: TurnId.makeUnsafe("unrelated-turn"),
    });
    await expect(Effect.runPromise(sendTurnForThread(h.services)(turnInput))).rejects.toThrow(
      /ongoing/,
    );
    expect(h.startSession).toHaveBeenCalledTimes(1);
    expect(h.stopSession).not.toHaveBeenCalled();
    expect(h.sendTurn).not.toHaveBeenCalled();
  });

  it("does not bypass the runtime admission check for a captured start", async () => {
    const h = makeSettingsHarness();
    h.assertRuntimeStartAllowed.mockImplementation(() => Effect.die(new Error("admission denied")));
    await expect(Effect.runPromise(sendTurnForThread(h.services)(turnInput))).rejects.toThrow(
      "admission denied",
    );
    expect(h.startSession).not.toHaveBeenCalled();
    expect(h.sendTurn).not.toHaveBeenCalled();
    expect(h.setThreadSession.mock.calls[0]?.[0]).toMatchObject({
      expectedSessionEpoch: 0,
      advanceSessionEpoch: true,
      session: { sessionEpoch: 1, runtimeMode: "approval-required" },
    });
  });

  it("retains the provider-binding boundary for captured selections", async () => {
    const h = makeSettingsHarness();
    await expect(
      Effect.runPromise(
        sendTurnForThread(h.services)({
          ...turnInput,
          modelSelection: { provider: "claudeAgent", model: "other-provider" },
        }),
      ),
    ).rejects.toThrow("cannot switch");
    expect(h.startSession).not.toHaveBeenCalled();
    expect(h.sendTurn).not.toHaveBeenCalled();
  });

  it.each(["runtime", "model"])(
    "does not restart ongoing work for a captured %s mismatch",
    async (setting) => {
      const h = makeSettingsHarness("claudeAgent");
      await Effect.runPromise(ensureSessionForThread(h.services)(threadId, createdAt));
      h.setActiveSession({
        ...h.activeSession!,
        status: "running",
        activeTurnId: TurnId.makeUnsafe("unrelated-turn"),
      });
      const options =
        setting === "runtime"
          ? { runtimeMode: "approval-required" as const }
          : {
              runtimeMode: "full-access" as const,
              modelSelection: { provider: "claudeAgent" as const, model: "other-model" },
            };
      await expect(
        Effect.runPromise(ensureSessionForThread(h.services)(threadId, createdAt, options)),
      ).rejects.toThrow(/ongoing|active/i);
      expect(h.startSession).toHaveBeenCalledTimes(1);
      expect(h.stopSession).not.toHaveBeenCalled();
    },
  );
});
