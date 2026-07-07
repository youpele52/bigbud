import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  generateOpencodeThreadElevatorSummaryNative,
  generateOpencodeThreadTitleNative,
} from "./ProviderNativeThreadTitleGeneration.ts";

describe("generateOpencodeThreadTitleNative", () => {
  it("uses OpenCode direct prompt execution to produce a thread title", async () => {
    const create = vi.fn(async () => ({
      data: { id: "opencode-session-title-1" },
      error: undefined,
    }));
    const prompt = vi.fn(async () => ({
      data: {
        info: {
          id: "assistant-message-title-1",
          role: "assistant",
          structured: { title: "Count uncommitted files" },
          time: { created: Date.now(), completed: Date.now() },
        },
        parts: [
          {
            id: "text-part-title-1",
            type: "text",
            text: '{"title":"Count uncommitted files"}',
          },
        ],
      },
      error: undefined,
    }));
    const release = vi.fn();

    const result = await Effect.runPromise(
      generateOpencodeThreadTitleNative(
        {
          serverSettingsService: { getSettings: Effect.die("unused") } as never,
          opencodeServerManager: {
            acquire: async () =>
              ({
                client: {
                  session: {
                    create,
                    prompt,
                  },
                },
                url: "http://127.0.0.1:0",
                release,
              }) as never,
          },
        },
        {
          cwd: "/tmp/bigbud-project",
          message: "How many files are uncommitted in this project?",
          modelSelection: {
            provider: "opencode",
            model: "nemotron-3-super-free",
            subProviderID: "openrouter",
          },
        },
      ),
    );

    expect(create).toHaveBeenCalledWith({ title: "Thread title generation" });
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "opencode-session-title-1",
        model: {
          providerID: "openrouter",
          modelID: "nemotron-3-super-free",
        },
        noReply: false,
      }),
    );
    expect(result.title).toBe("Count uncommitted files");
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("generateOpencodeThreadElevatorSummaryNative", () => {
  it("uses OpenCode direct prompt execution to produce a thread elevator summary", async () => {
    const create = vi.fn(async () => ({
      data: { id: "opencode-session-summary-1" },
      error: undefined,
    }));
    const prompt = vi.fn(async () => ({
      data: {
        info: {
          id: "assistant-message-summary-1",
          role: "assistant",
          structured: {
            summary: "Debugs sidebar hover summaries for reactivated OpenCode threads",
          },
          time: { created: Date.now(), completed: Date.now() },
        },
        parts: [
          {
            id: "text-part-summary-1",
            type: "text",
            text: '{"summary":"Debugs sidebar hover summaries for reactivated OpenCode threads"}',
          },
        ],
      },
      error: undefined,
    }));
    const release = vi.fn();

    const result = await Effect.runPromise(
      generateOpencodeThreadElevatorSummaryNative(
        {
          serverSettingsService: { getSettings: Effect.die("unused") } as never,
          opencodeServerManager: {
            acquire: async () =>
              ({
                client: {
                  session: {
                    create,
                    prompt,
                  },
                },
                url: "http://127.0.0.1:0",
                release,
              }) as never,
          },
        },
        {
          cwd: "/tmp/bigbud-project",
          transcript: "USER:\nThe hover summary is not showing\n\nASSISTANT:\nTracing it",
          modelSelection: {
            provider: "opencode",
            model: "nemotron-3-super-free",
            subProviderID: "openrouter",
          },
        },
      ),
    );

    expect(create).toHaveBeenCalledWith({ title: "Thread elevator summary generation" });
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "opencode-session-summary-1",
        model: {
          providerID: "openrouter",
          modelID: "nemotron-3-super-free",
        },
        noReply: false,
      }),
    );
    expect(result.summary).toBe("Debugs sidebar hover summaries for reactivated OpenCode threads");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
