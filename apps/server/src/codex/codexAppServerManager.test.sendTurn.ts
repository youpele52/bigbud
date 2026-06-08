import { describe, expect, it, vi } from "vitest";

import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "./codexAppServerManager";
import { asThreadId, createSendTurnHarness } from "./codexAppServerManager.test.helpers";

vi.mock("./codexVersionCheck", () => ({
  assertSupportedCodexCliVersion: vi.fn(),
}));

describe("sendTurn", () => {
  it("sends text and image user input items to turn/start", async () => {
    const { manager, context, requireSession, sendRequest, updateSession } =
      createSendTurnHarness();

    const result = await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Inspect this image",
      attachments: [
        {
          type: "image",
          url: "data:image/png;base64,AAAA",
        },
      ],
      model: "gpt-5.3",
      serviceTier: "fast",
      effort: "high",
    });

    expect(result).toEqual({
      threadId: "thread_1",
      turnId: "turn_1",
      resumeCursor: { threadId: "thread_1" },
    });
    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(sendRequest).toHaveBeenCalledWith(
      context,
      "turn/start",
      {
        threadId: "thread_1",
        input: [
          {
            type: "text",
            text: "Inspect this image",
            text_elements: [],
          },
          {
            type: "image",
            url: "data:image/png;base64,AAAA",
          },
        ],
        model: "gpt-5.3-codex",
        serviceTier: "fast",
        effort: "high",
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
      undefined,
    );
    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "running",
      activeTurnId: "turn_1",
      resumeCursor: { threadId: "thread_1" },
    });
  });

  it("supports image-only turns", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      attachments: [
        {
          type: "image",
          url: "data:image/png;base64,BBBB",
        },
      ],
    });

    expect(sendRequest).toHaveBeenCalledWith(
      context,
      "turn/start",
      {
        threadId: "thread_1",
        input: [
          {
            type: "image",
            url: "data:image/png;base64,BBBB",
          },
        ],
        model: "gpt-5.3-codex",
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
      undefined,
    );
  });

  it("passes Codex plan mode as a collaboration preset on turn/start", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Plan the work",
      interactionMode: "plan",
    });

    expect(sendRequest).toHaveBeenCalledWith(
      context,
      "turn/start",
      {
        threadId: "thread_1",
        input: [
          {
            type: "text",
            text: "Plan the work",
            text_elements: [],
          },
        ],
        model: "gpt-5.3-codex",
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "gpt-5.3-codex",
            reasoning_effort: "medium",
            developer_instructions: CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
          },
        },
      },
      undefined,
    );
  });

  it("passes Codex default mode as a collaboration preset on turn/start", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "PLEASE IMPLEMENT THIS PLAN:\n- step 1",
      interactionMode: "default",
    });

    expect(sendRequest).toHaveBeenCalledWith(
      context,
      "turn/start",
      {
        threadId: "thread_1",
        input: [
          {
            type: "text",
            text: "PLEASE IMPLEMENT THIS PLAN:\n- step 1",
            text_elements: [],
          },
        ],
        model: "gpt-5.3-codex",
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        collaborationMode: {
          mode: "default",
          settings: {
            model: "gpt-5.3-codex",
            reasoning_effort: "medium",
            developer_instructions: CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
          },
        },
      },
      undefined,
    );
  });

  it("keeps the session model when interaction mode is set without an explicit model", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();
    context.session.model = "gpt-5.2-codex";

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Plan this with my current session model",
      interactionMode: "plan",
    });

    expect(sendRequest).toHaveBeenCalledWith(
      context,
      "turn/start",
      {
        threadId: "thread_1",
        input: [
          {
            type: "text",
            text: "Plan this with my current session model",
            text_elements: [],
          },
        ],
        model: "gpt-5.2-codex",
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "gpt-5.2-codex",
            reasoning_effort: "medium",
            developer_instructions: CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
          },
        },
      },
      undefined,
    );
  });

  it("rejects empty turn input", async () => {
    const { manager } = createSendTurnHarness();

    await expect(
      manager.sendTurn({
        threadId: asThreadId("thread_1"),
      }),
    ).rejects.toThrow("Turn input must include text or attachments.");
  });
});
