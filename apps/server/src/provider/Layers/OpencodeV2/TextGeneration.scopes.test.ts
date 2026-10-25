import { expect, it } from "vitest";
import {
  makeTextGenerationHttpFixture,
  textGenerationSelection,
} from "./TextGeneration.fixture.ts";
import {
  makeV2AuxiliaryTextGenerator,
  type V2TextGenerationConnection,
} from "./TextGeneration.native.ts";
import { makeV2TextGenerationAdmission } from "./TextGeneration.admission.ts";

const request = () => ({
  directory: "/fixture",
  operation: "generateThreadTitle",
  prompt: "Metadata only",
  selection: textGenerationSelection,
  signal: new AbortController().signal,
});
const connection = async (
  fixture: ReturnType<typeof makeTextGenerationHttpFixture>,
  scope: string,
  generation = "generation-1",
) => ({
  ...(await fixture.connect()),
  storageIdentity: scope,
  descriptor: {
    storageIdentity: scope,
    registrationFile: `/synthetic/${scope}/service.json`,
    generation,
  },
});

async function retained(fixture: ReturnType<typeof makeTextGenerationHttpFixture>, scope: string) {
  fixture.options.failGenerate = true;
  await expect(
    makeV2AuxiliaryTextGenerator({ connect: () => connection(fixture, scope) })(request()),
  ).rejects.toMatchObject({ _tag: "V2TextGenerationUncertain" });
  fixture.options.failGenerate = false;
}

it("warm A cannot hide B's retained work, and returning to A cannot release B's unresolved reservation", async () => {
  const a = makeTextGenerationHttpFixture(),
    b = makeTextGenerationHttpFixture();
  await retained(b, "storage-b");
  let active = "a";
  const run = makeV2AuxiliaryTextGenerator({
    maxConcurrent: 1,
    connect: () => (active === "a" ? connection(a, "storage-a") : connection(b, "storage-b")),
  });
  await run(request());
  active = "b";
  await expect(run(request())).rejects.toThrow("capacity");
  active = "a";
  await expect(run(request())).rejects.toThrow("capacity");
  expect(b.sessions.size).toBe(1);
  expect(b.requests.filter(({ pathname }) => pathname.endsWith("/generate"))).toHaveLength(1);
});

it("A -> B -> A keeps the old B job counted once across generation changes and registration aliases", async () => {
  const a = makeTextGenerationHttpFixture(),
    b = makeTextGenerationHttpFixture();
  await retained(b, "storage-b");
  let active = "a",
    generation = "generation-1",
    scope = "storage-b";
  const run = makeV2AuxiliaryTextGenerator({
    maxConcurrent: 2,
    connect: () => (active === "a" ? connection(a, "storage-a") : connection(b, scope, generation)),
  });
  await run(request());
  active = "b";
  await run(request());
  active = "a";
  await run(request());
  active = "b";
  generation = "generation-2";
  await run(request());
  scope = "registration-alias";
  await run(request());
  expect(b.sessions.size).toBe(1);
  expect(a.sessions.size).toBe(0);
  expect(b.requests.filter(({ pathname }) => pathname.endsWith("/generate"))).toHaveLength(4);
});

it("a failed scoped inventory does not poison the next connection or a later retry in its original scope", async () => {
  const a = makeTextGenerationHttpFixture(),
    b = makeTextGenerationHttpFixture();
  const original = a.client.session.list;
  a.client.session.list = async () => {
    throw new Error("Synthetic unavailable inventory");
  };
  let active = "a";
  const run = makeV2AuxiliaryTextGenerator({
    maxConcurrent: 1,
    connect: () => (active === "a" ? connection(a, "storage-a") : connection(b, "storage-b")),
  });
  await expect(run(request())).rejects.toThrow();
  active = "b";
  await run(request());
  a.client.session.list = original;
  active = "a";
  await run(request());
  expect(a.sessions.size + b.sessions.size).toBe(0);
});

it("missing verified connection provenance cannot authorize native work", async () => {
  const fixture = makeTextGenerationHttpFixture();
  const run = makeV2AuxiliaryTextGenerator({
    connect: async () =>
      ({
        client: fixture.client,
        storageIdentity: "unverified",
        close: async () => {},
      }) as V2TextGenerationConnection,
  });
  await expect(run(request())).rejects.toThrow("provenance");
  expect(fixture.requests.some(({ method }) => method === "POST")).toBe(false);
});

it("a stale inventory cannot resurrect a job proven settled while its read was in flight", async () => {
  const fixture = makeTextGenerationHttpFixture();
  const conn = await connection(fixture, "storage-a");
  let finish!: (value: Awaited<ReturnType<typeof fixture.client.session.list>>) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  fixture.client.session.list = () =>
    new Promise((resolve) => {
      finish = resolve;
      entered();
    });
  const admission = makeV2TextGenerationAdmission(2),
    owned = admission.reserve("owned-job");
  const read = admission.reconcile(conn, new AbortController().signal, "owned-job");
  await started;
  owned.release(true);
  finish({
    data: [
      {
        id: "owned-job",
        metadata: { bigbud_provider: "opencodeV2", bigbud_workload: "text-generation" },
      },
    ] as never,
    cursor: { next: null },
  });
  await read;
  expect(admission.occupied()).toBe(0);
});

it("settlement in A cannot release an unproven observation of the same ID in B", async () => {
  const a = makeTextGenerationHttpFixture(),
    b = makeTextGenerationHttpFixture();
  const admission = makeV2TextGenerationAdmission(3);
  const original = admission.reserve("owned-job");
  await admission.reconcile(
    await connection(a, "storage-a"),
    new AbortController().signal,
    "owned-job",
  );
  b.sessions.set("owned-job", {
    id: "owned-job",
    metadata: {
      bigbud_provider: "opencodeV2",
      bigbud_workload: "text-generation",
      bigbud_storage: "storage-a",
    },
  } as never);
  const reader = admission.reserve("reader-b");
  await admission.reconcile(
    await connection(b, "storage-b"),
    new AbortController().signal,
    "reader-b",
  );
  reader.release();
  original.release(true);
  expect(admission.occupied()).toBe(1);
  const next = admission.reserve("reader-next-generation");
  await admission.reconcile(
    await connection(b, "storage-b", "next-generation"),
    new AbortController().signal,
    "reader-next-generation",
  );
  next.release();
  expect(admission.occupied()).toBe(1);
});
