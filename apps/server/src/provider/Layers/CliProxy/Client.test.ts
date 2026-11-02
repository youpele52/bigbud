import { describe, expect, it, vi } from "vitest";

import { decodeModels, inspectCliProxy, validateCliProxyModel } from "./Client.ts";
import type { CliProxyConfig } from "./config.ts";

const config: CliProxyConfig = {
  baseUrl: new URL("http://127.0.0.1:8317"),
  apiKey: "secret",
  configPath: "/tmp/config.yaml",
};

describe("decodeModels", () => {
  it.each([
    ["gpt-6-astra", "GPT 6.0 Astra", "GPT 6 Astra"],
    ["gpt-6-sol", "GPT 6.0 Sol", "GPT 6 Sol"],
    ["gpt-6-luna", "GPT 6.0 Luna", "GPT 6 Luna"],
    ["gpt-6.1-sol", "GPT 6.1 Sol", "GPT 6.1 Sol"],
    ["gpt-5.6-luna", "GPT 5.6 Luna", "GPT 5.6 Luna"],
    ["gpt-6.0-custom", "GPT 6.0 Custom", "GPT 6 Custom"],
    ["custom", "Custom 6.0", "Custom 6.0"],
  ])("normalizes display name %s without changing the wire id", (id, name, expected) => {
    expect(decodeModels({ models: [{ slug: id, display_name: name }] })).toEqual([
      { id, name: expected },
    ]);
    expect(decodeModels({ data: [{ id, name }] })).toEqual([{ id, name: expected }]);
  });

  it("preserves only live effort levels supported by the Claude transport", () => {
    const [model] = decodeModels({
      models: [
        {
          slug: "arbitrary-proxy-model",
          supported_reasoning_levels: [
            { effort: "none" },
            { effort: "low" },
            { effort: "xhigh" },
            { effort: "xhigh" },
            { effort: "future-depth" },
          ],
          default_reasoning_level: "xhigh",
        },
      ],
    });
    expect(model?.capabilities?.reasoningEffortLevels).toEqual([
      { value: "low", label: "Low" },
      { value: "xhigh", label: "Extra High", isDefault: true },
    ]);
    expect(model?.capabilities?.effortMetadataOrigin).toBe("live");
  });

  it("never invents effort for missing or malformed metadata", () => {
    for (const levels of [undefined, null, "high", [{ effort: 1 }], [null]]) {
      const [model] = decodeModels({
        data: [{ id: "gpt-6.1-sol", supported_reasoning_levels: levels }],
      });
      expect(model?.capabilities).toBeUndefined();
    }
    const [unsupported] = decodeModels({
      data: [{ id: "no-effort", supported_reasoning_levels: [] }],
    });
    expect(unsupported?.capabilities?.reasoningEffortLevels).toEqual([]);
    expect(unsupported?.capabilities?.effortMetadataStatus).toBe("verified-unsupported");
  });

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

    await expect(
      inspectCliProxy(config, {
        request: async () => new Response("unauthorized", { status: 401 }),
      }),
    ).rejects.toMatchObject({ _tag: "AuthenticationFailed" });

    const malformedRequest = vi
      .fn()
      .mockResolvedValueOnce(new Response("CLI Proxy API Server"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ models: [{ name: "missing id" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    await expect(inspectCliProxy(config, { request: malformedRequest })).rejects.toMatchObject({
      _tag: "CatalogMalformed",
    });
  });

  it("coalesces concurrent inspections for the same config", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = vi.fn(async (_config: CliProxyConfig, pathname: string) => {
      if (pathname === "/") await gate;
      return pathname === "/"
        ? new Response("CLI Proxy API Server")
        : new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }));
    });
    const first = inspectCliProxy(config, { request });
    const second = inspectCliProxy(config, { request });
    release?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      [{ id: "gpt-5", name: "gpt-5" }],
      [{ id: "gpt-5", name: "gpt-5" }],
    ]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("isolates concurrent flights with different credentials", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = vi.fn(async (_config: CliProxyConfig, pathname: string) => {
      if (pathname === "/") await gate;
      return pathname === "/"
        ? new Response("CLI Proxy API Server")
        : new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }));
    });
    const first = inspectCliProxy(config, { request });
    const second = inspectCliProxy({ ...config, apiKey: "other-secret" }, { request });
    release?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      [{ id: "gpt-5", name: "gpt-5" }],
      [{ id: "gpt-5", name: "gpt-5" }],
    ]);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("clears a rejected inspection flight before the next inspection", async () => {
    const request = vi.fn(async () => new Response("wrong product"));

    await expect(inspectCliProxy(config, { request })).rejects.toMatchObject({
      _tag: "HealthProbeFailed",
    });
    await expect(inspectCliProxy(config, { request })).rejects.toMatchObject({
      _tag: "HealthProbeFailed",
    });
    expect(request).toHaveBeenCalledTimes(2);
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
