import { describe, expect, it } from "vitest";
import { asThreadId, createSendTurnHarness } from "./codexAppServerManager.test.helpers.ts";
import { toCodexManagerModelSelection } from "../provider/Layers/Codex/Adapter.session.modelSelection.ts";

describe("Codex input transport qualification", () => {
  it("rejects generic files before turn/start even when accompanied by text", async () => {
    const { manager, sendRequest } = createSendTurnHarness();
    await expect(
      manager.sendTurn({
        threadId: asThreadId("thread_1"),
        input: "read",
        attachments: [{ type: "file", url: "data:application/pdf;base64,JVBERg==" }],
      }),
    ).rejects.toMatchObject({ delivery: "not-dispatched" });
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it("maps explicit fast-off to native reset instead of inheriting a prior override", () => {
    expect(
      toCodexManagerModelSelection({
        provider: "codex",
        model: "native-model",
        options: { fastMode: false },
      }),
    ).toEqual({ model: "native-model", serviceTier: null });
  });

  it("sends a null reset only on an explicitly qualified runtime", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();
    Object.assign(context, { runtimeVersion: "0.166.0" });
    await manager.sendTurn({ threadId: asThreadId("thread_1"), input: "hello", serviceTier: null });
    expect(sendRequest).toHaveBeenCalledWith(
      context,
      "turn/start",
      expect.objectContaining({ serviceTier: null }),
      undefined,
    );
  });

  it("does not guess the reset contract for an unknown runtime", async () => {
    const { manager, sendRequest } = createSendTurnHarness();
    await expect(
      manager.sendTurn({ threadId: asThreadId("thread_1"), input: "hello", serviceTier: null }),
    ).rejects.toMatchObject({ delivery: "not-dispatched" });
    expect(sendRequest).not.toHaveBeenCalled();
  });
});
