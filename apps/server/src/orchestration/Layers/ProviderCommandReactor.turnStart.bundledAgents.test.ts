import fs from "node:fs";
import path from "node:path";

import { CommandId, DEFAULT_PROVIDER_INTERACTION_MODE, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  asMessageId,
  createHarness,
  makeTrackedTempDir,
  registerProviderCommandReactorTestCleanup,
  waitFor,
} from "./ProviderCommandReactor.test.helpers.ts";

describe("ProviderCommandReactor — bundled agents", () => {
  registerProviderCommandReactorTestCleanup();

  it("expands bundled opencode agent mentions into provider input", async () => {
    const baseDir = makeTrackedTempDir("bigbud-reactor-bundled-agent-");
    const agentDir = path.join(baseDir, "bundled-agents");
    const agentPath = path.join(agentDir, "systematic-debugging-assistant.md");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      agentPath,
      [
        "---",
        "description: Systematic debugging assistant",
        "mode: subagent",
        "---",
        "",
        "Before writing code, understand the problem thoroughly.",
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
        agents: [
          {
            id: "opencode:agent:systematic-debugging-assistant",
            provider: "opencode",
            name: "systematic-debugging-assistant",
            source: "system",
            description: "Systematic debugging assistant",
            sourcePath: agentPath,
          },
        ],
        skills: [],
      },
    });
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-bundled-agent-expand"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("user-message-bundled-agent-expand"),
          role: "user",
          text: "Use @agent::systematic-debugging-assistant on this bug",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    const sendInput = harness.sendTurn.mock.calls[0]?.[0] as { input?: string } | undefined;
    expect(sendInput?.input).toContain("Referenced agent: systematic-debugging-assistant");
    expect(sendInput?.input).toContain("Provider: opencode");
    expect(sendInput?.input).toContain("Source: system");
    expect(sendInput?.input).toContain("Before writing code, understand the problem thoroughly.");
    expect(sendInput?.input).not.toContain("No discovered agent matched this name.");
  });
});
