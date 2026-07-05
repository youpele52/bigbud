import { describe, expect, it } from "vitest";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { formatOpencodeSdkError, listOpencodeProviders } from "./Provider.sdk.ts";

describe("OpenCode SDK provider helpers", () => {
  it("formats structured SDK errors without collapsing to object string", () => {
    expect(
      formatOpencodeSdkError({
        _tag: "BadRequest",
        data: { message: "provider config is invalid" },
      }),
    ).toBe("provider config is invalid");

    expect(formatOpencodeSdkError({ code: "boom" })).toBe('{"code":"boom"}');
  });

  it("uses provider.list records when available", async () => {
    const client = {
      provider: {
        list: async () => ({
          data: {
            all: [{ id: "anthropic", name: "Anthropic", env: [], options: {}, models: {} }],
            default: {},
            connected: [],
          },
        }),
      },
      config: {
        providers: async () => {
          throw new Error("config fallback should not be used");
        },
      },
    } as unknown as OpencodeClient;

    await expect(listOpencodeProviders(client)).resolves.toEqual([
      { id: "anthropic", name: "Anthropic", env: [], options: {}, models: {} },
    ]);
  });

  it("falls back to config.providers for older OpenCode servers", async () => {
    const client = {
      provider: {
        list: async () => ({
          error: { data: { message: "provider endpoint unavailable" } },
        }),
      },
      config: {
        providers: async () => ({
          data: {
            providers: [{ id: "openai", name: "OpenAI", env: [], options: {}, models: {} }],
            default: {},
          },
        }),
      },
    } as unknown as OpencodeClient;

    await expect(listOpencodeProviders(client)).resolves.toEqual([
      { id: "openai", name: "OpenAI", env: [], options: {}, models: {} },
    ]);
  });

  it("includes both errors when provider listing and fallback fail", async () => {
    const client = {
      provider: {
        list: async () => ({
          error: { data: { message: "provider endpoint failed" } },
        }),
      },
      config: {
        providers: async () => ({
          error: { data: { message: "config endpoint failed" } },
        }),
      },
    } as unknown as OpencodeClient;

    await expect(listOpencodeProviders(client)).rejects.toThrow(
      "Failed to list OpenCode providers: provider endpoint failed; config fallback failed: config endpoint failed",
    );
  });
});
