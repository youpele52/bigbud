import path from "node:path";
import { expect, it, vi } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import * as storage from "./Orchestration.storage.ts";
import { deferred } from "./Test.fixtures.ts";

it("cancels a queued record write before it starts", async () => {
  const app = await makeV2ThreadPluginFixture();
  const release = deferred<void>();
  const staged = deferred<void>();
  const write = storage.writeV2ThreadPrivateFile;
  let spy: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const records = await V2ThreadRecords.open(
      app.artifact.root,
      "enrollments",
      app.artifact.privateKey,
      app.artifact.publicKey,
    );
    spy = vi.spyOn(storage, "writeV2ThreadPrivateFile").mockImplementation(async (...args) => {
      await write(...args);
      if (path.dirname(args[0]) === records.directory) {
        staged.resolve();
        await release.promise;
      }
    });
    const first = records.replace("owner", undefined, { value: 1 });
    await staged.promise;
    const caller = new AbortController();
    const second = records.replace(
      "owner",
      undefined,
      { value: 2 },
      { signal: caller.signal, assertCurrent: () => {} },
    );
    caller.abort();
    await expect(second).rejects.toBeDefined();
    release.resolve();
    await first;
    expect((await records.read("owner"))?.value).toEqual({ value: 1 });
  } finally {
    release.resolve();
    spy?.mockRestore();
    await app.close();
  }
});
