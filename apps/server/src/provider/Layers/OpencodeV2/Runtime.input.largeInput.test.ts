import { expect, it } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { validateV2TurnInput } from "./Runtime.input.ts";

it("admits large text unchanged and never resends the same request", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    const threadId = ThreadId.makeUnsafe("large-input");
    await runtime.start({
      threadId,
      cwd: directory,
      runtimeMode: "approval-required",
      modelSelection: {
        provider: "opencodeV2",
        subProviderID: "synthetic-provider",
        model: "synthetic-model",
      },
    });
    const input = {
      threadId,
      requestMessageId: MessageId.makeUnsafe("large-request"),
      input: `START${"x".repeat(240_000)}END`,
    };
    const owner = runtime.get(threadId);
    expect(validateV2TurnInput(owner, input)).toBe(input.input);
    const result = await runtime.send(input);
    expect(result.threadId).toBe(threadId);
    await expect.poll(() => owner.terminalDelivered).toBe(true);
    const prompts = () => http.calls.filter((call) => call.pathname.endsWith("/prompt"));
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0]!.body.text).toBe(input.input);
    await runtime.send(input);
    expect(prompts()).toHaveLength(1);

    expect(() => validateV2TurnInput(owner, { threadId, input: "  " })).toThrow("bounds rejected");
    const attachment = {
      type: "image" as const,
      id: "image",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 1,
    };
    expect(validateV2TurnInput(owner, { threadId, attachments: [attachment] })).toBe("");
    expect(() =>
      validateV2TurnInput(owner, { ...input, attachments: Array(9).fill(attachment) }),
    ).toThrow("bounds rejected");
    expect(() => validateV2TurnInput(owner, { ...input, sessionEpoch: owner.epoch + 1 })).toThrow(
      "epoch fence",
    );
    expect(() => validateV2TurnInput(owner, { ...input, interactionMode: "plan" })).toThrow(
      "non-default interaction",
    );
  });
});
