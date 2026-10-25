import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { migrateBundledCopilotConfig } from "./Layers/Copilot/ConfigMigration.ts";
import { migrateBundledPiConfig, migratePiConfig } from "./Layers/Pi/ConfigMigration.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "bigbud-provider-migration-"));
  roots.push(path);
  return path;
}

it("copies only Copilot settings, preserves destination preferences and legacy state, and runs once", async () => {
  const directory = await root();
  const legacy = JSON.stringify({
    model: "old",
    theme: "dark",
    allowedUrls: ["example.com"],
    oauth_token: "secret",
    trusted_folders: ["/"],
  });
  await writeFile(join(directory, "config.json"), legacy);
  const original = '{ // keep a byte-exact backup\n "model": "new", "allowedUrls": []\n}';
  await writeFile(join(directory, "settings.json"), original);
  await Promise.all(
    Array.from({ length: 3 }, () => migrateBundledCopilotConfig({ COPILOT_HOME: directory })),
  );
  expect(JSON.parse(await readFile(join(directory, "settings.json"), "utf8"))).toEqual({
    model: "new",
    theme: "dark",
    allowedUrls: [],
  });
  expect(await readFile(join(directory, "config.json"), "utf8")).toBe(legacy);
  const backup = (await readdir(directory)).find((name) => name.endsWith(".bak"))!;
  expect(await readFile(join(directory, backup), "utf8")).toBe(original);
  await writeFile(join(directory, "settings.json"), "{}");
  await migrateBundledCopilotConfig({ COPILOT_HOME: directory });
  expect(await readFile(join(directory, "settings.json"), "utf8")).toBe("{}");
});

it("backs up and migrates Pi auth, models and global/project model references idempotently", async () => {
  const directory = await root();
  const cwd = join(directory, "project");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const settings = {
    defaultProvider: "azure-openai-responses",
    enabledModels: ["azure-openai-responses/*", "other/*"],
    modelThinkingLevels: { "azure-openai-responses/gpt": "high", "azure/gpt": "low" },
  };
  await writeFile(
    join(directory, "auth.json"),
    JSON.stringify({ "azure-openai-responses": { key: "secret" } }),
  );
  await writeFile(join(directory, "settings.json"), JSON.stringify(settings));
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify(settings));
  await writeFile(
    join(directory, "models.json"),
    JSON.stringify({
      providers: {
        "azure-openai-responses": {
          models: [{ id: "gpt", compat: { sendSessionIdHeader: false } }],
        },
        "kimi-coding": { baseUrl: "https://api.kimi.com/coding" },
      },
    }),
  );
  await migrateBundledPiConfig({ PI_CODING_AGENT_DIR: directory }, cwd);
  const contents = await readFile(join(directory, "models.json"), "utf8");
  expect(JSON.parse(contents)).toMatchObject({
    providers: {
      azure: { models: [{ compat: { sessionAffinityFormat: "openai-nosession" } }] },
      "kimi-coding": { baseUrl: "https://api.kimi.com/coding/v1" },
    },
  });
  expect(JSON.parse(await readFile(join(directory, "auth.json"), "utf8"))).toEqual({
    azure: { key: "secret" },
  });
  expect(JSON.parse(await readFile(join(cwd, ".pi", "settings.json"), "utf8"))).toEqual({
    defaultProvider: "azure",
    enabledModels: ["azure/*", "other/*"],
    modelThinkingLevels: { "azure/gpt": "low" },
  });
  const files = await readdir(directory);
  await migrateBundledPiConfig({ PI_CODING_AGENT_DIR: directory }, cwd);
  expect(await readFile(join(directory, "models.json"), "utf8")).toBe(contents);
  expect(await readdir(directory)).toEqual(files);
});

it("retains explicit modern Pi destinations", () => {
  expect(
    migratePiConfig("auth", { azure: { key: "new" }, "azure-openai-responses": { key: "old" } }),
  ).toEqual({ azure: { key: "new" } });
  expect(
    migratePiConfig("models", {
      providers: {
        custom: { compat: { sendSessionIdHeader: false, sessionAffinityFormat: "openrouter" } },
      },
    }),
  ).toEqual({ providers: { custom: { compat: { sessionAffinityFormat: "openrouter" } } } });
});

it("refuses invalid or linked destination files without damaging the original", async () => {
  const directory = await root();
  await writeFile(join(directory, "config.json"), '{"theme":"dark"}');
  await writeFile(join(directory, "settings.json"), "invalid");
  await expect(migrateBundledCopilotConfig({ COPILOT_HOME: directory })).rejects.toThrow();
  expect(await readFile(join(directory, "settings.json"), "utf8")).toBe("invalid");
  await rm(join(directory, "settings.json"));
  await symlink(join(directory, "config.json"), join(directory, "settings.json"));
  await expect(migrateBundledCopilotConfig({ COPILOT_HOME: directory })).rejects.toThrow(
    "non-regular",
  );
});

it("preserves credential punctuation and JSONC quoted comment markers", async () => {
  const directory = await root();
  const credential = "token,}https://example.com/*secret*/";
  await writeFile(
    join(directory, "auth.json"),
    `{// comment\n"azure-openai-responses":{"key":${JSON.stringify(credential)},},}`,
  );
  await migrateBundledPiConfig({ PI_CODING_AGENT_DIR: directory });
  expect(JSON.parse(await readFile(join(directory, "auth.json"), "utf8"))).toEqual({
    azure: { key: credential },
  });
});

it("warns rather than guessing custom Kimi proxy URLs", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const original = { providers: { "kimi-coding": { baseUrl: "https://proxy.example/custom" } } };
    expect(migratePiConfig("models", original)).toEqual(original);
    expect(warn).toHaveBeenCalledOnce();
  } finally {
    warn.mockRestore();
  }
});

it("does not create provider configurations for unused providers", async () => {
  const directory = await root();
  await migrateBundledPiConfig({ PI_CODING_AGENT_DIR: join(directory, "missing-pi") });
  await migrateBundledCopilotConfig({ COPILOT_HOME: join(directory, "missing-copilot") });
  expect(await readdir(directory)).toEqual([]);
});
