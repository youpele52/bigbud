import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { sendTurnForThread } from "./ProviderCommandReactorSessionOps.ts";
import {
  createdAt,
  makeSettingsHarness,
  threadId,
} from "./ProviderCommandReactorSessionOps.settings.test.helpers.ts";

vi.mock("./ProviderCommandReactorSessionOps.threadContext.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ProviderCommandReactorSessionOps.threadContext.ts")>()),
  resolveAndExportThreadContextPath: () => Effect.void,
}));

it("expands canonical V2 thread context once and forwards uploads/workspace directories to target preparation", async () => {
  const h = makeSettingsHarness("opencodeV2");
  const modelSelection = {
    provider: "opencodeV2",
    subProviderID: "synthetic-provider",
    model: "synthetic-model",
  } as const;
  h.updateThread({ modelSelection });
  const referenceId = ThreadId.makeUnsafe("referenced");
  const reference = {
    ...h.thread,
    id: referenceId,
    title: "Canonical reference",
    messages: [
      {
        id: MessageId.makeUnsafe("context"),
        role: "user" as const,
        text: "canonical content",
        createdAt,
        updatedAt: createdAt,
        turnId: null,
        streaming: false,
      },
    ],
  };
  const resolve = vi.fn((id: ThreadId) =>
    Effect.succeed(id === referenceId ? reference : h.thread),
  );
  Object.assign(h.services, { resolveThread: resolve });
  const upload = {
    type: "file",
    id: "upload",
    name: "file",
    mimeType: "text/plain",
    sizeBytes: 1,
  } as const;
  const directory = {
    type: "path",
    id: "directory",
    name: "workspace",
    path: "/workspace",
    entryKind: "directory",
    sizeBytes: 0,
    mimeType: "inode/directory",
  } as const;
  await Effect.runPromise(
    sendTurnForThread(h.services)({
      threadId,
      createdAt,
      modelSelection,
      requestMessageId: MessageId.makeUnsafe("with-context"),
      messageText: "use context",
      attachments: [
        upload,
        directory,
        {
          type: "thread",
          id: "reference",
          name: "reference",
          threadId: referenceId,
          title: "reference",
          mimeType: "application/x-bigbud-thread-reference",
          sizeBytes: 0,
        },
      ],
    }),
  );
  expect(h.sendTurn).toHaveBeenCalledOnce();
  const sent = h.sendTurn.mock.calls[0]![0];
  expect(sent.attachments).toEqual([upload, directory]);
  expect(sent.input).toContain("canonical content");
  expect(sent.input?.match(/canonical content/g)).toHaveLength(1);
  expect(resolve).toHaveBeenCalledWith(referenceId);
});
