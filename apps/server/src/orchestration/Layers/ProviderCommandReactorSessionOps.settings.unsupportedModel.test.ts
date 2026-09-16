import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

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

// CLIProxy is the current registered adapter with unsupported model switching.
const makeHarness = () => {
  const h = makeSettingsHarness("cliProxy");
  h.getCapabilities.mockImplementation(() => Effect.succeed({ sessionModelSwitch: "unsupported" }));
  return h;
};
const input = { threadId, createdAt, messageText: "Accepted CLIProxy prompt" };

describe("captured model with unsupported session switching", () => {
  it.each(["full-access", "approval-required"] as const)(
    "rejects an explicitly captured different model before send or incidental %s restart",
    async (runtimeMode) => {
      const h = makeHarness();
      await Effect.runPromise(ensureSessionForThread(h.services)(threadId, createdAt));
      await expect(
        Effect.runPromise(
          sendTurnForThread(h.services)({
            ...input,
            runtimeMode,
            modelSelection: { provider: "cliProxy", model: "captured-different-model" },
          }),
        ),
      ).rejects.toThrow(/captured.*model|model.*unsupported/i);
      expect(h.startSession).toHaveBeenCalledTimes(1);
      expect(h.sendTurn).not.toHaveBeenCalled();
      expect(h.stopSession).not.toHaveBeenCalled();
    },
  );

  it("retains the live model for a legacy omitted selection after default drift", async () => {
    const h = makeHarness();
    await Effect.runPromise(ensureSessionForThread(h.services)(threadId, createdAt));
    h.updateThread({ modelSelection: { provider: "cliProxy", model: "drifted-default" } });
    await Effect.runPromise(sendTurnForThread(h.services)(input));
    expect(h.startSession).toHaveBeenCalledTimes(1);
    expect(h.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      modelSelection: { model: "default-model" },
    });
    expect(h.thread.modelSelection.model).toBe("drifted-default");
  });

  it("accepts an explicitly captured matching live model", async () => {
    const h = makeHarness();
    await Effect.runPromise(ensureSessionForThread(h.services)(threadId, createdAt));
    await Effect.runPromise(
      sendTurnForThread(h.services)({
        ...input,
        modelSelection: { provider: "cliProxy", model: "default-model" },
      }),
    );
    expect(h.startSession).toHaveBeenCalledTimes(1);
    expect(h.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      modelSelection: { model: "default-model" },
    });
  });

  it("does not substitute a different model returned by a fresh provider start", async () => {
    const h = makeHarness();
    const start = h.startSession.getMockImplementation()!;
    h.startSession.mockImplementation((id, options) =>
      start(id, options).pipe(
        Effect.map((session) => {
          const different = { ...session, model: "provider-returned-model" };
          h.setActiveSession(different);
          return different;
        }),
      ),
    );
    await expect(
      Effect.runPromise(
        sendTurnForThread(h.services)({
          ...input,
          modelSelection: { provider: "cliProxy", model: "captured-model" },
        }),
      ),
    ).rejects.toThrow(/captured.*model|model.*unsupported/i);
    expect(h.sendTurn).not.toHaveBeenCalled();
  });
});
