import { mkdtemp, mkdir, readFile, realpath, rm, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readV2ApplicationConfig } from "./Application.config.ts";

it("creates only explicitly selected new private storage and refuses unowned profiles", async () => {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "v2-app-config-")));
  try {
    const root = path.join(parent, "owned");
    const input = { binaryPath: "/missing/v2", profileRoot: root };
    const config = await readV2ApplicationConfig(input);
    expect(config.process).toEqual({ ...input, runtimeTargetId: "local" });
    expect(await readFile(path.join(root, ".bigbud-opencode-v2"), "utf8")).toContain("owned-v1");
    expect(await readV2ApplicationConfig(input)).toEqual(config);
    const unowned = path.join(parent, "unowned");
    await mkdir(unowned, { mode: 0o700 });
    await expect(readV2ApplicationConfig({ ...input, profileRoot: unowned })).rejects.toThrow();
    await expect(readFile(path.join(unowned, ".bigbud-opencode-v2"))).rejects.toThrow();
    await chmod(root, 0o755);
    await expect(readV2ApplicationConfig(input)).rejects.toThrow("private");
    await expect(readV2ApplicationConfig({ ...input, binaryPath: "opencode" })).rejects.toThrow(
      "absolute",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
