import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  asMessageId,
  asTurnId,
  createHarness,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

describe("ProviderCommandReactor", () => {
  registerProviderCommandReactorTestCleanup();

  it("reacts to thread.turn.start by ensuring session and sending provider turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-1"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[0]).toEqual(ThreadId.makeUnsafe("thread-1"));
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });

    await waitFor(async () => {
      const readModel = await Effect.runPromise(harness.engine.getReadModel());
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"))?.session
          ?.status === "running"
      );
    });
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.status).toBe("running");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
    expect(thread?.session?.activeTurnId).toEqual(asTurnId("turn-1"));
  });

  it("adds attached file metadata with full source path to providers", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const sourcePath = "/Users/alice/Desktop/report.pdf";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-attachment-metadata"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-attachment-metadata"),
          role: "user",
          text: "summarize this",
          attachments: [
            {
              type: "file",
              id: "thread-attachment-00000000-0000-4000-8000-000000000001",
              name: "report.pdf",
              mimeType: "application/pdf",
              sizeBytes: 120_000,
              sourcePath,
            },
          ],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    const sendInput = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(sendInput?.input).toContain("<attached_files>");
    expect(sendInput?.input).toContain(
      `- report.pdf (application/pdf, 120000 bytes) -> ${sourcePath}`,
    );
  });

  it("adds path-reference attachment metadata with full path to providers", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const attachmentPath = "/Users/alice/Resumes/index.html";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-path-ref-metadata"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-path-ref-metadata"),
          role: "user",
          text: "whats this file path",
          attachments: [
            {
              type: "path",
              id: "thread-attachment-00000000-0000-4000-8000-000000000010",
              name: "index.html",
              mimeType: "text/html",
              sizeBytes: 0,
              path: attachmentPath,
              entryKind: "file",
            },
          ],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    const sendInput = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(sendInput?.input).toContain("<attached_files>");
    expect(sendInput?.input).toContain(`- index.html (file, path reference) -> ${attachmentPath}`);
  });

  it("injects structured reply context into provider input for replied messages", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-parent"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-parent"),
          role: "user",
          text: "original question",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-reply"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-reply"),
          role: "user",
          text: "follow up",
          attachments: [],
          replyToMessageId: asMessageId("user-message-parent"),
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    const sendInput = harness.sendTurn.mock.calls[1]?.[0] as { input?: string } | undefined;
    expect(sendInput?.input).toContain("<reply_to_message");
    expect(sendInput?.input).toContain('message_id="user-message-parent"');
    expect(sendInput?.input).toContain('role="user"');
    expect(sendInput?.input).toContain("original question");
    expect(sendInput?.input).toContain("follow up");
  });

  it("adds generic attached file metadata uniformly for Pi with full source path", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        provider: "pi",
        model: "claude-sonnet-4",
        subProviderID: "anthropic",
      },
    });
    const now = new Date().toISOString();
    const sourcePath = "/Users/alice/Desktop/report.pdf";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-pi-attachment-metadata"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-pi-attachment-metadata"),
          role: "user",
          text: "summarize this",
          attachments: [
            {
              type: "file",
              id: "thread-attachment-00000000-0000-4000-8000-000000000001",
              name: "report.pdf",
              mimeType: "application/pdf",
              sizeBytes: 120_000,
              sourcePath,
            },
          ],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    const sendInput = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(sendInput?.input).toContain("<attached_files>");
    expect(sendInput?.input).toContain(
      `- report.pdf (application/pdf, 120000 bytes) -> ${sourcePath}`,
    );
  });
});
