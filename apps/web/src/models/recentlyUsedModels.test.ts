import { beforeEach, describe, expect, it } from "vitest";
import {
  recordModelUsage,
  getRecentlyUsedModels,
  clearRecentModels,
  MAX_RECENT_MODELS_PER_PROVIDER,
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
  it("returns entries sorted by lastUsedAt descending", () => {
    recordModelUsage("codex", "gpt-5");
    recordModelUsage("codex", "gpt-4o");
    recordModelUsage("codex", "gpt-4.1");

    const result = getRecentlyUsedModels("codex");
    expect(result[0]!.model).toBe("gpt-4.1");
    expect(result[1]!.model).toBe("gpt-4o");
    expect(result[2]!.model).toBe("gpt-5");
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
