import { describe, expect, it, vi } from "vitest";

import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "./codexAppServerManager";
import { CODEX_DEFAULT_MODE_WITH_USER_INPUT_DEVELOPER_INSTRUCTIONS } from "./codexModeInstructions";
import { asThreadId, createSendTurnHarness } from "./codexAppServerManager.test.helpers";

vi.mock("./codexVersionCheck", () => ({
  assertSupportedCodexCliVersion: vi.fn(),
}));

describe("sendTurn", () => {
  it("sends text and image user input items to turn/start", async () => {
    const { manager, context, requireSession, sendRequest, updateSession } = createSendTurnHarness({
      activeModelCatalog: [
        {
          slug: "gpt-5.3-codex",
          name: "GPT-5.3 Codex",
          isCustom: false,
          capabilities: {
            reasoningEffortLevels: [{ value: "high", label: "High" }],
            supportsFastMode: true,
            supportsThinkingToggle: false,
            contextWindowOptions: [],
            promptInjectedEffortLevels: [],
          },
        },
      ],
    });

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
      model: "gpt-5.3-codex",
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
            developer_instructions: CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
          },
        },
      },
      undefined,
    );
  });

  it("lets Default mode ask through request_user_input on Codex versions that enable it", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();
    Object.assign(context, { runtimeVersion: "0.167.0" });

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Ship it",
      interactionMode: "default",
    });

    const params = sendRequest.mock.calls.at(-1)?.[2] as {
      collaborationMode?: { settings?: { developer_instructions?: string } };
    };
    expect(params.collaborationMode?.settings?.developer_instructions).toBe(
      CODEX_DEFAULT_MODE_WITH_USER_INPUT_DEVELOPER_INSTRUCTIONS,
    );
    // Codex 0.167 wording for the enabled tool, plus bigbud steering choices into the panel.
    expect(CODEX_DEFAULT_MODE_WITH_USER_INPUT_DEVELOPER_INSTRUCTIONS).toContain(
      "Use the `request_user_input` tool only when it is listed in the available tools for this turn.",
    );
    expect(CODEX_DEFAULT_MODE_WITH_USER_INPUT_DEVELOPER_INSTRUCTIONS).toContain(
      "use `request_user_input` instead of listing the choices in a message",
    );
    // Codex questions carry no multiSelect, so "select all that apply" can never be honoured.
    expect(CODEX_DEFAULT_MODE_WITH_USER_INPUT_DEVELOPER_INSTRUCTIONS).toContain(
      'Each `request_user_input` question is single-choice: never word it as "select all that apply"',
    );
    expect(CODEX_DEFAULT_MODE_WITH_USER_INPUT_DEVELOPER_INSTRUCTIONS).not.toContain("unavailable");
    // Cross-project confirmations must reach the question panel, never an assumed answer.
    expect(CODEX_DEFAULT_MODE_WITH_USER_INPUT_DEVELOPER_INSTRUCTIONS).toMatch(
      /`status: "confirmation_required"`\), always ask it with `request_user_input`[\s\S]*<\/collaboration_mode>$/,
    );
    // Upstream's bare "never for permission requests" would forbid asking those confirmations;
    // only Codex's own sandbox, command and file-change escalations are excluded.
    expect(CODEX_DEFAULT_MODE_WITH_USER_INPUT_DEVELOPER_INSTRUCTIONS).toContain(
      "Never use the `request_user_input` tool for sandbox, command-execution, or file-change permission escalations; Codex has its own approval flow for those.",
    );
    expect(CODEX_DEFAULT_MODE_WITH_USER_INPUT_DEVELOPER_INSTRUCTIONS).not.toContain(
      "for permission requests or permission-related escalations",
    );
    expect(CODEX_DEFAULT_MODE_WITH_USER_INPUT_DEVELOPER_INSTRUCTIONS).toContain(
      "or when a tool result asks for the user's confirmation (see below).",
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
