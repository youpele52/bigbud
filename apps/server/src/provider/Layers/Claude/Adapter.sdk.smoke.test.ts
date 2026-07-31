import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

const smokeTest = process.env.BIGBUD_CLAUDE_SDK_SMOKE === "1" ? it : it.skip;

async function* smokePrompt(): AsyncIterable<SDKUserMessage> {
  yield {
    type: "user",
    message: {
      role: "user",
      content: "Reply with exactly OK. Do not use tools or modify files.",
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
  };
}

describe("Claude Agent SDK smoke", () => {
  smokeTest(
    "initializes and completes an inert streamed prompt",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "bigbud-claude-sdk-smoke-"));
      const readmePath = join(cwd, "README.md");
      await writeFile(readmePath, "Read-only Claude Agent SDK smoke workspace.\n", "utf8");
      await chmod(readmePath, 0o444);
      await chmod(cwd, 0o555);

      const runtime = query({
        prompt: smokePrompt(),
        options: {
          cwd,
          permissionMode: "plan",
          tools: [],
          allowedTools: [],
          maxTurns: 1,
          maxBudgetUsd: 0.05,
          includePartialMessages: true,
        },
      });

      const messages: SDKMessage[] = [];
      try {
        const initialization = await runtime.initializationResult();
        expect(Array.isArray(initialization.models)).toBe(true);
        expect(Array.isArray(initialization.commands)).toBe(true);

        for await (const message of runtime) {
          messages.push(message);
        }

        expect(messages.some((message) => message.type === "result")).toBe(true);
      } finally {
        runtime.close();
        await chmod(cwd, 0o755);
        await rm(cwd, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
