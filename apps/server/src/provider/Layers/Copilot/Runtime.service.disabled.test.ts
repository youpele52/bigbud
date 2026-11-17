import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import Path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CopilotRuntimeInvocation } from "./Adapter.types.cli.ts";
import type { installCopilotRuntime } from "./Runtime.install.ts";
import { copilotRuntimeRequest } from "./Runtime.service.ts";

const control = vi.hoisted(() => ({
  invocation: undefined as CopilotRuntimeInvocation | undefined,
  install: vi.fn<typeof installCopilotRuntime>(),
  execFile: vi.fn(
    (
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
    ) => callback(null, { stdout: "GitHub Copilot CLI 9.9.9.\n", stderr: "" }),
  ),
}));
vi.mock("./Runtime.install.ts", () => ({ installCopilotRuntime: control.install }));
vi.mock("./Adapter.types.cli.ts", () => ({
  resolveCopilotRuntimeInvocation: () => control.invocation,
}));
// Any version probe would launch the self-extracting vendor CLI; it must never run here.
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: control.execFile,
}));

const dirs: string[] = [];
beforeEach(() => {
  control.install.mockReset();
  control.execFile.mockClear();
});
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fixture executable, optionally inside an npm package that names its version. */
async function executable(source: CopilotRuntimeInvocation["source"], manifest?: string) {
  const dir = await mkdtemp(Path.join(tmpdir(), "copilot-disabled-"));
  dirs.push(dir);
  const pkg = Path.join(dir, "pkg");
  await mkdir(pkg);
  const path = Path.join(pkg, "copilot");
  await writeFile(path, "#!/bin/sh\n", { mode: 0o700 });
  if (manifest)
    await writeFile(
      Path.join(pkg, "package.json"),
      JSON.stringify({ name: manifest, version: "1.0.105" }),
    );
  control.invocation = { path, args: [], source };
  return { root: Path.join(dir, "runtime-root") };
}

const settings = (enabled: boolean) => ({ binaryPath: "copilot", enabled });

describe("Copilot runtime status for a disabled provider", () => {
  it("never executes, installs, or writes for a bundled self-extracting CLI", async () => {
    const { root } = await executable("bundled-native", "@github/copilot-linux-arm64");
    const state = await copilotRuntimeRequest({ action: "status" }, settings(false), root);
    expect(control.execFile).not.toHaveBeenCalled();
    expect(control.install).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      available: true,
      source: "bundled-native",
      version: "1.0.105",
      onboarding: false,
      job: null,
      managed: [],
    });
    // Passive status must not even create bigbud's own runtime root.
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not probe an external binary without package metadata", async () => {
    const { root } = await executable("existing");
    const state = await copilotRuntimeRequest({ action: "status" }, settings(false), root);
    expect(control.execFile).not.toHaveBeenCalled();
    expect(state.version).toBeNull();
    expect(state.onboarding).toBe(false);
  });

  it("does not prompt setup while disabled even when the runtime is missing", async () => {
    const { root } = await executable("existing");
    control.invocation = undefined;
    // A non-default path skips the SDK-package fallback that a dev checkout would otherwise find.
    const provider = { binaryPath: "/missing/copilot", enabled: false };
    const state = await copilotRuntimeRequest({ action: "status" }, provider, root);
    expect(state).toMatchObject({ available: false, source: "missing", onboarding: false });
    expect(control.execFile).not.toHaveBeenCalled();
    expect(control.install).not.toHaveBeenCalled();
  });
});

describe("Copilot runtime status for an enabled provider", () => {
  it("reads a bundled CLI version from its manifest instead of launching it", async () => {
    const { root } = await executable("bundled-native", "@github/copilot-darwin-arm64");
    const state = await copilotRuntimeRequest({ action: "status" }, settings(true), root);
    expect(control.execFile).not.toHaveBeenCalled();
    expect(control.install).not.toHaveBeenCalled();
    expect(state.version).toBe("1.0.105");
  });

  it("still probes an external binary that has no package metadata", async () => {
    const { root } = await executable("existing");
    const state = await copilotRuntimeRequest({ action: "status" }, settings(true), root);
    expect(control.execFile).toHaveBeenCalledTimes(1);
    expect(state.version).toBe("9.9.9");
    expect(control.install).not.toHaveBeenCalled();
  });
});
