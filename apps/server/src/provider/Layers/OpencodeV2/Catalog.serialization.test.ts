import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/settings";
import { ServerConfig, ServerConfigStreamEvent } from "@bigbud/contracts/server/server";
import type { ServerProviderModel } from "@bigbud/contracts/server/server.providers.ts";
import type { ModelInfo } from "@opencode/client";
import { Schema } from "effect";
import { expect, it } from "vitest";

import {
  DEFAULT_KEYBINDINGS,
  compileResolvedKeybindingsConfig,
} from "../../../keybindings/keybindings";
import { normalizeV2Catalog } from "./Catalog.ts";
import { mergeV2Catalogs, normalizeV2PublicCatalog } from "./Catalog.public.ts";

function config(models: ReadonlyArray<ServerProviderModel>): ServerConfig {
  return {
    cwd: "/workspace",
    storage: { notesDir: "/notes", kanbanDir: "/kanban" },
    keybindingsConfigPath: "/keybindings.json",
    keybindings: compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS),
    issues: [],
    providers: [
      {
        provider: "opencodeV2",
        enabled: true,
        installed: true,
        version: "2.0.26",
        status: "warning",
        auth: { status: "unknown" },
        checkedAt: "2026-10-09T00:00:00.000Z",
        models,
        slashCommands: [],
        skills: [],
      },
    ],
    discovery: { agents: [], skills: [] },
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
  };
}

const nativeModel: ModelInfo = {
  id: "bytedance/ui-tars-1.5-7b",
  modelID: "bytedance/ui-tars-1.5-7b",
  providerID: "kilo",
  name: "ByteDance: UI-TARS 7B ",
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [],
  time: { released: 1 },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 1000, output: 100 },
};

it("normalizes upstream display whitespace before encoding config snapshots and shortcut bindings", () => {
  const publicModels = normalizeV2PublicCatalog({
    kilo: {
      id: "kilo",
      name: " KiloCode ",
      models: {
        uiTars: { id: nativeModel.id, name: nativeModel.name },
        deepseek: {
          id: "deepseek/deepseek-v3-turbo",
          name: "DeepSeek V3 (Turbo)\t",
          experimental: { modes: { fast: {} } },
        },
      },
    },
  });
  expect(publicModels.map(({ name }) => name)).toEqual([
    "ByteDance: UI-TARS 7B",
    "DeepSeek V3 (Turbo)",
    "DeepSeek V3 (Turbo) Fast",
  ]);
  const nativeModels = normalizeV2Catalog(
    { location: { directory: "/workspace" }, data: [nativeModel] },
    "/workspace",
  );
  expect(nativeModels[0]?.name).toBe("ByteDance: UI-TARS 7B");
  const snapshot = config(mergeV2Catalogs(publicModels, nativeModels, new Map()));
  const decoded = Schema.decodeUnknownSync(ServerConfig)(Schema.encodeSync(ServerConfig)(snapshot));
  expect(decoded.keybindingsConfigPath).toBe("/keybindings.json");
  expect(decoded.keybindings.some(({ command }) => command === "sidebar.toggle")).toBe(true);
  expect(() =>
    Schema.encodeSync(ServerConfigStreamEvent)({
      version: 1,
      type: "snapshot",
      config: snapshot,
    }),
  ).not.toThrow();
});

it("rejects whitespace-only public and native display names before publishing a provider snapshot", () => {
  expect(() =>
    normalizeV2PublicCatalog({
      kilo: { id: "kilo", name: "KiloCode", models: { bad: { id: "bad", name: " \t " } } },
    }),
  ).toThrow();
  expect(() =>
    normalizeV2Catalog(
      { location: { directory: "/workspace" }, data: [{ ...nativeModel, name: " \t " }] },
      "/workspace",
    ),
  ).toThrow();
});
