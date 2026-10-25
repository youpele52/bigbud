import { mkdir, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { acquireV2PluginPublicationLock } from "./PluginSetup.lock.ts";
import { v2NativePluginDirectory } from "./PluginSetup.fs.ts";

it("owned lock release is intrinsically single-use, survives deadline/revocation and cannot delete a later successor", async () => {
  const app = await makeV2ThreadPluginFixture(),
    directory = path.join(app.root, "one-use-writer");
  await mkdir(directory, { mode: 0o700 });
  const identity = await v2NativePluginDirectory(directory),
    controller = new AbortController();
  const first = await acquireV2PluginPublicationLock(directory, identity, app.root, app.artifact, {
    signal: controller.signal,
    assertCurrent: () => controller.signal.throwIfAborted(),
  });
  try {
    controller.abort();
    const a = first(),
      b = first();
    expect(a).toBe(b);
    await Promise.all([a, b]);
    const second = await acquireV2PluginPublicationLock(
      directory,
      identity,
      app.root,
      app.artifact,
      { signal: new AbortController().signal, assertCurrent: () => {} },
    );
    try {
      const filename = path.join(directory, ".bigbud-thread-tools-managed.lock"),
        before = await readFile(filename),
        owned = await lstat(filename);
      expect(first()).toBe(a);
      await first();
      expect(await readFile(filename)).toEqual(before);
      expect((await lstat(filename)).ino).toBe(owned.ino);
    } finally {
      await second();
    }
  } finally {
    await app.close();
  }
});
