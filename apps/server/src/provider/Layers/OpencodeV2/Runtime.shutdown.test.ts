import { expect, it, vi } from "vitest";
import { withV2ProductionThreadTools } from "./Orchestration.production.fixture.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { settleWithinShutdown, V2_THREAD_TOOLS_SHUTDOWN_MS } from "./Runtime.shutdown.ts";

type Signer = { root: string; privateKey: string; publicKey: string };
const store = (artifact: unknown, name: "retirements" | "enrollments") => {
  const signer = artifact as Signer;
  return V2ThreadRecords.open(signer.root, name, signer.privateKey, signer.publicKey);
};
const phases = async (artifact: unknown) =>
  (await (await store(artifact, "retirements")).entries()).map(
    (entry) => (entry.value as { phase: string }).phase,
  );
const states = async (artifact: unknown) =>
  (await (await store(artifact, "enrollments")).entries()).map(
    (entry) => (entry.value as { state: string }).state,
  );

it("runtime close detaches an idle thread-tools owner with its normal proof", async () => {
  await withV2ProductionThreadTools(async ({ runtime, source, http, artifact }) => {
    http.complete(source.native.id);
    await runtime.authorized(() => runtime.reconcile(source));
    expect(await phases(artifact)).toEqual([]);
    await runtime.close();
    expect(await phases(artifact)).toEqual(["settled"]);
  });
}, 60_000);

it("a hung native detach cannot hold shutdown beyond the bound and leaves recoverable records", async () => {
  await withV2ProductionThreadTools(async ({ runtime, source, http, artifact }) => {
    http.complete(source.native.id);
    await runtime.authorized(() => runtime.reconcile(source));
    let release!: () => void;
    const hung = new Promise<never>((_, reject) => {
      release = () => reject(new Error("released after assertions"));
    });
    hung.catch(() => {});
    const rpc = http.client.rpc.call.bind(http.client.rpc);
    const spy = vi
      .spyOn(http.client.rpc, "call")
      .mockImplementation((input, options) =>
        input.method === "inspect" ? hung : rpc(input, options),
      );
    try {
      const started = Date.now();
      await expect(runtime.close()).resolves.toBeUndefined();
      expect(Date.now() - started).toBeLessThan(V2_THREAD_TOOLS_SHUTDOWN_MS + 3000);
      expect(await phases(artifact)).toEqual(["retiring"]);
      expect(await states(artifact)).toEqual(["revoked"]);
    } finally {
      release();
      spy.mockRestore();
    }
  });
}, 60_000);

it("a busy owner at shutdown is never settled by an unproved retirement", async () => {
  await withV2ProductionThreadTools(async ({ runtime, artifact }) => {
    // The fixture's turn is still running: physical/admission settlement is unproved.
    await expect(runtime.close()).resolves.toBeUndefined();
    const left = await phases(artifact);
    // Native detach is acknowledged but settlement is unproved; the successor's dead-backend
    // recovery (Orchestration.enrollment.restart.test.ts) completes it.
    expect(left).toEqual(["detach-acknowledged"]);
    expect(await states(artifact)).toEqual(["revoked"]);
  });
}, 60_000);

it("a retirement that fails after the shutdown bound expired is never an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", record);
  try {
    // An owner whose teardown starts after the shared 5 s bound gets an already-aborted signal.
    const expired = AbortSignal.abort(new Error("shutdown bound expired"));
    const late = Promise.reject(new Error("detach aborted after the bound"));
    await expect(settleWithinShutdown(late, expired)).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", record);
  }
});
