import type { OpencodeClient, Provider } from "@opencode-ai/sdk/v2";
import { describe, expect, it } from "vitest";

import {
  formatManagedServerSdkError,
  listConnectedManagedServerProviders,
} from "./managedServerProviderDiscovery.ts";

function provider(id: string, modelIDs: ReadonlyArray<string> = []): Provider {
  return {
    id,
    name: id,
    env: [],
    options: {},
    models: Object.fromEntries(modelIDs.map((modelID) => [modelID, { id: modelID }])),
  } as unknown as Provider;
}

function clientWithProviderList(
  all: ReadonlyArray<Provider>,
  connected: ReadonlyArray<string>,
): OpencodeClient {
  return {
    provider: {
      list: async () => ({ data: { all, connected, default: {} } }),
    },
    config: {
      providers: async () => {
        throw new Error("config fallback should not be used");
      },
    },
  } as unknown as OpencodeClient;
}

describe("managed-server provider discovery", () => {
  it("formats structured SDK errors without collapsing to object string", () => {
    expect(
      formatManagedServerSdkError({
        _tag: "BadRequest",
        data: { message: "provider config is invalid" },
      }),
    ).toBe("provider config is invalid");

    expect(formatManagedServerSdkError({ code: "boom" })).toBe('{"code":"boom"}');
  });

  it("returns only connected providers in connected order with every model", async () => {
    const anthropic = provider("anthropic", ["claude-sonnet"]);
    const openai = provider("openai", ["gpt-5", "gpt-5-mini", "gpt-5-nano"]);
    const unconnected = provider("unconnected", ["hidden-model"]);
    const client = clientWithProviderList(
      [anthropic, unconnected, openai],
      ["openai", "anthropic"],
    );

    await expect(listConnectedManagedServerProviders(client)).resolves.toEqual([openai, anthropic]);
    const discovered = await listConnectedManagedServerProviders(client);
    expect(Object.keys(discovered[0]?.models ?? {})).toEqual(["gpt-5", "gpt-5-mini", "gpt-5-nano"]);
  });

  it("ignores unknown connected IDs", async () => {
    const openai = provider("openai", ["gpt-5"]);
    const client = clientWithProviderList([openai], ["missing", "openai"]);

    await expect(listConnectedManagedServerProviders(client)).resolves.toEqual([openai]);
  });

  it("returns no providers when none are connected", async () => {
    const client = clientWithProviderList([provider("openai", ["gpt-5"])], []);

    await expect(listConnectedManagedServerProviders(client)).resolves.toEqual([]);
  });

  it("falls back to config.providers for older managed servers", async () => {
    const openai = provider("openai", ["gpt-5"]);
    const client = {
      provider: {
        list: async () => ({ error: { data: { message: "provider endpoint unavailable" } } }),
      },
      config: {
        providers: async () => ({ data: { providers: [openai], default: {} } }),
      },
    } as unknown as OpencodeClient;

    await expect(listConnectedManagedServerProviders(client)).resolves.toEqual([openai]);
  });

  it("includes both errors when provider listing and fallback fail", async () => {
    const client = {
      provider: {
        list: async () => ({ error: { data: { message: "provider endpoint failed" } } }),
      },
      config: {
        providers: async () => ({ error: { data: { message: "config endpoint failed" } } }),
      },
    } as unknown as OpencodeClient;

    await expect(listConnectedManagedServerProviders(client)).rejects.toThrow(
      "Failed to list OpenCode providers: provider endpoint failed; config fallback failed: config endpoint failed",
    );
  });
});
