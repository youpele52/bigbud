import { mkdir, readFile, lstat, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { exportV2NativeFamilyArtifact } from "./Subagents.artifact.ts";
import { publishV2NativeFamilyArtifact } from "./Subagents.publication.ts";

it("publishes a separately signed guard through the real activation/staging boundary without touching native config or frozen bootstrap", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const guard = await exportV2NativeFamilyArtifact(app.root);
    const root = path.join(app.root, "native-family-config");
    await mkdir(root, { mode: 0o755 });
    const config = path.join(root, "opencode.jsonc"),
      bytes = '// preserved config\n{"unknown":true}\n';
    await writeFile(config, bytes, { mode: 0o600 });
    let closed = false;
    const assertGate = () => {
      if (!closed) throw new Error("fixture writer gate not held");
    };
    const controller = new AbortController();
    const authority = {
      signal: controller.signal,
      scopeKey: "offline-family-publication",
      assertCurrent: () => controller.signal.throwIfAborted(),
      publication: {
        joinPhysicalOnCancel: true as const,
        prepare: async () => {},
        locked: async () => {
          closed = true;
          return () => {
            closed = false;
          };
        },
        assertGate,
        beforeMutation: async () => assertGate(),
        mutationIssued: assertGate,
      },
    };
    await publishV2NativeFamilyArtifact(guard, root, authority, app.artifact);
    const filename = path.join(root, "plugins", guard.filename),
      before = await lstat(filename);
    expect(before.mode & 0o077).toBe(0);
    expect(before.nlink).toBe(1);
    expect(await readFile(filename, "utf8")).toContain(guard.entryUri);
    expect(await readFile(config, "utf8")).toBe(bytes);
    await app.artifact.verify();
    await publishV2NativeFamilyArtifact(guard, root, authority, app.artifact);
    expect((await lstat(filename)).ino).toBe(before.ino);
    await unlink(filename);
    await expect(
      publishV2NativeFamilyArtifact(guard, root, authority, app.artifact),
    ).rejects.toThrow("removed");
  } finally {
    await app.close();
  }
});
