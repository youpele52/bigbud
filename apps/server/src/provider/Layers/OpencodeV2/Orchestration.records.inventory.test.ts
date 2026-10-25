import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import * as storage from "./Orchestration.storage.ts";
import { deferred } from "./Test.fixtures.ts";

it.skipIf(process.platform === "win32")(
  "joins a live atomic writer before inventory without ignoring abandoned or unknown evidence",
  async () => {
    const app = await makeV2ThreadPluginFixture();
    const release = deferred<void>();
    const staged = deferred<void>();
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const records = await V2ThreadRecords.open(
        app.artifact.root,
        "enrollments",
        app.artifact.privateKey,
        app.artifact.publicKey,
      );
      const revision = await records.replace("owner", undefined, { state: "pending" });
      const write = storage.writeV2ThreadPrivateFile;
      spy = vi.spyOn(storage, "writeV2ThreadPrivateFile").mockImplementation(async (...args) => {
        await write(...args);
        if (
          path.dirname(args[0]) === records.directory &&
          /^[a-f0-9]{64}\.[a-f0-9]{32}$/.test(path.basename(args[0]))
        ) {
          staged.resolve();
          await release.promise;
        }
      });
      const updating = records.replace("owner", revision, { state: "active" });
      await staged.promise;
      let finished = false;
      const inventory = records.inventory().finally(() => {
        finished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(finished).toBe(false);
      release.resolve();
      const next = await updating;
      expect(await inventory).toMatchObject([
        { signed: { revision: next, value: { state: "active" } } },
      ]);
      spy.mockRestore();
      await writeFile(
        path.join(records.directory, `${"a".repeat(64)}.${"b".repeat(32)}`),
        "retained staging",
        { mode: 0o600 },
      );
      await expect(records.inventory()).rejects.toThrow("partial/unknown");
    } finally {
      release.resolve();
      spy?.mockRestore();
      await app.close();
    }
  },
);
