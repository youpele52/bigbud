import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ApprovalRequestId, ThreadId } from "@bigbud/contracts";
import { it, vi, expect } from "@effect/vitest";
import { assert } from "chai";
import { Effect } from "effect";

import { attachmentRelativePath } from "../../../attachments/attachmentStore.ts";
import { makeTurnMethods } from "./Adapter.session.turn.ts";

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
  let promptSent = false;
  const promptAsync = vi.fn(async () => ({ data: {}, error: undefined }));
  const messages = vi.fn(async () => ({
    data: promptSent
      ? [
          {
            info: {
              id: "assistant-msg-1",
              role: "assistant",
              time: { completed: Date.now() },
            },
            parts: [],
          },
        ]
      : [],
    error: undefined,
  }));

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
            promptSent = true;
            return promptAsync();
          },
          messages,
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
      reasoningPartIds: new Set(),
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
      teardownSessionRecord: () => Effect.void,
      serverConfig: { attachmentsDir },
    });

    yield* sendTurn({
      threadId: THREAD_ID,
      input: "Can you see this image?",
      attachments: [attachment],
    });
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;

    assert.equal(promptInputs.length, 1);
    const promptInput = promptInputs[0];
    assert.isDefined(promptInput);
    assert.notProperty(promptInput, "messageID");
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
    assert.isAtLeast(events.length, 1);
  });
});

it.effect("embeds text files inline and sends binary files as file parts to OpenCode", () => {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "opencode-mixed-attachments-"));
  const csvPath = path.join(baseDir, "market_headers.csv");
  const pdfPath = path.join(baseDir, "Science Communication Overview.pdf");
  const csvContent = "col_a,col_b\n1,2\n";
  const pdfText = "Science communication overview";
  writeFileSync(csvPath, csvContent);
  writeFileSync(
    pdfPath,
    Buffer.from(
      `%PDF-1.4
1 0 obj
<< /Length 48 >>
stream
BT
/F1 12 Tf
72 720 Td
(${pdfText}) Tj
ET
endstream
endobj
%%EOF`,
      "latin1",
    ),
  );

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
  let promptSent = false;
  const promptAsync = vi.fn(async () => ({ data: {}, error: undefined }));
  const messages = vi.fn(async () => ({
    data: promptSent
      ? [
          {
            info: {
              id: "assistant-msg-2",
              role: "assistant",
              time: { completed: Date.now() },
            },
            parts: [],
          },
        ]
      : [],
    error: undefined,
  }));

  return Effect.gen(function* () {
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => rmSync(baseDir, { recursive: true, force: true })),
    );

    const record = {
      client: {
        session: {
          promptAsync: async (input: (typeof promptInputs)[number]) => {
            promptInputs.push(input);
            promptSent = true;
            return promptAsync();
          },
          messages,
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
      reasoningPartIds: new Set(),
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
      teardownSessionRecord: () => Effect.void,
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
          sizeBytes: 120,
          sourcePath: pdfPath,
        },
      ],
    });
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;

    assert.equal(promptInputs.length, 1);
    expect(promptInputs[0]).toStrictEqual({
      sessionID: "opencode-session-1",
      parts: [
        {
          type: "text",
          text: `summarise these\n\n<attached_file_contents>\n<file name="market_headers.csv">\n${csvContent.trim()}\n</file>\n</attached_file_contents>`,
        },
        {
          filename: "Science Communication Overview.pdf",
          mime: "application/pdf",
          type: "file",
          url: expect.stringMatching(/^file:\/\/\/.+opencode-mixed-attachments-/),
        },
      ],
      system:
        "You have access to a Chromium browser in this environment. Use it when the task requires live web interaction, navigation, UI verification, login flows, repros, scraping, or screenshots. Prefer codebase inspection first when the task is local-only. Summarize what was verified, including URL and important observations. Avoid unnecessary browser use when terminal or file tools are sufficient.",
    });
  });
});

