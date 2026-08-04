import { ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { applyClaudeRuntimeTraits } from "./Adapter.session.traits.ts";
import type { ClaudeSessionContext } from "./Adapter.types.ts";
import { resolveClaudeModelDiscovery } from "./Provider.capabilities.ts";

describe("applyClaudeRuntimeTraits effort validation", () => {
  it("applies advertised future effort and never forwards arbitrary or legacy values", async () => {
    resolveClaudeModelDiscovery({
      durationMs: 1,
      models: [
        {
          value: "claude-future",
          displayName: "Claude Future",
          description: "Future model",
          supportsEffort: true,
          supportedEffortLevels: ["high", "future-depth"],
        },
      ],
    });
    const applyFlagSettings = vi.fn(
      async (_settings: Parameters<ClaudeSessionContext["query"]["applyFlagSettings"]>[0]) =>
        undefined,
    );
    const context = {
      query: { applyFlagSettings },
      currentEffort: undefined,
      currentFastMode: false,
      currentThinking: undefined,
      currentUltracode: false,
    } as unknown as ClaudeSessionContext;
    const threadId = ThreadId.makeUnsafe("claude-future-effort");
    const applyEffort = (effort: string) =>
      Effect.runPromise(
        applyClaudeRuntimeTraits({
          context,
          threadId,
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-future",
            options: { effort },
          },
        }),
      );

    await applyEffort("future-depth");
    await applyEffort("not-advertised");
    await applyEffort("ultrathink");

    expect(applyFlagSettings.mock.calls.map(([settings]) => settings)).toEqual([
      { effortLevel: "future-depth" },
      { effortLevel: "high" },
      { effortLevel: null },
    ]);
    expect(applyFlagSettings.mock.calls.flat()).not.toContainEqual(
      expect.objectContaining({ effortLevel: "not-advertised" }),
    );
    expect(applyFlagSettings.mock.calls.flat()).not.toContainEqual(
      expect.objectContaining({ effortLevel: "ultrathink" }),
    );
  });
});
