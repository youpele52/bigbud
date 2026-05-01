import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ApprovalRequestId, ThreadId } from "@bigbud/contracts";
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
    sessionID: string;
    parts: Array<
      | { type: "text"; text: string }
      | {
          type: "file";
          mime: string;
          filename?: string;
          url: string;
          source?: {
            type: "file";
            path: string;
            text: { value: string; start: number; end: number };
          };
        }
    >;
    system?: string;
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
    assert.deepEqual(promptInput, {
      sessionID: "opencode-session-1",
      parts: [
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
      ],
      system:
        "You have access to a Chromium browser in this environment. Use it when the task requires live web interaction, navigation, UI verification, login flows, repros, scraping, or screenshots. Prefer codebase inspection first when the task is local-only. Summarize what was verified, including URL and important observations. Avoid unnecessary browser use when terminal or file tools are sufficient.",
    });
    assert.equal(events.length, 1);
  });
});

it.effect("embeds text files inline and sends binary files as file parts to OpenCode", () => {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "opencode-mixed-attachments-"));
  const csvPath = path.join(baseDir, "market_headers.csv");
  const pdfPath = path.join(baseDir, "Science Communication Overview.pdf");
  const csvContent = "col_a,col_b\n1,2\n";
  writeFileSync(csvPath, csvContent);
  writeFileSync(pdfPath, Uint8Array.from([1, 2, 3, 4]));

  const promptInputs: Array<{
    sessionID: string;
    parts: Array<
      | { type: "text"; text: string }
      | {
          type: "file";
          mime: string;
          filename?: string;
          url: string;
        }
    >;
    system?: string;
  }> = [];
  const promptAsync = vi.fn(async () => ({ data: {}, error: undefined }));

  return Effect.gen(function* () {
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => rmSync(baseDir, { recursive: true, force: true })),
    );

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
      emitFn: () => Effect.void,
      serverConfig: { attachmentsDir: "/tmp/unused-attachments-dir" },
    });

    yield* sendTurn({
      threadId: THREAD_ID,
      input: "summarise these",
      attachments: [
        {
          type: "file",
          id: "thread-opencode-file-1-12345678-1234-1234-1234-123456789abc",
          name: "market_headers.csv",
          mimeType: "text/csv",
          sizeBytes: csvContent.length,
          sourcePath: csvPath,
        },
        {
          type: "file",
          id: "thread-opencode-file-2-12345678-1234-1234-1234-123456789abc",
          name: "Science Communication Overview.pdf",
          mimeType: "application/pdf",
          sizeBytes: 4,
          sourcePath: pdfPath,
        },
      ],
    });

    assert.equal(promptInputs.length, 1);
    assert.deepEqual(promptInputs[0], {
      sessionID: "opencode-session-1",
      parts: [
        {
          type: "text",
          text: `summarise these\n\n<attached_file_contents>\n<file name="market_headers.csv">\n${csvContent}\n</file>\n</attached_file_contents>`,
        },
        {
          type: "file",
          mime: "application/pdf",
          filename: "Science Communication Overview.pdf",
          url: pathToFileURL(pdfPath).href,
        },
      ],
      system:
        "You have access to a Chromium browser in this environment. Use it when the task requires live web interaction, navigation, UI verification, login flows, repros, scraping, or screenshots. Prefer codebase inspection first when the task is local-only. Summarize what was verified, including URL and important observations. Avoid unnecessary browser use when terminal or file tools are sufficient.",
    });
  });
});

it.effect("maps OpenCode user-input answers from stable, header, and question keys", () => {
  const replies: Array<{ requestID: string; answers: Array<Array<string>> }> = [];

  const record = {
    client: {
      question: {
        reply: async (input: { requestID: string; answers: Array<Array<string>> }) => {
          replies.push(input);
          return { data: {}, error: undefined };
        },
      },
    },
    pendingUserInputs: new Map([
      [
        "req-opencode-question",
        {
          turnId: undefined,
          questions: [
            { header: "Scope" },
            { header: "Mode", question: "Which mode?" },
            { header: "Targets" },
          ],
        },
      ],
    ]),
  };

  const emitted: Array<unknown> = [];
  const { respondToUserInput } = makeTurnMethods({
    requireSession: () => Effect.succeed(record as never),
    syntheticEventFn: (threadId, type, payload, extra) =>
      Effect.succeed({
        threadId,
        type,
        payload,
        ...(extra?.requestId ? { requestId: extra.requestId } : {}),
      } as never),
    emitFn: (runtimeEvents) =>
      Effect.sync(() => {
        emitted.push(...runtimeEvents);
      }),
    serverConfig: { attachmentsDir: "/tmp/unused-attachments-dir" },
  });

  return Effect.gen(function* () {
    yield* respondToUserInput(THREAD_ID, ApprovalRequestId.makeUnsafe("req-opencode-question"), {
      "0-scope": "All providers",
      "Which mode?": "Fast",
      Targets: ["server", 42, "web"],
    });

    assert.deepEqual(replies, [
      {
        requestID: "req-opencode-question",
        answers: [["All providers"], ["Fast"], ["server", "web"]],
      },
    ]);
    assert.equal(emitted.length, 1);
  });
});
