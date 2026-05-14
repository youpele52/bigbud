import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { generateOpencodeThreadTitleNative } from "./ProviderNativeThreadTitleGeneration.ts";

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