it.effect("maps prompt responses into canonical OpenCode runtime events", () => {
  const emitted: Array<{ type: string; payload: unknown; itemId?: string; turnId?: string }> = [];
  let promptSent = false;

  const record = {
    client: {
      session: {
        promptAsync: async () => {
          promptSent = true;
          return {
            data: {},
            error: undefined,
          };
        },
        messages: async () => ({
          data: promptSent
            ? [
                {
                  info: {
                    id: "assistant-msg-3",
                    role: "assistant",
                    modelID: "big-pickle",
                    providerID: "opencode",
                    time: { completed: Date.now() },
                    tokens: {
                      input: 12,
                      output: 8,
                      reasoning: 0,
                      cache: { read: 5, write: 0 },
                    },
                  },
                  parts: [
                    {
                      id: "reasoning-part-1",
                      type: "reasoning",
                      text: "Thinking",
                    },
                    {
                      id: "text-part-1",
                      type: "text",
                      text: "Hello from OpenCode",
                    },
                  ],
                },
              ]
            : [],
          error: undefined,
        }),
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
    model: "big-pickle",
    providerID: "opencode",
    updatedAt: new Date().toISOString(),
    lastError: undefined,
    activeTurnId: undefined,
    lastUsage: undefined,
    wasRetrying: false,
    reasoningPartIds: new Set(),
  };

  const { sendTurn } = makeTurnMethods({
    requireSession: () => Effect.succeed(record as never),
    syntheticEventFn: (_threadId, type, payload, extra) =>
      Effect.succeed({
        type,
        payload,
        ...(extra?.itemId ? { itemId: extra.itemId } : {}),
        ...(extra?.turnId ? { turnId: extra.turnId } : {}),
      } as never),
    emitFn: (runtimeEvents) =>
      Effect.sync(() => {
        emitted.push(...(runtimeEvents as unknown as Array<(typeof emitted)[number]>));
      }),
    teardownSessionRecord: () => Effect.void,
    serverConfig: { attachmentsDir: "/tmp/unused-attachments-dir" },
  });

  return Effect.gen(function* () {
    const result = yield* sendTurn({
      threadId: THREAD_ID,
      input: "Say hello",
    });
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;

    expect(result.resumeCursor).toEqual({ sessionId: "opencode-session-1" });
    expect(record.activeTurnId).toBeUndefined();
    expect(record.lastUsage).toEqual({
      usedTokens: 25,
      totalProcessedTokens: 25,
      inputTokens: 12,
      lastInputTokens: 12,
      cachedInputTokens: 5,
      lastCachedInputTokens: 5,
      outputTokens: 8,
      lastOutputTokens: 8,
      lastUsedTokens: 25,
    });
    expect(emitted.map((event) => event.type)).toEqual([
      "turn.started",
      "content.delta",
      "content.delta",
      "thread.token-usage.updated",
      "item.completed",
      "turn.completed",
      "session.state.changed",
    ]);
    expect(
      emitted.find(
        (event) =>
          event.type === "content.delta" &&
          (event.payload as { streamKind?: string }).streamKind === "reasoning_text",
      ),
    ).toMatchObject({
      type: "content.delta",
      payload: { streamKind: "reasoning_text", delta: "Thinking" },
      itemId: "reasoning-part-1",
    });
    expect(
      emitted.find(
        (event) =>
          event.type === "content.delta" &&
          (event.payload as { streamKind?: string }).streamKind === "assistant_text",
      ),
    ).toMatchObject({
      type: "content.delta",
      payload: { streamKind: "assistant_text", delta: "Hello from OpenCode" },
      itemId: "text-part-1",
    });
    expect(emitted.find((event) => event.type === "thread.token-usage.updated")).toMatchObject({
      type: "thread.token-usage.updated",
      payload: {
        usage: {
          usedTokens: 25,
        },
      },
    });
    expect(emitted.find((event) => event.type === "item.completed")).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "assistant_message",
        status: "completed",
        title: "Assistant message",
        detail: "Hello from OpenCode",
      },
      itemId: "text-part-1",
    });
    expect(emitted.find((event) => event.type === "turn.completed")).toMatchObject({
      type: "turn.completed",
      payload: {
        state: "completed",
      },
    });
  });
});

it.effect("tears down broken OpenCode sessions when prompt transport fails", () => {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  let tornDown = false;

  const record = {
    client: {
      session: {
        messages: async () => ({
          data: [],
          error: undefined,
        }),
        promptAsync: async () => ({
          data: undefined,
          error: new TypeError("fetch failed"),
        }),
      },
    },
    releaseServer: () => undefined,
    opencodeSessionId: "opencode-session-transport-failure",
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
    reasoningPartIds: new Set(),
  };

  const { sendTurn } = makeTurnMethods({
    requireSession: () => Effect.succeed(record as never),
    syntheticEventFn: (_threadId, type, payload) =>
      Effect.succeed({
        type,
        payload,
      } as never),
    emitFn: (runtimeEvents) =>
      Effect.sync(() => {
        emitted.push(...(runtimeEvents as unknown as Array<(typeof emitted)[number]>));
      }),
    teardownSessionRecord: () =>
      Effect.sync(() => {
        tornDown = true;
      }),
    serverConfig: { attachmentsDir: "/tmp/unused-attachments-dir" },
  });

  return Effect.gen(function* () {
    yield* sendTurn({
      threadId: THREAD_ID,
      input: "Say hello",
    });
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;

    expect(tornDown).toBe(true);
    expect(emitted.map((event) => event.type)).toEqual([
      "turn.started",
      "runtime.error",
      "turn.completed",
      "session.state.changed",
    ]);
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
    teardownSessionRecord: () => Effect.void,
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
