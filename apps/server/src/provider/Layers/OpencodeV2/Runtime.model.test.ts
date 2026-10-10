import { expect, it, vi } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";

const threadId = ThreadId.makeUnsafe("model-switch-thread");
const modelSelection = {
  provider: "opencodeV2" as const,
  subProviderID: "synthetic-provider",
  model: "synthetic-model",
};
const next = { ...modelSelection, model: "second-model", options: { variant: "precise" } };

it("switches only new idle turns in the same native history and replays the original model admission unchanged", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    const original = {
      threadId,
      modelSelection,
      requestMessageId: MessageId.makeUnsafe("model-first"),
      input: "first",
    };
    const first = await runtime.send(original);
    const nativeId = runtime.get(threadId).native.id;
    await expect.poll(() => runtime.get(threadId).terminalDelivered).toBe(true);
    await runtime.send({
      ...original,
      requestMessageId: MessageId.makeUnsafe("model-second"),
      input: "second",
      modelSelection: next,
    });
    await expect.poll(() => runtime.get(threadId).terminalDelivered).toBe(true);
    expect(runtime.get(threadId).native.id).toBe(nativeId);
    expect(runtime.get(threadId).model).toEqual({
      id: "second-model",
      providerID: "synthetic-provider",
      variant: "precise",
    });
    expect(
      http.calls.filter((c) => c.pathname.endsWith("/model") && c.method === "POST"),
    ).toHaveLength(1);
    expect(
      http.calls.filter((c) => c.pathname === "/api/session" && c.method === "POST"),
    ).toHaveLength(1);
    expect((await runtime.send(original)).turnId).toBe(first.turnId);
    expect(http.calls.filter((c) => c.pathname.endsWith("/prompt"))).toHaveLength(2);
    expect(
      http.calls.filter((c) => c.pathname.endsWith("/model") && c.method === "POST"),
    ).toHaveLength(1);
    await expect(runtime.send({ ...original, modelSelection: next })).rejects.toThrow();
  });
});

it("rejects switching with unresolved execution before mutation", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    http.autoComplete = false;
    const input = {
      threadId,
      modelSelection,
      requestMessageId: MessageId.makeUnsafe("model-held"),
      input: "held",
    };
    await runtime.send(input);
    await expect(
      runtime.send({
        ...input,
        requestMessageId: MessageId.makeUnsafe("model-blocked"),
        modelSelection: next,
      }),
    ).rejects.toThrow();
    expect(
      http.calls.filter((c) => c.pathname.endsWith("/model") && c.method === "POST"),
    ).toHaveLength(0);
  });
});

it("lost switch acknowledgement is read back without resending and quarantines later prompts", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    const nativeSwitch = http.client.session.switchModel;
    const spy = vi
      .spyOn(http.client.session, "switchModel")
      .mockImplementationOnce(async (...args) => {
        await nativeSwitch(...args);
        throw new Error("lost acknowledgement");
      });
    const input = {
      threadId,
      modelSelection: next,
      requestMessageId: MessageId.makeUnsafe("model-loss"),
      input: "new",
    };
    await expect(runtime.send(input)).rejects.toThrow("unconfirmed");
    await expect.poll(() => runtime.get(threadId).model.id).toBe("second-model");
    expect(() => runtime.mutations.assertSafe()).toThrow("quarantined");
    await expect(runtime.send(input)).rejects.toThrow("quarantined");
    expect(spy).toHaveBeenCalledTimes(1);
    await expect(
      runtime.send({ ...input, requestMessageId: MessageId.makeUnsafe("quarantined") }),
    ).rejects.toThrow("quarantined");
    expect(http.calls.filter((c) => c.pathname.endsWith("/prompt"))).toHaveLength(0);
  });
});
