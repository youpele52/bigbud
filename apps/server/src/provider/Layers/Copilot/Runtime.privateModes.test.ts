import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import Path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preserveBundledCopilotRuntime } from "@bigbud/shared/copilotRuntime.bridge";
import { readManagedCopilotRuntime } from "@bigbud/shared/copilotRuntime.paths";
import { runtimeDirectory } from "@bigbud/shared/copilotRuntime.storage";
import { installCopilotRuntime } from "./Runtime.install.ts";
import { archiveFetch, runtimeFixture } from "./Runtime.test.helpers.ts";
import {
  copilotRuntimeEnvironment,
  copilotVendorCacheDirectory,
  prepareCopilotVendorCache,
} from "./Runtime.vendorCache.ts";

const dirs: string[] = [];
let previousUmask: number | undefined;
beforeEach(() => {
  // The field failure ran under umask 000; prove modes do not depend on the inherited umask.
  try {
    previousUmask = process.umask(0);
  } catch {
    previousUmask = undefined; // Worker threads cannot change umask; explicit chmod still applies.
  }
});
afterEach(async () => {
  if (previousUmask !== undefined) process.umask(previousUmask);
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function temp() {
  const dir = await mkdtemp(Path.join(tmpdir(), "copilot-private-"));
  dirs.push(dir);
  return dir;
}
const mode = async (path: string) => (await stat(path)).mode & 0o777;

/** Every entry beneath `directory` (inclusive) with its permission bits. */
async function modes(directory: string): Promise<Array<[string, boolean, number]>> {
  const found: Array<[string, boolean, number]> = [[directory, true, await mode(directory)]];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = Path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await modes(path)));
    else found.push([path, false, await mode(path)]);
  }
  return found;
}

describe.skipIf(process.platform === "win32")("bigbud-owned Copilot runtime modes", () => {
  it("creates and tightens runtime directories to exactly 0700", async () => {
    const base = await temp();
    const loose = Path.join(base, "loose");
    await mkdir(loose);
    await chmod(loose, 0o777);
    await runtimeDirectory(loose);
    expect(await mode(loose)).toBe(0o700);
    const fresh = Path.join(base, "fresh");
    await runtimeDirectory(fresh, true);
    expect(await mode(fresh)).toBe(0o700);
    await expect(runtimeDirectory(fresh, true)).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("publishes a downloaded runtime with owner-only directories and files", async () => {
    const root = Path.join(await temp(), "runtime");
    const fixture = runtimeFixture();
    const installed = await installCopilotRuntime({
      root,
      release: fixture.release,
      fetch: archiveFetch(fixture.bytes),
    });
    expect(await mode(root)).toBe(0o700);
    for (const [path, isDirectory, bits] of await modes(installed.directory)) {
      const expected = isDirectory || path === installed.path ? 0o700 : 0o600;
      expect([path, bits]).toEqual([path, expected]);
    }
  });

  it("preserves a world-writable bundled copy as owner-only", async () => {
    const base = await temp();
    const resourcesPath = Path.join(base, "resources");
    const target = `${process.platform}-arm64`;
    const source = Path.join(resourcesPath, "server", "_modules", "@github", `copilot-${target}`);
    await mkdir(source, { recursive: true });
    const files = {
      copilot: "bytes",
      "package.json": JSON.stringify({ name: `@github/copilot-${target}`, version: "1.0.102" }),
      "LICENSE.md": "license",
      "README.md": "readme",
    };
    for (const [name, text] of Object.entries(files)) {
      await writeFile(Path.join(source, name), text);
      await chmod(Path.join(source, name), 0o777);
    }
    await writeFile(
      Path.join(resourcesPath, "server", "copilot-runtime.json"),
      JSON.stringify({ format: "bigbud.copilot-runtime.v1", mode: "bridge", targets: [target] }),
    );
    const root = Path.join(base, "managed");
    await preserveBundledCopilotRuntime({
      resourcesPath,
      root,
      platform: process.platform,
      arch: "arm64",
    });
    const installed = readManagedCopilotRuntime(root)!;
    for (const [path, isDirectory, bits] of await modes(installed.directory)) {
      const expected = isDirectory || path === installed.path ? 0o700 : 0o600;
      expect([path, bits]).toEqual([path, expected]);
    }
  });

  it("points only bigbud-owned CLIs at a private vendor package cache", async () => {
    const root = Path.join(await temp(), "runtime");
    const env = { PATH: "/usr/bin", UNSET: undefined };
    for (const source of ["bundled-native", "managed"] as const) {
      expect(copilotRuntimeEnvironment({ source }, env, root)).toEqual({
        PATH: "/usr/bin",
        COPILOT_PKG_CACHE_HOME: copilotVendorCacheDirectory(root),
      });
    }
    for (const source of ["configured", "existing", "sdk"] as const)
      expect(copilotRuntimeEnvironment({ source }, env, root)).toBeUndefined();
    // Explicit user cache overrides are respected.
    expect(
      copilotRuntimeEnvironment({ source: "bundled-native" }, { COPILOT_CACHE_HOME: "/c" }, root),
    ).toBeUndefined();
    await prepareCopilotVendorCache(root);
    expect(await mode(copilotVendorCacheDirectory(root))).toBe(0o700);
  });
});
