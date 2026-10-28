import path from "node:path";
import { expect, it, vi } from "vitest";
import { v2UpgradeSources } from "./NativeCompatibility.upgrade.fixture.ts";
import {
  validateV2NativeConfigSources,
  projectV2NativeConfigSources,
} from "./NativeCompatibility.sources.ts";
import { inspectV2PluginControls } from "./PluginSetup.policy.ts";
import { v2ConfigSourcePaths } from "./NativeCompatibility.sources.platform.ts";

const files = vi.hoisted(() => ({ read: vi.fn(async (_filename: string) => undefined) }));
vi.mock("./PluginSetup.fs.ts", () => ({ readV2NativePluginFile: files.read }));

it("unattributed virtual controls carry policies, but neither virtuals nor split machine documents authorize raw reads/writes", async () => {
  const root = path.resolve("/fixture/global");
  const platform = { platform: process.platform, programData: process.env.ProgramData };
  const entries = v2UpgradeSources(root, "2.2.0", platform);
  const machine = validateV2NativeConfigSources(
    entries,
    root,
    "v2-system-global-config-v1",
    platform,
  );
  const projected = projectV2NativeConfigSources(entries);
  expect(
    projected.filter((entry) => entry.type === "document" && entry.info.policies),
  ).toHaveLength(process.platform === "darwin" ? 3 : 2);
  expect(JSON.stringify(projected)).not.toContain("DO-NOT-CARRY");
  const authority = { signal: new AbortController().signal, assertCurrent: () => {} };
  files.read.mockClear();
  await expect(
    inspectV2PluginControls(projected, root, authority, "/workspace", machine),
  ).resolves.toEqual([]);
  const read = files.read.mock.calls.map(([filename]) => filename);
  expect(read).toContain(path.join(root, "opencode.json"));
  expect(read).toContain(path.join(root, "opencode.jsonc"));
  for (const filename of machine) expect(read).not.toContain(filename);
  expect(
    read.some((filename) => filename.startsWith(v2ConfigSourcePaths(platform).systemRoot)),
  ).toBe(false);
  expect(read).toHaveLength(4); // only two owned global candidates + explicit/direct files
});

it("denied canonical policy blocks even raw user reads; permissions cannot override it", async () => {
  files.read.mockClear();
  await expect(
    inspectV2PluginControls(
      [
        {
          type: "document",
          info: {
            policies: [{ action: "tool.use", resource: "bigbud_thread_v1_*:*", effect: "deny" }],
            permissions: [{ action: "*", resource: "*", effect: "allow" }],
          },
        },
      ],
      "/fixture/global",
      { signal: new AbortController().signal, assertCurrent: () => {} },
      "/workspace",
    ),
  ).rejects.toMatchObject({ diagnostic: { code: "policy-denied" } });
  expect(files.read).not.toHaveBeenCalled();
  await expect(
    inspectV2PluginControls(
      [
        {
          type: "document",
          info: {
            policies: [{ action: "tool.use", resource: "*", effect: "allow" }],
            permissions: [{ action: "bigbud_thread_v1_*", resource: "*", effect: "deny" }],
          },
        },
      ],
      "/fixture/global",
      { signal: new AbortController().signal, assertCurrent: () => {} },
      "/workspace",
    ),
  ).rejects.toMatchObject({ diagnostic: { code: "permission-denied" } });
});
