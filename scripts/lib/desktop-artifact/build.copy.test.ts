import * as NodeServices from "@effect/platform-node/NodeServices";
import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { copyDesktopArtifacts } from "./build.copy.ts";

const ownedRoots: Array<string> = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "desktop-artifact-copy-"));
  ownedRoots.push(root);
  const stage = join(root, "stage");
  const output = join(root, "output");
  await mkdir(stage);
  return { stage, output };
}

function copy(stage: string, output: string) {
  return Effect.runPromise(
    copyDesktopArtifacts(stage, output).pipe(Effect.provide(NodeServices.layer)),
  );
}

afterEach(async () => {
  for (const root of ownedRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("desktop artifact copy", () => {
  it.skipIf(process.platform === "win32")(
    "preserves relative framework links after staging is deleted",
    async () => {
      const { stage, output } = await fixture();
      const relativeFramework = join(
        "mac-arm64",
        "fixture.app",
        "Contents",
        "Frameworks",
        "Electron Framework.framework",
      );
      const sourceFramework = join(stage, relativeFramework);
      const version = join(sourceFramework, "Versions", "A");
      await mkdir(version, { recursive: true });
      await writeFile(join(version, "Electron Framework"), "framework fixture", { mode: 0o755 });
      await symlink("A", join(sourceFramework, "Versions", "Current"), "dir");
      await symlink(
        "Versions/Current/Electron Framework",
        join(sourceFramework, "Electron Framework"),
      );

      expect(await copy(stage, output)).toEqual([join(output, "mac-arm64")]);
      const copiedFramework = join(output, relativeFramework);
      expect(await readlink(join(copiedFramework, "Versions", "Current"))).toBe("A");
      expect(await readlink(join(copiedFramework, "Electron Framework"))).toBe(
        "Versions/Current/Electron Framework",
      );
      await rm(stage, { recursive: true, force: true });
      expect(await readFile(join(copiedFramework, "Electron Framework"), "utf8")).toBe(
        "framework fixture",
      );
      expect((await stat(join(copiedFramework, "Electron Framework"))).mode & 0o777).toBe(0o755);
    },
  );

  it("copies ordinary artifact files and directories", async () => {
    const { stage, output } = await fixture();
    await mkdir(join(stage, "unpacked"));
    await writeFile(join(stage, "unpacked", "runtime.json"), "{}");
    await writeFile(join(stage, "manifest.yml"), "version: fixture\n");
    const copied = await copy(stage, output);
    expect(copied.sort()).toEqual([join(output, "manifest.yml"), join(output, "unpacked")].sort());
    expect(await readFile(join(output, "unpacked", "runtime.json"), "utf8")).toBe("{}");
    expect(await readFile(join(output, "manifest.yml"), "utf8")).toBe("version: fixture\n");
  });

  it("fails explicitly when packaging produced no artifacts", async () => {
    const { stage, output } = await fixture();
    await expect(copy(stage, output)).rejects.toThrow("no files were produced");
  });
});
