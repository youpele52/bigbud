import { mkdir, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { removeV2NativePluginStaging } from "./PluginSetup.fs.ts";

const hook = vi.hoisted(() => ({ filename: "", lose: () => {}, unlinks: 0 }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await fs.lstat(...args);
      if (String(args[0]) === hook.filename) queueMicrotask(hook.lose);
      return stat;
    },
    unlink: async (...args: Parameters<typeof fs.unlink>) => {
      if (String(args[0]) === hook.filename) hook.unlinks++;
      return fs.unlink(...args);
    },
  };
});

it.each(["deadline", "revocation", "abort"] as const)(
  "normal staging cleanup cannot issue unlink after %s during its final awaited inode check",
  async (loss) => {
    const app = await makeV2ThreadPluginFixture(),
      directory = path.join(app.root, "owned-staging"),
      signal = new AbortController();
    let current = true;
    await mkdir(directory, { mode: 0o700 });
    const filename = path.join(directory, ".owned.pending");
    await writeFile(filename, "retained owned staging", { mode: 0o600 });
    const identity = await lstat(filename);
    hook.filename = filename;
    hook.unlinks = 0;
    hook.lose = () => {
      if (loss === "abort") signal.abort();
      else current = false;
    };
    const guard = () => {
      signal.signal.throwIfAborted();
      if (!current) throw new Error(`V2 ${loss} lost`);
    };
    try {
      const remove = removeV2NativePluginStaging as (
        filename: string,
        identity: { dev: number; ino: number },
        guard: () => void,
      ) => Promise<void>;
      await expect(remove(filename, identity, guard)).rejects.toThrow();
      expect(hook.unlinks).toBe(0);
      hook.filename = "";
      expect((await lstat(filename)).ino).toBe(identity.ino);
    } finally {
      hook.filename = "";
      hook.lose = () => {};
      await app.close();
    }
  },
);
