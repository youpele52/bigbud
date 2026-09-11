import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { ClientOrchestrationCommand } from "./orchestration.commands";
import {
  ClientThreadMessageSubmitCommand,
  ThreadMessageSubmitCommand,
} from "./orchestration.commands.client.messageSubmit";

const submission = {
  type: "thread.message.submit",
  commandId: "submit",
  threadId: "thread",
  message: { messageId: "message", text: "hello" },
  createdAt: "2026-09-11T00:00:00.000Z",
};

it("accepts attachment-only submissions in client and normalized contracts", () => {
  const attachment = { type: "image", name: "image.png", mimeType: "image/png", sizeBytes: 1 };
  assert.doesNotThrow(() =>
    Schema.decodeUnknownSync(ClientThreadMessageSubmitCommand)({
      ...submission,
      message: {
        ...submission.message,
        text: "",
        attachments: [{ ...attachment, dataUrl: "data:image/png;base64,AA==" }],
      },
    }),
  );
  assert.doesNotThrow(() =>
    Schema.decodeUnknownSync(ThreadMessageSubmitCommand)({
      ...submission,
      message: { ...submission.message, text: "", attachments: [{ ...attachment, id: "image-1" }] },
    }),
  );
});

it("preserves legacy text-only submissions and rejects empty content", () => {
  const parsed = Schema.decodeUnknownSync(ClientThreadMessageSubmitCommand)(submission);
  assert.equal(parsed.delivery, "auto");
  assert.equal(parsed.message.attachments, undefined);
  for (const text of ["", "  "]) {
    assert.throws(() =>
      Schema.decodeUnknownSync(ClientThreadMessageSubmitCommand)({
        ...submission,
        message: { ...submission.message, text },
      }),
    );
  }
});

it.effect("decodes server-owned message submissions with turn metadata", () =>
  Effect.gen(function* () {
    const decode = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
    const parsed = yield* decode({
      type: "thread.message.submit",
      commandId: "command-submit",
      threadId: "thread-1",
      message: {
        messageId: "message-submit",
        text: " follow up ",
        attachments: [
          {
            type: "image",
            name: "reference.png",
            mimeType: "image/png",
            sizeBytes: 1,
            dataUrl: "data:image/png;base64,AA==",
          },
        ],
        replyToMessageId: "message-parent",
      },
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      delivery: "auto",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.type, "thread.message.submit");
    if (parsed.type !== "thread.message.submit") return;
    assert.strictEqual(parsed.message.text, "follow up");
    assert.strictEqual(parsed.message.replyToMessageId, "message-parent");
    assert.strictEqual(parsed.message.attachments?.[0]?.type, "image");
    assert.deepStrictEqual(parsed.modelSelection, { provider: "codex", model: "gpt-5.4" });
  }),
);
