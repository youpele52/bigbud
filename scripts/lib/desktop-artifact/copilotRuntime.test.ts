import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import Path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCopilotRuntimePackaging,
  copilotPackagingTargets,
  pruneCopilotRuntimePackages,
  resolveCopilotPackagingMode,
  writeCopilotPackagingManifest,
} from "../../../apps/desktop/scripts/copilotRuntimePackaging.cjs";
import { pickExternalDependencies } from "./build.runtime.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function file(path: string, text = "unchanged") {
  await mkdir(Path.dirname(path), { recursive: true });
  await writeFile(path, text);
}
async function fixture() {
  const root = await mkdtemp(Path.join(tmpdir(), "copilot-packaging-"));
  roots.push(root);
  const modules = Path.join(root, "_modules");
  const github = Path.join(modules, "@github");
  await file(Path.join(github, "copilot-sdk", "package.json"));
  await file(Path.join(github, "copilot", "package.json"));
  for (const name of ["copilot", "package.json", "README.md", "LICENSE.md"])
    await file(Path.join(github, "copilot-darwin-arm64", name));
  await file(Path.join(github, "copilot-sdk-darwin-arm64", "runtime.node"));
  await file(Path.join(github, "copilot-win32-x64", "copilot.exe"));
  const nested = Path.join(
    modules,
    "other",
    "node_modules",
    "@github",
    "copilot-sdk-linux-x64",
    "runtime.node",
  );
  await file(nested);
  await file(Path.join(modules, ".bin", "copilot-darwin-arm64"));
  await file(Path.join(modules, ".bin", "copilot-win32-x64.cmd"));
  const pi = Path.join(modules, "@earendil-works", "pi-coding-agent", "native.bin");
  const cua = Path.join(root, "cua-driver", "bin", "cua-driver");
  await file(pi, "Pi must remain");
  await file(cua, "cua-driver must remain");
  return { root, modules, github, nested, pi, cua };
}

describe("deliberate bridge/slim Copilot packaging", () => {
  it("defaults to bridge and only activates slim explicitly", () => {
    expect(resolveCopilotPackagingMode({})).toBe("bridge");
    expect(resolveCopilotPackagingMode({ BIGBUD_COPILOT_RUNTIME_MODE: "slim" })).toBe("slim");
    expect(() => resolveCopilotPackagingMode({ BIGBUD_COPILOT_RUNTIME_MODE: "automatic" })).toThrow(
      "bridge or slim",
    );
    expect(copilotPackagingTargets("mac", "universal")).toEqual(["darwin-arm64", "darwin-x64"]);
    expect(() => copilotPackagingTargets("win", "universal")).toThrow("Unsupported");
  });
  it("bridge retains required standalone native files but prunes SDK-native and wrong-target payloads", async () => {
    const f = await fixture();
    pruneCopilotRuntimePackages(f.modules, "bridge", ["darwin-arm64"]);
    writeCopilotPackagingManifest(f.root, "bridge", ["darwin-arm64"]);
    expect(assertCopilotRuntimePackaging(f.root).mode).toBe("bridge");
    expect(existsSync(Path.join(f.github, "copilot-darwin-arm64", "copilot"))).toBe(true);
    expect(existsSync(Path.join(f.github, "copilot-sdk-darwin-arm64"))).toBe(false);
    expect(existsSync(Path.join(f.github, "copilot-win32-x64"))).toBe(false);
    expect(existsSync(f.nested)).toBe(false);
    expect(existsSync(Path.join(f.modules, ".bin", "copilot-darwin-arm64"))).toBe(true);
    expect(existsSync(Path.join(f.modules, ".bin", "copilot-win32-x64.cmd"))).toBe(false);
    expect(await readFile(f.pi, "utf8")).toBe("Pi must remain");
    expect(await readFile(f.cua, "utf8")).toBe("cua-driver must remain");
  });
  it("slim omits both heavy runtime families and standalone launcher while retaining SDK/Pi/cua-driver", async () => {
    const f = await fixture();
    pruneCopilotRuntimePackages(f.modules, "slim", ["darwin-arm64"]);
    writeCopilotPackagingManifest(f.root, "slim", ["darwin-arm64"]);
    expect(assertCopilotRuntimePackaging(f.root).mode).toBe("slim");
    for (const name of [
      "copilot",
      "copilot-darwin-arm64",
      "copilot-sdk-darwin-arm64",
      "copilot-win32-x64",
    ])
      expect(existsSync(Path.join(f.github, name))).toBe(false);
    expect(existsSync(Path.join(f.github, "copilot-sdk", "package.json"))).toBe(true);
    expect(existsSync(Path.join(f.modules, ".bin", "copilot-darwin-arm64"))).toBe(false);
    expect(await readFile(f.pi, "utf8")).toBe("Pi must remain");
    expect(await readFile(f.cua, "utf8")).toBe("cua-driver must remain");
    const dependencies = {
      "@github/copilot": "1.0.105",
      "@github/copilot-sdk": "1.0.28",
      "@earendil-works/pi-coding-agent": "1.4.0",
      "node-pty": "1.1.0",
    };
    expect(pickExternalDependencies(dependencies, "slim")).toEqual({
      "@github/copilot-sdk": "1.0.28",
      "@earendil-works/pi-coding-agent": "1.4.0",
      "node-pty": "1.1.0",
    });
    expect(pickExternalDependencies(dependencies)).toEqual(dependencies);
  });
  it.each([
    "copilot",
    "copilot-darwin-arm64",
    "copilot-sdk-darwin-arm64",
    "copilot-sdk-unknown-future-platform",
  ])(
    "the final artifact guard rejects reintroduced %s, including nested packages",
    async (name) => {
      const f = await fixture();
      pruneCopilotRuntimePackages(f.modules, "slim");
      writeCopilotPackagingManifest(f.root, "slim", ["darwin-arm64"]);
      await file(Path.join(f.modules, "nested", "node_modules", "@github", name, "package.json"));
      expect(() => assertCopilotRuntimePackaging(f.root)).toThrow(
        "Forbidden bundled Copilot runtime",
      );
    },
  );
  it("fails the bridge guard if its migration source, license, or launcher is missing", async () => {
    const f = await fixture();
    pruneCopilotRuntimePackages(f.modules, "bridge", ["darwin-arm64"]);
    writeCopilotPackagingManifest(f.root, "bridge", ["darwin-arm64"]);
    await rm(Path.join(f.github, "copilot-darwin-arm64", "LICENSE.md"));
    expect(() => assertCopilotRuntimePackaging(f.root)).toThrow();
    await file(Path.join(f.github, "copilot-darwin-arm64", "LICENSE.md"));
    await rm(Path.join(f.github, "copilot"), { recursive: true });
    expect(() => assertCopilotRuntimePackaging(f.root)).toThrow("retain the standalone");
  });
  it("rejects a copied heavyweight executable or launcher reintroduced through .bin", async () => {
    const f = await fixture();
    pruneCopilotRuntimePackages(f.modules, "slim");
    writeCopilotPackagingManifest(f.root, "slim", ["darwin-arm64"]);
    await file(Path.join(f.modules, ".bin", "copilot.exe"));
    expect(() => assertCopilotRuntimePackaging(f.root)).toThrow(
      "Forbidden bundled Copilot executable",
    );
  });
});
