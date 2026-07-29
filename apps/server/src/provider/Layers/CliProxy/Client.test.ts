import { describe, expect, it, vi } from "vitest";

import { decodeModels, inspectCliProxy, validateCliProxyModel } from "./Client.ts";
import type { CliProxyConfig } from "./config.ts";

const config: CliProxyConfig = {
  baseUrl: new URL("http://127.0.0.1:8317"),
  apiKey: "secret",
  configPath: "/tmp/config.yaml",
};

describe("decodeModels", () => {
  it("decodes client-visible catalog models using their slugs", () => {
    expect(
      decodeModels({
        models: [
          { slug: "gpt-visible", display_name: "GPT Visible", visibility: "list" },
          { slug: "gpt-hide", display_name: "GPT Hide", visibility: "hide" },
          { slug: "gpt-hidden", display_name: "GPT Hidden", visibility: "hidden" },
          { slug: "gpt-visible", display_name: "Duplicate", visibility: "list" },
        ],
      }),
    ).toEqual([{ id: "gpt-visible", name: "GPT Visible" }]);
  });

  it("preserves compatible ids, naming fallbacks, and deduplication", () => {
    expect(
      decodeModels({
        data: [
          { id: "openai-display", display_name: "OpenAI Display" },
          { id: "openai-name", name: "OpenAI Name" },
          { id: "openai-id" },
          { id: "openai-id", name: "Duplicate" },
        ],
      }),
    ).toEqual([
      { id: "openai-display", name: "OpenAI Display" },
      { id: "openai-name", name: "OpenAI Name" },
      { id: "openai-id", name: "openai-id" },
    ]);
  });

  it("rejects response shapes that are not a client-profile catalog", () => {
    expect(() => decodeModels({ values: [] })).toThrowError(
      expect.objectContaining({ _tag: "CatalogMalformed" }),
    );
    expect(() => decodeModels({ models: [{ display_name: "missing id" }] })).toThrowError(
      expect.objectContaining({ _tag: "CatalogMalformed" }),
    );
  });
});

describe("inspectCliProxy", () => {
  it("uses the bounded client-profile endpoints through an injectable request", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response("CLI Proxy API Server"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "gpt-5-codex" }] }), {
          headers: { "content-type": "application/json" },
        }),
      );

    await expect(inspectCliProxy(config, { request })).resolves.toEqual([
      { id: "gpt-5-codex", name: "gpt-5-codex" },
    ]);
    expect(request.mock.calls.map((call) => call[1])).toEqual([
      "/",
      "/v1/models?client_version=0.1.0",
    ]);
  });

  it("classifies health and catalog failures", async () => {
    await expect(
      inspectCliProxy(config, { request: async () => new Response("wrong product") }),
    ).rejects.toMatchObject({ _tag: "HealthProbeFailed" });

    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response("CLI Proxy API Server"))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(inspectCliProxy(config, { request })).rejects.toMatchObject({
      _tag: "CatalogRequestFailed",
    });
  });
});

describe("validateCliProxyModel", () => {
  it("rejects a stale model with the live catalog in the typed error", () => {
    expect(() => validateCliProxyModel([{ id: "gpt-5", name: "GPT-5" }], "missing")).toThrowError(
      expect.objectContaining({
        _tag: "ModelUnavailable",
        requestedModel: "missing",
        availableModels: ["gpt-5"],
        message: expect.stringContaining("Available models: gpt-5"),
      }),
    );
  });
});
