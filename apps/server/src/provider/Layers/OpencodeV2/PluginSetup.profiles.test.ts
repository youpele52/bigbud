import { mkdir, writeFile, readFile, lstat, unlink } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { publishV2ManagedPlugin } from "./PluginSetup.publication.ts";
import { V2_MANAGED_PLUGIN_FILENAME, v2ManagedPluginFilename } from "./PluginSetup.record.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";

it("racing profiles publish separate signed slots, preserve the legacy global file, and respect removal independently", async () => {
  const a = await makeV2ThreadPluginFixture(),
    b = await makeV2ThreadPluginFixture();
  try {
    const root = path.join(a.root, "shared-native-config");
    await mkdir(path.join(root, "plugins"), { recursive: true, mode: 0o700 });
    const legacy = path.join(root, "plugins", V2_MANAGED_PLUGIN_FILENAME);
    const original =
      "// retained foreign legacy entry; never claimed\nexport default {id:'bigbud.thread.v1'};\n";
    await writeFile(legacy, original, { mode: 0o600 });
    const before = await lstat(legacy);
    const retainedLocks = [
      ".bigbud-thread-tools-managed.lock",
      `.bigbud-thread-tools-${"f".repeat(64)}.lock`,
    ];
    const retained = await Promise.all(
      retainedLocks.map(async (name) => {
        const filename = path.join(root, "plugins", name);
        await writeFile(filename, "retained foreign writer evidence", { mode: 0o600 });
        return { filename, inode: (await lstat(filename)).ino };
      }),
    );
    const authority = { signal: new AbortController().signal, assertCurrent: () => {} };
    const outcomes = await Promise.allSettled(
      [a, b].map((app) => publishV2ManagedPlugin(app.artifact, root, authority)),
    );
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
    for (const lock of retained) {
      expect(await readFile(lock.filename, "utf8")).toBe("retained foreign writer evidence");
      expect((await lstat(lock.filename)).ino).toBe(lock.inode);
    }
    for (const app of [a, b]) {
      const filename = v2ManagedPluginFilename(app.artifact);
      expect(await readFile(path.join(root, "plugins", filename), "utf8")).toContain(
        app.artifact.entryUri,
      );
      const records = await V2ThreadRecords.open(
        app.artifact.root,
        "installations",
        app.artifact.privateKey,
        app.artifact.publicKey,
      );
      expect((await records.read(JSON.stringify([root, filename])))?.value).toMatchObject({
        protocol: "bigbud.thread.install.v2",
        phase: "committed",
        next: { issuer: app.artifact.issuer },
      });
      expect(
        await records.read(JSON.stringify([root, V2_MANAGED_PLUGIN_FILENAME])),
      ).toBeUndefined();
    }
    const bFile = path.join(root, "plugins", v2ManagedPluginFilename(b.artifact));
    const bBefore = await lstat(bFile);
    await unlink(path.join(root, "plugins", v2ManagedPluginFilename(a.artifact)));
    await expect(publishV2ManagedPlugin(a.artifact, root, authority)).rejects.toThrow(
      "native removal",
    );
    await publishV2ManagedPlugin(b.artifact, root, authority);
    expect((await lstat(bFile)).ino).toBe(bBefore.ino);
    expect(await readFile(legacy, "utf8")).toBe(original);
    expect((await lstat(legacy)).ino).toBe(before.ino);
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});

it("coordinates simultaneous first-directory creation without a shared retained writer lock", async () => {
  const a = await makeV2ThreadPluginFixture(),
    b = await makeV2ThreadPluginFixture();
  try {
    const root = path.join(a.root, "empty-shared-root");
    await mkdir(root, { mode: 0o700 });
    const rootIdentity = await lstat(root);
    const authority = { signal: new AbortController().signal, assertCurrent: () => {} };
    await Promise.all([a, b].map((app) => publishV2ManagedPlugin(app.artifact, root, authority)));
    const plugins = await lstat(path.join(root, "plugins"));
    for (const app of [a, b]) {
      const records = await V2ThreadRecords.open(
        app.artifact.root,
        "installations",
        app.artifact.privateKey,
        app.artifact.publicKey,
      );
      expect(
        (await records.read(JSON.stringify([root, v2ManagedPluginFilename(app.artifact)])))?.value,
      ).toMatchObject({
        phase: "committed",
        rootIdentity: { dev: rootIdentity.dev, ino: rootIdentity.ino },
        pluginsIdentity: { dev: plugins.dev, ino: plugins.ino },
      });
    }
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});
