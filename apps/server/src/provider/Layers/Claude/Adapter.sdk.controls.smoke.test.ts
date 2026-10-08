import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const controlSmoke = process.env.BIGBUD_CLAUDE_SDK_CONTROL_SMOKE === "1" ? it : it.skip;

describe("Claude SDK no-prompt control smoke", () => {
  controlSmoke(
    "initializes, interrupts, closes and rejects re-handshake of a closed query",
    async () => {
      const cwd = await mkdtemp(join(tmpdir(), "bigbud-claude-controls-"));
      const configDir = join(cwd, "config");
      await mkdir(configDir);
      let finishPrompt!: () => void;
      const ended = new Promise<void>((resolve) => {
        finishPrompt = resolve;
      });
      let delivered = 0;
      const prompt: AsyncIterable<SDKUserMessage> = {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            await ended;
            return { done: true, value: undefined };
          },
        }),
      };
      const runtime = query({
        prompt,
        options: {
          cwd,
          settingSources: [],
          permissionMode: "default",
          ...(process.env.BIGBUD_CLAUDE_SDK_CONTROL_BINARY
            ? {
                pathToClaudeCodeExecutable: process.env.BIGBUD_CLAUDE_SDK_CONTROL_BINARY,
              }
            : {}),
          tools: [],
          allowedTools: [],
          persistSession: false,
          env: {
            ...process.env,
            CLAUDE_CONFIG_DIR: configDir,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          },
        },
      });
      const iterator = runtime[Symbol.asyncIterator]();
      const streamEnd = (async () => {
        try {
          for (;;) {
            const next = await iterator.next();
            if (next.done) return;
            if (next.value.type === "user") delivered += 1;
            expect(next.value.type).not.toBe("assistant");
            expect(next.value.type).not.toBe("result");
          }
        } catch (cause) {
          // Closing an in-flight read may abort it or finish it normally.
          if (!(cause instanceof Error && /abort|closed/i.test(cause.message))) throw cause;
        }
      })();
      try {
        const initialization = await runtime.initializationResult();
        expect(Array.isArray(initialization.models)).toBe(true);
        await runtime.interrupt();
        runtime.close();
        finishPrompt();
        await streamEnd;
        expect(delivered).toBe(0);
        await expect(runtime.reinitialize()).rejects.toThrow();
        expect((await iterator.next()).done).toBe(true);
      } finally {
        runtime.close();
        finishPrompt();
        await streamEnd.catch(() => undefined);
        await rm(cwd, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
