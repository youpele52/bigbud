import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateBackendGraphClosure } from "./build-remote-backend-graph.closure.ts";
import {
  cleanupGraphFixtures,
  elf,
  privateBase,
  writeTree,
} from "./build-remote-backend-graph.fixture.ts";
import { inventoryBackendGraph } from "./build-remote-backend-graph.inventory.ts";
import {
  BACKEND_GRAPH_LOADER_POLICY,
  backendGraphLoaderPolicyDigest,
  decodeBackendGraphLoaderPolicy,
  isAbsentOptionalExternal,
} from "./build-remote-backend-graph.policy.ts";
import { BACKEND_GRAPH_LOADER_POLICY_DATA } from "./build-remote-backend-graph.policy.data.ts";

afterEach(cleanupGraphFixtures);
const target = "aarch64-unknown-linux-gnu" as const;
const addon = "node_modules/addon/build/addon.node";
const basePolicy = {
  revision: 1,
  createRequireShim: "import.meta.url-only",
  reviewedDynamicLoaders: [] as unknown[],
  absentOptionalExternals: ["node-pty", "playwright*", "@effect/*-bun"],
  nativeAddons: [{ pkg: "addon", target, path: addon }],
};

async function closure(files: Record<string, string | Buffer>, policy: object = basePolicy) {
  const root = await writeTree(join(await privateBase(), "graph"), {
    "server/bin.mjs": "import './chunk.mjs';",
    "server/chunk.mjs": "export const ready = true;",
    ...files,
  });
  return validateBackendGraphClosure(root, await inventoryBackendGraph(root), {
    entry: "server/bin.mjs",
    target,
    policy: decodeBackendGraphLoaderPolicy(policy),
  });
}

describe("loader policy", () => {
  it("decodes the checked-in policy and pins it with a stable digest", () => {
    expect(BACKEND_GRAPH_LOADER_POLICY.revision).toBe(1);
    expect(backendGraphLoaderPolicyDigest(BACKEND_GRAPH_LOADER_POLICY)).toMatch(/^[a-f0-9]{64}$/);
    expect(
      backendGraphLoaderPolicyDigest(
        decodeBackendGraphLoaderPolicy(BACKEND_GRAPH_LOADER_POLICY_DATA),
      ),
    ).toBe(backendGraphLoaderPolicyDigest(BACKEND_GRAPH_LOADER_POLICY));
    for (const name of ["node-pty", "playwright", "@effect/platform-bun/BunServices"])
      expect(isAbsentOptionalExternal(BACKEND_GRAPH_LOADER_POLICY, name)).toBe(true);
    expect(isAbsentOptionalExternal(BACKEND_GRAPH_LOADER_POLICY, "node-pty-evil")).toBe(false);
  });

  it.each([
    { ...basePolicy, revision: 2 },
    { ...basePolicy, createRequireShim: "any" },
    { ...basePolicy, extra: true },
    { ...basePolicy, nativeAddons: [{ pkg: "addon", target, path: "server/x.node" }] },
    {
      ...basePolicy,
      reviewedDynamicLoaders: [
        { member: "a.js", sha256: "0".repeat(64), reason: "ok reason", roots: ["server/x.mjs"] },
      ],
    },
  ])("refuses an invalid policy %#", (policy) => {
    expect(() => decodeBackendGraphLoaderPolicy(policy)).toThrow();
  });
});

