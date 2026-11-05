import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import Path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveExternalCopilot } from "./Runtime.executable.ts";
import { resolveCopilotRuntimeInvocation } from "./Adapter.types.cli.ts";
import { discoverCopilotRuntime } from "./Runtime.discovery.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function storage() {
  const root = await realpath(await mkdtemp(Path.join(tmpdir(), "copilot-external-")));
  roots.push(root);
  return root;
}

describe("external Copilot discovery", () => {
  it("resolves configured PATH commands and symlinks to an absolute SDK-spawnable path", async () => {
    const root = await storage();
    const binary = Path.join(
      root,
      process.platform === "win32" ? "custom-copilot.exe" : "custom-copilot",
    );
    const alias = Path.join(root, process.platform === "win32" ? "copilot.exe" : "copilot");
    await writeFile(binary, "#!/bin/sh\necho 1.0.103\n", { mode: 0o755 });
    await symlink(binary, alias);
    expect(resolveExternalCopilot("copilot", "@github/copilot-darwin-arm64", { PATH: root })).toBe(
      alias,
    );
    expect(resolveCopilotRuntimeInvocation("custom-copilot", { env: { PATH: root } })).toEqual({
      path: binary,
      source: "configured",
      args: [],
    });
    expect(
      resolveCopilotRuntimeInvocation("copilot", {
        isElectron: false,
        env: { PATH: root },
        managedRoot: Path.join(root, "absent"),
      })?.source,
    ).toBe("existing");
  });
  it("honors an explicitly configured environment executable ahead of managed/legacy resolution", async () => {
    const root = await storage();
    const binary = Path.join(root, "tool.js");
    await writeFile(binary, "console.log('1.0.103')");
    expect(
      resolveCopilotRuntimeInvocation("copilot", { env: { COPILOT_CLI_PATH: binary, PATH: "" } })
        ?.path,
    ).toBe(binary);
  });
  it("supports a user-provided JavaScript executable with spaces without invoking a shell", async () => {
    const root = await storage();
    const binary = Path.join(root, "copilot with spaces.js");
    await writeFile(binary, "console.log('GitHub Copilot 1.0.103')");
    const state = await discoverCopilotRuntime(binary, root);
    expect(state).toMatchObject({
      available: true,
      source: "configured",
      path: binary,
      version: "1.0.103",
      installedSizeBytes: null,
    });
  });
  it("never interprets arbitrary Windows shell shim contents", async () => {
    const root = await storage();
    const shim = Path.join(root, "copilot.cmd");
    await writeFile(shim, "malicious shell content", { mode: 0o755 });
    expect(
      resolveExternalCopilot(shim, "@github/copilot-win32-x64", { PATH: root }),
    ).toBeUndefined();
    expect(
      resolveExternalCopilot(Path.join(root, "absent"), undefined, { PATH: "" }),
    ).toBeUndefined();
    await mkdir(Path.join(root, "directory"));
    expect(resolveExternalCopilot(Path.join(root, "directory"), undefined)).toBeUndefined();
  });
});
