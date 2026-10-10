import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import config from "../../../../tsdown.config.ts";

it("configured V2 runtime artifacts include their relative dependencies and load outside the source tree", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "v2-packaging-artifacts-"));
  try {
    const copies = Array.isArray(config.copy) ? config.copy : [];
    const names = new Set<string>();
    const sources: string[] = [];
    for (const copy of copies) {
      if (typeof copy === "string" || typeof copy.from !== "string")
        throw new Error("Expected explicit server runtime artifact copies.");
      const filename = path.basename(copy.from);
      names.add(filename);
      sources.push(await readFile(copy.from, "utf8"));
      await copyFile(copy.from, path.join(directory, filename));
    }
    expect(names.has("ServerManager.ssh.bootstrap.mjs")).toBe(true);
    expect(names.has("ProfileIsolation.mjs")).toBe(true);
    for (const source of sources)
      for (const dependency of source.matchAll(/from "\.\/([^"]+\.mjs)"/g))
        expect(names, `Missing copied dependency ${dependency[1]}`).toContain(dependency[1]);
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(pathToFileURL(path.join(directory, "ProfileIsolation.mjs")).href)})`,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
