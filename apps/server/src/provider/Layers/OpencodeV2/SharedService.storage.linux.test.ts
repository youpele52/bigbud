import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, unlink, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { inspectV2LinuxProcess } from "./SharedService.storage.linux.ts";
import { selectV2SharedDatabase } from "./SharedService.storage.files.ts";

it.skipIf(process.platform !== "linux").each(["ambiguous", "unlink", "replace"])(
  "rejects a real owned process with %s native SQLite handles instead of selecting its plugin database",
  async (change) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "v2-linux-inventory-"));
    const child = fork(
      new URL("./SharedService.storage.linux.fixture.mjs", import.meta.url),
      [root],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    child.stderr?.resume();
    const closed = once(child, "exit");
    try {
      await once(child, "message", { signal: AbortSignal.timeout(10_000) });
      const original = await inspectV2LinuxProcess(child.pid!);
      expect(original.files).toContain(path.join(root, "native-wal"));
      expect(original.files).toContain(path.join(root, "plugin-wal"));
      if (change === "unlink") await unlink(path.join(root, "native"));
      if (change === "replace") {
        await writeFile(path.join(root, "replacement"), "task-owned replacement");
        await rename(path.join(root, "replacement"), path.join(root, "native"));
      }
      const discover = async () =>
        selectV2SharedDatabase((await inspectV2LinuxProcess(child.pid!)).files);
      await expect(discover()).rejects.toThrow(
        change === "ambiguous" ? "Ambiguous" : "invalidated",
      );
    } finally {
      child.kill();
      await closed;
      await rm(root, { recursive: true, force: true });
    }
  },
);
