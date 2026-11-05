import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { copilotRuntimeRoot, readManagedCopilotRuntime } from "@bigbud/shared/copilotRuntime.paths";
import { resolveCopilotRuntimeInvocation } from "./Adapter.types.cli.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function ownedRuntime(target = "darwin-arm64") {
  const root = await mkdtemp(Path.join(tmpdir(), "bigbud-copilot-paths-"));
  roots.push(root);
  const relative = `1.0.103/${target}`;
  const directory = Path.join(root, relative);
  await mkdir(Path.join(directory, "package"), { recursive: true });
  const binary = Path.join(directory, "package", "copilot");
  await writeFile(binary, "binary", { mode: 0o755 });
  await writeFile(Path.join(directory, ".bigbud-owned"), `bigbud.copilot.v1\n${relative}\n`);
  await writeFile(Path.join(root, "current"), `${relative}\n`);
  return { root, directory, binary };
}

describe("Copilot runtime storage", () => {
  it("uses application-data paths, not the signed bundle or auth directories", () => {
    expect(copilotRuntimeRoot({ platform: "darwin", home: "/home/me", env: {} })).toBe(
      "/home/me/Library/Application Support/bigbud/runtimes/copilot",
    );
    expect(copilotRuntimeRoot({ platform: "linux", home: "/home/me", env: {} })).toBe(
      "/home/me/.local/share/bigbud/runtimes/copilot",
    );
    expect(
      copilotRuntimeRoot({ platform: "linux", home: "/home/me", env: { XDG_DATA_HOME: "/data" } }),
    ).toBe("/data/bigbud/runtimes/copilot");
    expect(
      copilotRuntimeRoot({
        platform: "linux",
        home: "/home/me",
        env: { XDG_DATA_HOME: "relative" },
      }),
    ).toContain("/home/me/.local/share/");
    expect(
      copilotRuntimeRoot({
        platform: "win32",
        home: "C:\\Users\\me",
        env: { APPDATA: "D:\\Data" },
      }),
    ).toBe("D:\\Data\\bigbud\\runtimes\\copilot");
  });

  it("resolves only owned, published, executable runtime files", async () => {
    const { root, directory, binary } = await ownedRuntime();
    expect(readManagedCopilotRuntime(root)).toEqual({
      path: binary,
      version: "1.0.103",
      target: "darwin-arm64",
      directory,
    });
    await chmod(binary, 0o644);
    if (process.platform !== "win32") expect(readManagedCopilotRuntime(root)).toBeUndefined();
    await chmod(binary, 0o755);
    await rm(Path.join(directory, ".bigbud-owned"));
    expect(readManagedCopilotRuntime(root)).toBeUndefined();
  });

  it.each(["../external", "1.0.103/../../external", "/external", "1.0.103/darwin-arm64\nextra"])(
    "rejects pointer %s",
    async (pointer) => {
      const { root } = await ownedRuntime();
      await writeFile(Path.join(root, "current"), pointer);
      expect(readManagedCopilotRuntime(root)).toBeUndefined();
    },
  );

  it("refuses symlinks at the pointer, package, executable, and storage root", async () => {
    const { root, directory, binary } = await ownedRuntime();
    const pointer = Path.join(root, "current");
    await rm(pointer);
    await symlink(binary, pointer);
    expect(readManagedCopilotRuntime(root)).toBeUndefined();
    await rm(pointer);
    await writeFile(pointer, "1.0.103/darwin-arm64");
    await rm(binary);
    await symlink(pointer, binary);
    expect(readManagedCopilotRuntime(root)).toBeUndefined();
    await rm(Path.join(directory, "package"), { recursive: true });
    await symlink(root, Path.join(directory, "package"));
    expect(readManagedCopilotRuntime(root)).toBeUndefined();
    const link = Path.join(root, "link");
    await symlink(root, link);
    expect(readManagedCopilotRuntime(link)).toBeUndefined();
  });

  it("prefers configured then compatible managed runtimes, preserving legacy fallback", async () => {
    const { root, binary } = await ownedRuntime();
    const configured = Path.join(root, "custom.js");
    await writeFile(configured, "console.log('1.0.103')");
    const input = {
      managedRoot: root,
      isElectron: true,
      platform: "darwin" as const,
      arch: "arm64",
      isMusl: false,
      env: { PATH: "" },
    };
    expect(resolveCopilotRuntimeInvocation(configured, input)?.source).toBe("configured");
    expect(resolveCopilotRuntimeInvocation("/removed-old-bundle/copilot", input)?.path).toBe(
      binary,
    );
    expect(resolveCopilotRuntimeInvocation("copilot", input)).toEqual({
      path: binary,
      args: [],
      source: "managed",
    });
    expect(
      resolveCopilotRuntimeInvocation("copilot", {
        ...input,
        arch: "x64",
        resolve: () => "/legacy/copilot",
      })?.path,
    ).toBe("/legacy/copilot");
  });
  it("keeps an Intel bridge runtime usable after the app switches from Rosetta to arm64", async () => {
    const { root, binary } = await ownedRuntime("darwin-x64");
    expect(
      resolveCopilotRuntimeInvocation("copilot", {
        managedRoot: root,
        platform: "darwin",
        arch: "arm64",
        isMusl: false,
        env: { PATH: "" },
        isElectron: true,
      })?.path,
    ).toBe(binary);
  });
});
