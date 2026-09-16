import type { OpencodeClient, Provider } from "@opencode-ai/sdk/v2";
import { describe, expect, it } from "vitest";

import { resolveProviderIDForModel } from "./Adapter.session.helpers.ts";

function provider(id: string, modelIDs: ReadonlyArray<string>): Provider {
  return {
    id,
    name: id,
    env: [],
    options: {},
    models: Object.fromEntries(modelIDs.map((modelID) => [modelID, { id: modelID }])),
  } as unknown as Provider;
}

function client(all: ReadonlyArray<Provider>, connected: ReadonlyArray<string>): OpencodeClient {
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

describe("resolveProviderIDForModel", () => {
  it("resolves a colliding model slug to the connected provider", async () => {
    const sdkClient = client(
      [provider("unconnected", ["shared-model"]), provider("openai", ["shared-model"])],
      ["openai"],
    );

    await expect(resolveProviderIDForModel(sdkClient, "shared-model")).resolves.toBe("openai");
  });

  it("does not resolve models that exist only on disconnected providers", async () => {
    const sdkClient = client(
      [provider("unconnected", ["hidden-model"]), provider("openai", ["gpt-5"])],
      ["openai"],
    );

    await expect(resolveProviderIDForModel(sdkClient, "hidden-model")).resolves.toBeUndefined();
  });
});
