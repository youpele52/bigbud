import { publicationFixture } from "./mobileOptionalPublication.test-fixtures.ts";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { mobilePublicationDirectoryKey } from "./mobileOptionalPublication.files.ts";
import { makeRemoteAgentRegistryStore } from "./remoteAgentInstall.registry.store.ts";
import { memoryRegistryCommand } from "./remoteAgentInstall.mobile.fixtures.ts";
import { revalidateMobileOptionalPublication } from "./mobileOptionalPublication.ts";

const fixtures: Awaited<ReturnType<typeof publicationFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = await publicationFixture();
  fixtures.push(f);
  await f.run((p) => p.publish(f.request));
  return f;
}
async function rekey(
  f: Awaited<ReturnType<typeof publicationFixture>>,
  host: undefined | { hostname: string; machineId: string | null },
) {
  const state = f.read();
  if (state.schemaVersion !== 3) throw Error("fixture v3 absent");
  const original = state.mobile.stages[0]!,
    { controllerHost: _recorded, ...legacy } = original;
  const stage = host ? { ...legacy, controllerHost: host } : legacy;
  const key = mobilePublicationDirectoryKey(f.pin, stage),
    parent = join(f.control.root, "components-v1"),
    path = join(parent, key);
  await fs.rename(join(parent, original.publicationIntent!.key), path);
  const info = await fs.lstat(path, { bigint: true });
  f.replaceState({
    ...state,
    mobile: {
      ...state.mobile,
      stages: [
        {
          ...stage,
          publicationIntent: { ...stage.publicationIntent!, key },
          publicationReceipt: {
            ...stage.publicationReceipt!,
            directoryMtimeNs: info.mtimeNs.toString(),
            directoryCtimeNs: info.ctimeNs.toString(),
          },
        },
      ],
    },
  });
}
it("new publication records actual host and same-owner legacy proofs remain usable", async () => {
  const f = await fixture(),
    state = f.read();
  if (state.schemaVersion !== 3) throw Error("fixture v3 absent");
  expect(state.mobile.stages[0]?.controllerHost).toEqual({
    hostname: f.owner().hostname,
    machineId: f.owner().machineId,
  });
  await rekey(f, undefined);
  await f.run(async (publisher) => {
    const token = await publisher.remint(f.request.stageId, 1);
    expect((await revalidateMobileOptionalPublication(token)).stageId).toBe(f.request.stageId);
  });
});
it("prior-controller remint refuses missing recorded host instead of substituting current host", async () => {
  const f = await fixture();
  await rekey(f, undefined);
  await f.restart(true);
  await expect(f.run((p) => p.remint(f.request.stageId, 1))).rejects.toMatchObject({
    cause: { message: expect.stringMatching(/missing-host|repair/) },
  });
});
it("prior-controller remint uses recorded host and refuses a foreign machine", async () => {
  const f = await fixture();
  await rekey(f, { hostname: "foreign-host", machineId: "machine-v1:foreign-host" });
  await f.restart(true);
  await expect(f.run((p) => p.remint(f.request.stageId, 1))).rejects.toMatchObject({
    cause: { message: expect.stringMatching(/foreign|repair/) },
  });
});
it("generic CAS cannot add, strip or replace immutable publication controller host", async () => {
  const f = await fixture(),
    state = f.read();
  if (state.schemaVersion !== 3) throw Error("fixture v3 absent");
  for (const host of [undefined, { hostname: "forged", machineId: null }]) {
    const store = makeRemoteAgentRegistryStore(f.control.root, memoryRegistryCommand(state));
    await expect(
      store.update((before) => {
        if (before.schemaVersion !== 3) throw Error("fixture v3 absent");
        const stages = before.mobile.stages.map((stage) => {
          const { controllerHost: _host, ...base } = stage;
          return host ? { ...base, controllerHost: host } : base;
        });
        return { ...before, revision: before.revision + 1, mobile: { ...before.mobile, stages } };
      }),
    ).rejects.toThrow(/identity/);
  }
});
