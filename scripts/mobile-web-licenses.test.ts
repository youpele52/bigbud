import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  cleanupGraphFixtures,
  privateBase,
  writeTree,
} from "./build-remote-backend-graph.fixture.ts";
import { renderThirdPartyNotices } from "./build-remote-backend-graph.notices.ts";
import {
  npmLicenseInventory,
  npmNoticeEntries,
  npmProductionClosure,
} from "./mobile-web-licenses.logic.ts";

afterEach(cleanupGraphFixtures);
const manifest = (value: Record<string, unknown>) => JSON.stringify(value);

/** An isolated-linker layout: app deps are symlinks into a `.bun` store, a workspace package is
 * a symlink to its source, and dev/optional/uninstalled-peer packages must not be followed. */
async function workspace() {
  const root = await privateBase("bb-npm-licenses-");
  await writeTree(root, {
    LICENSE: "MIT bigbud",
    "apps/app/package.json": manifest({
      name: "@bigbud/app",
      version: "0.0.0",
      dependencies: { a: "1", "@bigbud/shared": "workspace:*" },
      devDependencies: { dev: "1" },
    }),
    "packages/shared/package.json": manifest({
      name: "@bigbud/shared",
      version: "0.0.0",
      dependencies: { b: "2" },
      optionalDependencies: { native: "1" },
    }),
    "node_modules/.bun/a@1.0.0/node_modules/a/package.json": manifest({
      name: "a",
      version: "1.0.0",
      license: "MIT",
      dependencies: { b: "2" },
      peerDependencies: { "missing-peer": "1" },
    }),
    "node_modules/.bun/a@1.0.0/node_modules/a/LICENSE": "MIT a",
    "node_modules/.bun/b@2.0.0/node_modules/b/package.json": manifest({
      name: "b",
      version: "2.0.0",
      license: { type: "ISC" },
      repository: { url: "git+https://example.test/b.git" },
    }),
    "node_modules/.bun/dev@1.0.0/node_modules/dev/package.json": manifest({
      name: "dev",
      version: "1.0.0",
    }),
    "node_modules/.bun/native@1.0.0/node_modules/native/package.json": manifest({
      name: "native",
      version: "1.0.0",
    }),
  });
  const link = async (target: string, path: string) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await symlink(join(root, target), join(root, path));
  };
  await link("node_modules/.bun/a@1.0.0/node_modules/a", "apps/app/node_modules/a");
  await link("node_modules/.bun/dev@1.0.0/node_modules/dev", "apps/app/node_modules/dev");
  await link("packages/shared", "apps/app/node_modules/@bigbud/shared");
  await link(
    "node_modules/.bun/b@2.0.0/node_modules/b",
    "node_modules/.bun/a@1.0.0/node_modules/b",
  );
  await link("node_modules/.bun/b@2.0.0/node_modules/b", "packages/shared/node_modules/b");
  await link(
    "node_modules/.bun/native@1.0.0/node_modules/native",
    "packages/shared/node_modules/native",
  );
  return root;
}

it("npm_closure_follows_production_dependencies_only", async () => {
  const root = await workspace();
  const closure = await npmProductionClosure(root, "apps/app");
  expect(closure.packages).toEqual([
    {
      name: "a",
      version: "1.0.0",
      license: "MIT",
      repository: null,
      evidence: "file",
      files: [{ path: "a@1.0.0/LICENSE", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }],
    },
    {
      name: "b",
      version: "2.0.0",
      license: "ISC",
      repository: "git+https://example.test/b.git",
      evidence: "declared",
      files: [],
    },
  ]);
  const inventory = npmLicenseInventory({
    root: "@bigbud/app",
    lockfileSha256: "0".repeat(64),
    packages: closure.packages,
  });
  expect(inventory.summary).toEqual({
    packages: 2,
    byLicense: { ISC: 1, MIT: 1 },
    withoutLicenseFiles: ["b@2.0.0"],
  });
  expect(JSON.stringify(inventory)).not.toContain(root);
  const render = async () =>
    renderThirdPartyNotices("Mobile", npmNoticeEntries(closure), async (path) => {
      const { readFile } = await import("node:fs/promises");
      return readFile(closure.sources.get(path)!);
    });
  const text = await render();
  expect(text).toContain("bigbud (project)\nDeclared license: MIT\nLocation: workspace\n");
  expect(text).toContain("MIT bigbud");
  expect(text).toContain("a@1.0.0 (package)\nDeclared license: MIT\nLocation: npm\n");
  expect(text).toContain("MIT a");
  expect(text).toContain(
    "b@2.0.0 (package)\nDeclared license: ISC\nLocation: npm\n\n" +
      "No license or notice file is shipped for this component.",
  );
  expect(await render()).toBe(text);
});

it("npm_closure_refuses_an_uninstalled_production_dependency", async () => {
  const root = await workspace();
  await writeTree(root, {
    "apps/other/package.json": manifest({ name: "o", version: "0.0.0", dependencies: { z: "1" } }),
  });
  await expect(npmProductionClosure(root, "apps/other")).rejects.toThrow(
    "Production dependency z of o is not installed.",
  );
});
