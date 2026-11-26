import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";

it("quarantines legacy record locks before the first record write", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const legacy = path.join(app.artifact.root, "record-locks", "a".repeat(64));
    await mkdir(legacy, { recursive: true, mode: 0o700 });
    await writeFile(path.join(legacy, ".bigbud-thread-tools-managed.lock"), "retained", {
      mode: 0o600,
    });
    const records = await V2ThreadRecords.open(
      app.artifact.root,
      "enrollments",
      app.artifact.privateKey,
      app.artifact.publicKey,
    );
    await expect(stat(path.join(app.artifact.root, "record-locks"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const stale = await readdir(path.join(app.artifact.root, "stale-record-locks"));
    expect(stale).toHaveLength(1);
    await expect(
      readFile(
        path.join(
          app.artifact.root,
          "stale-record-locks",
          stale[0]!,
          "a".repeat(64),
          ".bigbud-thread-tools-managed.lock",
        ),
        "utf8",
      ),
    ).resolves.toBe("retained");
    await records.replace("owner", undefined, { state: "pending" });
    await expect(stat(path.join(app.artifact.root, "record-locks"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await app.close();
  }
});

it("serializes same-key record writes inside one backend", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const records = await V2ThreadRecords.open(
      app.artifact.root,
      "enrollments",
      app.artifact.privateKey,
      app.artifact.publicKey,
    );
    const settled = await Promise.allSettled([
      records.replace("owner", undefined, { state: "first" }),
      records.replace("owner", undefined, { state: "second" }),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason.message : "").toContain(
      "successor preserved",
    );
    expect((await records.read("owner"))?.value).toEqual({ state: "first" });
  } finally {
    await app.close();
  }
});