describe("reachability-aware closure", () => {
  it("refuses_absent_external_reachable_statically", async () => {
    await expect(
      closure({ "server/chunk.mjs": "import pty from 'node-pty'; export { pty };" }),
    ).rejects.toThrow("Absent optional external node-pty is statically reachable");
    await expect(
      closure({
        "server/chunk.mjs":
          "import { createRequire } from 'node:module'; const r = createRequire(import.meta.url); r('node-pty');",
      }),
    ).rejects.toThrow("statically reachable");
  });

  it("allows_dynamic_only_node_pty_absence", async () => {
    const report = await closure({
      "server/bin.mjs": "import './chunk.mjs'; export const later = () => import('./lazy.mjs');",
      "server/chunk.mjs": "export const load = () => import('node-pty');",
      "server/lazy.mjs": "import 'node-pty'; import '@effect/platform-bun/BunServices';",
    });
    expect(report.absentOptional).toEqual([
      { from: "server/chunk.mjs", specifier: "node-pty" },
      { from: "server/lazy.mjs", specifier: "@effect/platform-bun/BunServices" },
      { from: "server/lazy.mjs", specifier: "node-pty" },
    ]);
    // Unlisted packages stay refused even when only a dynamic import reaches them.
    await expect(
      closure({ "server/chunk.mjs": "export const load = () => import('not-in-graph');" }),
    ).rejects.toThrow("unresolved dependency not-in-graph");
  });

  it("allows the tsdown createRequire shim and still checks each literal __require", async () => {
    const shim =
      "import { createRequire } from 'node:module'; var __require = createRequire(import.meta.url);";
    const report = await closure({
      "server/chunk.mjs": `${shim} export const dep = __require('dep'); __require('node:fs');`,
      "node_modules/dep/package.json": JSON.stringify({
        name: "dep",
        version: "1.0.0",
        main: "lib.cjs",
      }),
      "node_modules/dep/lib.cjs": "module.exports = require('./inner.js');",
      "node_modules/dep/inner.js": "module.exports = 1;",
    });
    expect(report.reachableModules).toBe(4);
    await expect(
      closure({ "server/chunk.mjs": `${shim} export const dep = __require('missing-dep');` }),
    ).rejects.toThrow("unresolved dependency missing-dep");
  });

  it("refuses_unreviewed_createRequire_variable", async () => {
    const body =
      "import { createRequire } from 'node:module'; export const load = (path) => createRequire(path)('x');";
    await expect(closure({ "server/chunk.mjs": body })).rejects.toThrow(
      "create-require-variable in server/chunk.mjs",
    );
    await expect(
      closure({ "server/chunk.mjs": "export const load = (name) => require(name);" }),
    ).rejects.toThrow("non-literal-require");
    // A reviewed member is matched by source marker and hash; any edit needs a new review.
    const sha256 = createHash("sha256").update(body).digest("hex");
    const reviewed = {
      ...basePolicy,
      reviewedDynamicLoaders: [
        { member: "server/chunk.mjs", sha256, reason: "fixture review", roots: [] },
      ],
    };
    await expect(closure({ "server/chunk.mjs": body }, reviewed)).resolves.toMatchObject({
      reviewedSites: 1,
    });
    await expect(closure({ "server/chunk.mjs": `${body}\n// edited` }, reviewed)).rejects.toThrow(
      "create-require-variable",
    );
  });

  it("matches rolldown region markers and adds reviewed roots inside node_modules", async () => {
    const region =
      "//#region ../../node_modules/.bun/x@1.0.0/node_modules/x/load.js\nimport(globalThis.target);\n//#endregion";
    const policy = {
      ...basePolicy,
      reviewedDynamicLoaders: [
        {
          member: "x/load.js",
          sha256: createHash("sha256").update(region).digest("hex"),
          reason: "fixture region review",
          roots: ["node_modules/tool/cli.js"],
        },
      ],
    };
    const files = {
      "server/chunk.mjs": `${region}\n`,
      "node_modules/tool/cli.js": "import 'node-pty';",
    };
    await expect(closure(files, policy)).rejects.toThrow(
      "statically reachable from node_modules/tool/cli.js",
    );
    await expect(
      closure({ ...files, "node_modules/tool/cli.js": "export {};" }, policy),
    ).resolves.toMatchObject({ reviewedSites: 1, staticModules: 3 });
  });

  it("refuses generated code, native loaders and invalid syntax in node_modules reached by literals", async () => {
    for (const body of [
      "new Function('return 1')",
      "process.dlopen(module, './a.node')",
      "export =",
    ])
      await expect(
        closure({
          "server/chunk.mjs": "export const later = () => import('dep');",
          "node_modules/dep/package.json": JSON.stringify({
            name: "dep",
            version: "1.0.0",
            exports: "./i.js",
          }),
          "node_modules/dep/i.js": body,
        }),
      ).rejects.toThrow();
  });

  it("native_addon_wrong_machine_refused", async () => {
    await expect(closure({ [addon]: elf(62, 3) })).rejects.toThrow(
      `Native addon ${addon} does not match the ${target} ELF machine.`,
    );
    await expect(closure({ "node_modules/addon/other.node": elf(183, 3) })).rejects.toThrow(
      "is not listed",
    );
    await expect(closure({ "node_modules/tool/rg": elf(62) })).rejects.toThrow(
      "does not match the aarch64-unknown-linux-gnu machine",
    );
    await expect(closure({ [addon]: elf(183, 3) })).resolves.toMatchObject({
      nativeAddons: [addon],
    });
  });
});
