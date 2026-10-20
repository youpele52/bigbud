import { expect, it } from "vitest";
import { chmod, mkdir, rm, symlink, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { exportV2ThreadArtifact } from "./Orchestration.artifact.ts";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";

it("loads outside the checkout without node_modules in both Node and Bun, and reuses only an exact immutable artifact", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const script = `import(${JSON.stringify(app.artifact.entryUri)}).then(module=>console.log(module.default.id))`;
    for (const binary of ["node", "bun"]) {
      const result = await promisify(execFile)(binary, ["-e", script], { cwd: app.root });
      expect(result.stdout.trim()).toBe(`bigbud.thread.v2.${app.artifact.issuer}`);
    }
    expect((await exportV2ThreadArtifact(app.root)).artifactDigest).toBe(
      app.artifact.artifactDigest,
    );
    await writeFile(path.join(app.artifact.directory, "registry.mjs"), "foreign payload", {
      mode: 0o600,
    });
    await expect(exportV2ThreadArtifact(app.root)).rejects.toThrow("collision");
    expect(await readFile(path.join(app.artifact.directory, "registry.mjs"), "utf8")).toBe(
      "foreign payload",
    );
  } finally {
    await app.close();
  }
});

it.skipIf(process.platform === "win32")(
  "refuses public-readable executable files and symlink collisions without following or repairing them",
  async () => {
    const app = await makeV2ThreadPluginFixture();
    try {
      const module = path.join(app.artifact.directory, "index.mjs");
      await chmod(module, 0o644);
      await expect(app.artifact.verify()).rejects.toThrow("file rejected");
      await chmod(module, 0o600);
      await rm(module);
      const outside = path.join(app.root, "outside.mjs");
      await writeFile(outside, "outside sentinel", { mode: 0o600 });
      await symlink(outside, module);
      await expect(exportV2ThreadArtifact(app.root)).rejects.toThrow();
      expect(await readFile(outside, "utf8")).toBe("outside sentinel");
      const foreignRoot = path.join(app.root, "foreign");
      await mkdir(foreignRoot, { mode: 0o700 });
      await symlink(foreignRoot, path.join(foreignRoot, "opencode-v2-thread-tools"));
      await expect(exportV2ThreadArtifact(foreignRoot)).rejects.toThrow("canonical");
    } finally {
      await app.close();
    }
  },
);
