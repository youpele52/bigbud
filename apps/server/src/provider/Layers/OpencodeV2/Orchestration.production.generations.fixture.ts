import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { ThreadId, MessageId } from "@bigbud/contracts/core/baseSchemas";
import { withV2ProductionThreadTools } from "./Orchestration.production.fixture.ts";
import { exportV2ThreadArtifact } from "./Orchestration.artifact.ts";
import { makeV2HtmlRegistrationFixture } from "./Orchestration.registration.legacy.fixture.ts";
import { v2ThreadImplementation } from "./Orchestration.implementation.ts";

type Listed = { ok: true; result: { limit: number; returnedCount: number } };
type BListed = { implementation: string; result: Listed };

async function snapshot(directory: string) {
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  return Promise.all(
    (manifest.hashes as [string, string][]).map(async ([name]) => {
      const file = path.join(directory, name),
        info = await lstat(file);
      return [
        name,
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
        info.ino,
        info.mtimeMs,
      ];
    }),
  );
}

/** Genuine A/B preparation, interpretation and completed duplicates through production crypto,
 * authenticated HTTP, dispatcher and SQLite. Native API is synthetic; this is not retail qualification. */
export async function runV2ProductionGenerationsFixture() {
  let report: Record<string, unknown> | undefined;
  await withV2ProductionThreadTools(
    async ({
      runtime,
      source,
      canonical,
      invoke,
      invokeFor,
      selectImplementation,
      artifact,
      http,
    }) => {
      const before = await snapshot(artifact.directory),
        nativeId = source.native.id;
      const input = { title: "Second canonical owner", task: "Synthetic independent task" };
      const created = (await invoke("create_thread", input, "completed-create-A")) as {
        result: { childThreadId: string };
      };
      const a = (await invoke("list_threads", {}, "completed-list-A")) as Listed;
      assert.equal(a.result.returnedCount, 2);
      await selectImplementation("v4");
      assert.deepEqual(await invoke("create_thread", input, "completed-create-A"), created);
      assert.deepEqual(await invoke("list_threads", {}, "completed-list-A"), a);
      assert.equal(canonical.dispatched.length, 1);
      const pinnedA = (await invoke("list_threads", {}, "new-call-pinned-A")) as Listed;
      assert.equal(pinnedA.result.returnedCount, 2);
      const childId = ThreadId.makeUnsafe(created.result.childThreadId);
      await runtime.start({
        threadId: childId,
        cwd: source.native.location.directory,
        modelSelection: canonical.selection,
        runtimeMode: "full-access",
      });
      await runtime.send({
        threadId: childId,
        input: "Synthetic B owner",
        requestMessageId: MessageId.makeUnsafe("input-B"),
      });
      const invokeB = invokeFor(runtime.get(childId));
      const b = (await invokeB("list_threads", {}, "completed-list-B")) as BListed;
      assert.equal(b.implementation, "bounded-list-v4");
      assert.equal(b.result.result.limit, 1);
      assert.equal(b.result.result.returnedCount, 1);
      assert.deepEqual(await invokeB("list_threads", {}, "completed-list-B"), b);
      await selectImplementation("v3");
      const pinnedB = (await invokeB("list_threads", {}, "new-call-pinned-B")) as BListed;
      assert.equal(pinnedB.implementation, "bounded-list-v4");
      assert.equal(pinnedB.result.result.returnedCount, 1);
      assert.equal((await canonical.run(canonical.engine.getReadModel())).threads.length, 2);
      assert.equal(source.native.id, nativeId);
      assert.equal(
        http.calls.filter((call) => call.pathname === "/api/session" && call.method === "POST")
          .length,
        2,
      );
      assert.deepEqual(await snapshot(artifact.directory), before);
      report = {
        fixture: "synthetic-native-production-http-sqlite",
        nativeQualified: false,
        aDigest: v2ThreadImplementation("v3").implementationDigest,
        bDigest: v2ThreadImplementation("v4").implementationDigest,
        bootstrapDigest: artifact.artifactDigest,
        canonicalCreates: canonical.dispatched.length,
        aReturnedCount: a.result.returnedCount,
        bReturnedCount: b.result.result.returnedCount,
        pinnedA: true,
        pinnedB: true,
        completedDuplicates: true,
        bootstrapBytesAndInodesUnchanged: true,
      };
    },
    "full-access",
    undefined,
    false,
    async (stateDir) => makeV2HtmlRegistrationFixture(await exportV2ThreadArtifact(stateDir)),
  );
  return report!;
}

/** Current preferred bootstrap must still use v5 and refuse an incompatible retained handler. */
export async function runV2ProductionCurrentFixture() {
  let report: Record<string, unknown> | undefined;
  await withV2ProductionThreadTools(async ({ artifact, invoke, selectImplementation }) => {
    assert.equal(artifact.bootstrapAbi, "bigbud.thread.bootstrap.v5");
    const before = await snapshot(artifact.directory);
    const listed = (await invoke("list_threads", {}, "current-list")) as Listed;
    assert.equal(listed.result.returnedCount, 1);
    await assert.rejects(selectImplementation("v4"), /incompatible/);
    assert.deepEqual(await invoke("list_threads", {}, "current-list"), listed);
    assert.deepEqual(await snapshot(artifact.directory), before);
    report = {
      bootstrapAbi: artifact.bootstrapAbi,
      incompatibleRollbackRejected: true,
      completedDuplicate: true,
    };
  });
  return report!;
}
