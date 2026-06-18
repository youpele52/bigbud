import fs from "node:fs";
import path from "node:path";

import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  asMessageId,
  asTurnId,
  createHarness,
  makeTrackedTempDir,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

describe("ProviderCommandReactor", () => {
  registerProviderCommandReactorTestCleanup();

  it("expands compact agent mentions for provider input while keeping stored user text compact", async () => {
    const baseDir = makeTrackedTempDir("bigbud-reactor-agent-");
    const agentDir = path.join(baseDir, ".codex", "agents");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "clarifier.md"),
      [
        "---",
        "name: clarifier",
        "description: Ask focused clarifying questions before acting.",
        "---",
        "Always identify ambiguity, then ask the smallest useful follow-up question.",
      ].join("\n"),
      "utf8",
    );
    const harness = await createHarness({ baseDir });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-agent-expand"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-agent-expand"),
          role: "user",
          text: "Use @agent::clarifier to inspect this issue",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    const sendInput = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(sendInput?.input).toContain("Original user message:");
    expect(sendInput?.input).toContain("Use @agent::clarifier to inspect this issue");
    expect(sendInput?.input).toContain("Referenced agent: clarifier");
    expect(sendInput?.input).toContain("No discovered agent matched this name.");

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.messages.at(-1)?.text).toBe("Use @agent::clarifier to inspect this issue");
  });

  it("expands /skills handoff for provider input while keeping the slash command visible", async () => {
    const baseDir = makeTrackedTempDir("bigbud-reactor-slash-skill-");
    const skillDir = path.join(baseDir, ".bigbud", "skills", "handoff");
    const skillPath = path.join(skillDir, "SKILL.md");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      skillPath,
      [
        "---",
        "name: handoff",
        "description: Compact the current conversation into a handoff document.",
        "---",
        "Write a handoff document for the next agent.",
      ].join("\n"),
      "utf8",
    );
    const harness = await createHarness({
      baseDir,
      discoveryCatalog: {
        agents: [],
        skills: [
          {
            id: "bigbud:skill:handoff",
            provider: "bigbud",
            name: "handoff",
            source: "system",
            description: "Compact the current conversation into a handoff document.",
            sourcePath: skillPath,
          },
        ],
      },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-slash-skill-expand"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-slash-skill-expand"),
          role: "user",
          text: "/skills handoff",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    const sendInput = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(sendInput?.input).toContain("Original user message:");
    expect(sendInput?.input).toContain("/skills handoff");
    expect(sendInput?.input).toContain("Referenced skill: handoff");
    expect(sendInput?.input).toContain("Provider: bigbud");
    expect(sendInput?.input).toContain("Write a handoff document for the next agent.");

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.messages.at(-1)?.text).toBe("/skills handoff");
  });

  it("injects teach runtime context with default chat folder paths", async () => {
    const baseDir = makeTrackedTempDir("bigbud-reactor-teach-expand-");
    const defaultChatCwd = path.join(baseDir, "Documents");
    fs.mkdirSync(defaultChatCwd, { recursive: true });
    const skillDir = path.join(baseDir, ".bigbud", "skills", "teach");
    const skillPath = path.join(skillDir, "SKILL.md");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      skillPath,
      [
        "---",
        "name: teach",
        "description: Structured multi-session learning.",
        "---",
        "Guide the user through a learning project.",
      ].join("\n"),
      "utf8",
    );
    const harness = await createHarness({
      baseDir,
      workspaceRoot: defaultChatCwd,
      serverSettingsOverrides: { defaultChatCwd },
      discoveryCatalog: {
        agents: [],
        skills: [
          {
            id: "bigbud:skill:teach",
            provider: "bigbud",
            name: "teach",
            source: "system",
            description: "Structured multi-session learning.",
            sourcePath: skillPath,
          },
        ],
      },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-teach-expand"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-teach-expand"),
          role: "user",
          text: "/skills teach budgeting",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    const sendInput = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(sendInput?.input).toContain("bigbud teach runtime context");
    expect(sendInput?.input).toContain(`Default chat folder: ${defaultChatCwd}`);
    expect(sendInput?.input).toContain(path.join(defaultChatCwd, "bigbud-learn"));
    expect(sendInput?.input).toContain("Active learning project folder for this turn");
    expect(sendInput?.input).toContain(path.join(defaultChatCwd, "bigbud-learn", "budgeting"));
    expect(sendInput?.input).toContain("That folder is NOT a learning project");
    expect(fs.existsSync(path.join(defaultChatCwd, "bigbud-learn", "budgeting"))).toBe(true);
  });

  it("prefers bigbud skills over same-named provider skills", async () => {
    const baseDir = makeTrackedTempDir("bigbud-reactor-bigbud-priority-");
    const bundledSkillDir = path.join(baseDir, ".bigbud", "skills", "handoff");
    const bundledSkillPath = path.join(bundledSkillDir, "SKILL.md");
    const opencodeSkillDir = path.join(baseDir, ".opencode", "skills", "handoff");
    const opencodeSkillPath = path.join(opencodeSkillDir, "SKILL.md");
    fs.mkdirSync(bundledSkillDir, { recursive: true });
    fs.mkdirSync(opencodeSkillDir, { recursive: true });
    fs.writeFileSync(
      bundledSkillPath,
      [
        "---",
        "name: handoff",
        "description: bigbud handoff",
        "---",
        "Emit the handoff summary directly in the thread.",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      opencodeSkillPath,
      [
        "---",
        "name: handoff",
        "description: opencode handoff",
        "---",
        "Write the handoff to a temp file.",
      ].join("\n"),
      "utf8",
    );
    const harness = await createHarness({
      baseDir,
      threadModelSelection: {
        provider: "opencode",
        model: "gpt-5-codex",
      },
      discoveryCatalog: {
        agents: [],
        skills: [
          {
            id: "opencode:skill:handoff",
            provider: "opencode",
            name: "handoff",
            source: "user",
            description: "opencode handoff",
            sourcePath: opencodeSkillPath,
          },
          {
            id: "bigbud:skill:handoff",
            provider: "bigbud",
            name: "handoff",
            source: "system",
            description: "bigbud handoff",
            sourcePath: bundledSkillPath,
          },
        ],
      },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-bigbud-priority"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-bigbud-priority"),
          role: "user",
          text: "@skill::handoff",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    const sendInput = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(sendInput?.input).toContain("Referenced skill: handoff");
    expect(sendInput?.input).toContain("Provider: bigbud");
    expect(sendInput?.input).toContain("Emit the handoff summary directly in the thread.");
    expect(sendInput?.input).not.toContain("Write the handoff to a temp file.");
  });

  it("expands referenced workspace files for provider input", async () => {
    const baseDir = makeTrackedTempDir("bigbud-reactor-path-");
    const srcDir = path.join(baseDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "demo.ts"), "export const demo = 42;\n", "utf8");
    const harness = await createHarness({ baseDir, workspaceRoot: baseDir });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-path-expand"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-path-expand"),
          role: "user",
          text: "Check @src/demo.ts before changing it",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    const sendInput = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(sendInput?.input).toContain("Referenced file: src/demo.ts");
    expect(sendInput?.input).toContain("File contents:");
    expect(sendInput?.input).toContain("export const demo = 42;");

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.messages.at(-1)?.text).toBe("Check @src/demo.ts before changing it");
  });

  it("rebuilds transcript context on the next turn when the provider session was lost", async () => {
    const harness = await createHarness();
    const firstTurnAt = new Date().toISOString();
    const secondTurnAt = new Date(Date.now() + 1000).toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-bootstrap-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-bootstrap-1"),
          role: "user",
          text: "first question",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: firstTurnAt,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.makeUnsafe("cmd-assistant-bootstrap-1-delta"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("assistant-message-bootstrap-1"),
        turnId: asTurnId("turn-1"),
        delta: "first answer",
        createdAt: new Date(Date.now() + 400).toISOString(),
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.makeUnsafe("cmd-assistant-bootstrap-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        messageId: asMessageId("assistant-message-bootstrap-1"),
        turnId: asTurnId("turn-1"),
        createdAt: new Date(Date.now() + 500).toISOString(),
      }),
    );

    await Effect.runPromise(harness.stopSession({ threadId: ThreadId.makeUnsafe("thread-1") }));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-bootstrap-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-bootstrap-2"),
          role: "user",
          text: "second question",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: secondTurnAt,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    const secondSendInput = harness.sendTurn.mock.calls[1]?.[0] as { input?: string } | undefined;
    expect(secondSendInput?.input).toContain("Transcript context:");
    expect(secondSendInput?.input).toContain("USER:\nfirst question");
    expect(secondSendInput?.input).toContain("ASSISTANT:\nfirst answer");
    expect(secondSendInput?.input).toContain(
      "Latest user request (answer this now):\nsecond question",
    );
  });
});
