import { beforeEach, describe, expect, it } from "vitest";
import {
  recordModelUsage,
  getRecentlyUsedModels,
  clearRecentModels,
  getNewestRecentlyUsedModel,
  MAX_RECENT_MODELS_PER_PROVIDER,
  normalizeRecentlyUsedModels,
} from "./recentlyUsedModels";

beforeEach(() => {
  clearRecentModels();
});

describe("recordModelUsage", () => {
  it("stores a model usage entry", () => {
    recordModelUsage("codex", "gpt-5");
    const result = getRecentlyUsedModels("codex");
    expect(result).toHaveLength(1);
    expect(result[0]!.provider).toBe("codex");
    expect(result[0]!.model).toBe("gpt-5");
    expect(result[0]!.subProviderID).toBeUndefined();
  });

  it("stores subProviderID when provided", () => {
    recordModelUsage("opencode", "claude-sonnet-4-6", "anthropic");
    const result = getRecentlyUsedModels("opencode");
    expect(result).toHaveLength(1);
    expect(result[0]!.model).toBe("claude-sonnet-4-6");
    expect(result[0]!.subProviderID).toBe("anthropic");
  });

  it("deduplicates by moving existing entry to top", () => {
    recordModelUsage("codex", "gpt-5");
    recordModelUsage("codex", "gpt-4o");
    recordModelUsage("codex", "gpt-5");

    const result = getRecentlyUsedModels("codex");
    expect(result).toHaveLength(2);
    expect(result[0]!.model).toBe("gpt-5");
    expect(result[1]!.model).toBe("gpt-4o");
  });

  it("caps at MAX_RECENT_MODELS_PER_PROVIDER per provider", () => {
    for (let i = 0; i < MAX_RECENT_MODELS_PER_PROVIDER + 3; i++) {
      recordModelUsage("codex", `model-${i}`);
    }

    const result = getRecentlyUsedModels("codex");
    expect(result).toHaveLength(MAX_RECENT_MODELS_PER_PROVIDER);
    expect(result[0]!.model).toBe(`model-${MAX_RECENT_MODELS_PER_PROVIDER + 2}`);
  });

  it("tracks providers independently", () => {
    recordModelUsage("codex", "gpt-5");
    recordModelUsage("claudeAgent", "claude-sonnet-4-6");

    expect(getRecentlyUsedModels("codex")).toHaveLength(1);
    expect(getRecentlyUsedModels("claudeAgent")).toHaveLength(1);
    expect(getRecentlyUsedModels("copilot")).toHaveLength(0);
  });
});

describe("getRecentlyUsedModels", () => {
  it("selects the globally newest valid usage across providers", () => {
    expect(
      getNewestRecentlyUsedModel([
        { provider: "codex", model: "gpt-5", lastUsedAt: "2026-08-15T10:00:00.000Z" },
        {
          provider: "claudeAgent",
          model: "claude-sonnet-4-6",
          lastUsedAt: "2026-08-15T11:00:00.000Z",
        },
        { provider: "copilot", model: "gpt-5", lastUsedAt: "not-a-date" },
      ]),
    ).toEqual({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      lastUsedAt: "2026-08-15T11:00:00.000Z",
    });
  });

  it("returns entries sorted by lastUsedAt descending", () => {
    recordModelUsage("codex", "gpt-5");
    recordModelUsage("codex", "gpt-4o");
    recordModelUsage("codex", "gpt-4.1");

    const result = getRecentlyUsedModels("codex");
    expect(result[0]!.model).toBe("gpt-4.1");
    expect(result[1]!.model).toBe("gpt-4o");
    expect(result[2]!.model).toBe("gpt-5");
  });

  it("repairs stale and malformed entries without losing valid models", () => {
    const result = normalizeRecentlyUsedModels([
      { provider: "codex", model: "gpt-5", lastUsedAt: "2026-07-22T00:00:00.000Z" },
      { provider: "cliProxy", model: "gpt-5.6", lastUsedAt: "2026-07-22T01:00:00.000Z" },
      {
        provider: "opencode",
        model: "claude",
        subProviderID: "anthropic",
        lastUsedAt: "2026-07-22T02:00:00.000Z",
      },
      { provider: "codex", model: 42, lastUsedAt: "2026-07-22T03:00:00.000Z" },
      {
        provider: "codex",
        model: "gpt-4.1",
        subProviderID: "legacy",
        lastUsedAt: "2026-07-22T04:00:00.000Z",
      },
    ]);

    expect(result).toEqual({
      changed: true,
      entries: [
        { provider: "codex", model: "gpt-5", lastUsedAt: "2026-07-22T00:00:00.000Z" },
        {
          provider: "cliProxy",
          model: "gpt-5.6",
          lastUsedAt: "2026-07-22T01:00:00.000Z",
        },
        {
          provider: "opencode",
          model: "claude",
          subProviderID: "anthropic",
          lastUsedAt: "2026-07-22T02:00:00.000Z",
        },
        { provider: "codex", model: "gpt-4.1", lastUsedAt: "2026-07-22T04:00:00.000Z" },
      ],
    });
  });

  it("normalizes model slugs without dropping valid entries", () => {
    const result = normalizeRecentlyUsedModels([
      {
        provider: "cliProxy",
        model: "  catalog-model  ",
        lastUsedAt: "2026-07-22T00:00:00.000Z",
      },
      { provider: "codex", model: "   ", lastUsedAt: "2026-07-22T01:00:00.000Z" },
      { provider: "codex", model: "gpt-5.4", lastUsedAt: "2026-07-22T02:00:00.000Z" },
    ]);

    expect(result.entries).toEqual([
      {
        provider: "cliProxy",
        model: "catalog-model",
        lastUsedAt: "2026-07-22T00:00:00.000Z",
      },
      { provider: "codex", model: "gpt-5.4", lastUsedAt: "2026-07-22T02:00:00.000Z" },
    ]);
    expect(result.changed).toBe(true);
  });

  it("returns empty array for provider with no usage", () => {
    expect(getRecentlyUsedModels("copilot")).toEqual([]);
  });
});

describe("clearRecentModels", () => {
  it("clears all recent models", () => {
    recordModelUsage("codex", "gpt-5");
    recordModelUsage("claudeAgent", "claude-sonnet-4-6");

    clearRecentModels();

    expect(getRecentlyUsedModels("codex")).toEqual([]);
    expect(getRecentlyUsedModels("claudeAgent")).toEqual([]);
  });
});
