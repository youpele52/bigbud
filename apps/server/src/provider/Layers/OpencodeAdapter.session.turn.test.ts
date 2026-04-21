import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ThreadId } from "@bigbud/contracts";
import { assert, it, vi } from "@effect/vitest";
import { Effect } from "effect";

import { attachmentRelativePath } from "../../attachments/attachmentStore.ts";
import { makeTurnMethods } from "./OpencodeAdapter.session.turn.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-opencode-attachment-test");

it.effect("sends image attachments to OpenCode as file parts", () => {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "opencode-attachments-"));
  const attachmentsDir = path.join(baseDir, "attachments");
  mkdirSync(attachmentsDir, { recursive: true });

  const promptInputs: Array<{
    path: { id: string };
    query?: { directory: string };
    body: {
      parts: Array<
        | { type: "text"; text: string }
        | { type: "file"; mime: string; filename?: string; url: string }
      >;
    };
  }> = [];
  const promptAsync = vi.fn(async () => ({ data: {}, error: undefined }));

  return Effect.gen(function* () {
    yield* Effect.addFinalizer(() =>
      Effect.sync(() =>
        rmSync(baseDir, {
          recursive: true,
          force: true,
        }),
      ),
    );

    const attachment = {
      type: "image" as const,
      id: "thread-opencode-attachment-12345678-1234-1234-1234-123456789abc",
      name: "diagram.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    const attachmentPath = path.join(attachmentsDir, attachmentRelativePath(attachment));
    mkdirSync(path.dirname(attachmentPath), { recursive: true });
    writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));

    const record = {
      client: {
        session: {
          promptAsync: async (input: (typeof promptInputs)[number]) => {
            promptInputs.push(input);
            return promptAsync();
          },
        },
      },
      releaseServer: () => undefined,
      opencodeSessionId: "opencode-session-1",
      threadId: THREAD_ID,
      createdAt: new Date().toISOString(),
      runtimeMode: "full-access" as const,
      pendingPermissions: new Map(),
      pendingUserInputs: new Map(),
      turns: [],
      sseAbortController: null,
      cwd: "/tmp/opencode-project",
      model: undefined,
      providerID: undefined,
      updatedAt: new Date().toISOString(),
      lastError: undefined,
      activeTurnId: undefined,
      lastUsage: undefined,
      wasRetrying: false,
    };

    const events: Array<unknown> = [];
    const { sendTurn } = makeTurnMethods({
      requireSession: () => Effect.succeed(record as never),
      syntheticEventFn: (threadId, type, payload, extra) =>
        Effect.succeed({
          eventId: "event-1",
          provider: "opencode",
          threadId,
          createdAt: new Date().toISOString(),
          type,
          payload,
          ...(extra?.turnId ? { turnId: extra.turnId } : {}),
          ...(extra?.itemId ? { itemId: extra.itemId } : {}),
          ...(extra?.requestId ? { requestId: extra.requestId } : {}),
        } as never),
      emitFn: (runtimeEvents) =>
        Effect.sync(() => {
          events.push(...runtimeEvents);
        }),
      serverConfig: { attachmentsDir },
    });

    yield* sendTurn({
      threadId: THREAD_ID,
      input: "Can you see this image?",
      attachments: [attachment],
    });

    assert.equal(promptInputs.length, 1);
    const promptInput = promptInputs[0];
    assert.isDefined(promptInput);
    assert.deepEqual(promptInput.path, { id: "opencode-session-1" });
    assert.deepEqual(promptInput.query, { directory: "/tmp/opencode-project" });
    assert.deepEqual(promptInput.body.parts, [
      {
        type: "text",
        text: "Can you see this image?",
      },
      {
        type: "file",
        mime: "image/png",
        filename: "diagram.png",
        url: pathToFileURL(attachmentPath).href,
      },
    ]);
    assert.equal(events.length, 1);
  });
});
