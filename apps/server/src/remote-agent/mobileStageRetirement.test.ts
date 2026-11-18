import * as fs from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { MOBILE_GATEWAY_RUNTIME_NAMESPACE } from "../remote-backend/mobileGatewayAssets.receipt.reference.ts";
import { publicationWiring } from "./mobileOptionalPublication.test-fixtures.ts";
import { MAX_MOBILE_REGISTRY_STAGES } from "./remoteAgentInstall.mobile.schema.ts";
import { retirementFixture } from "./mobileStageRetirement.test-fixture.ts";

const entry = (stageId: string, outcome: "retired" | "kept", reason: string) => ({
  stageId,
  outcome,
  reason,
});

it("runs 24 revoke/re-grant activation cycles with a bounded journal and namespace", async () => {
  const r = await retirementFixture();
  const cycles = 24;
  for (let cycle = 0; cycle < cycles; cycle++) {
    const stageId = await r.publish();
    await r.select(stageId);
    await r.settle(await r.original(stageId));
    await r.regrant();
    const mobile = r.mobile();
    // Previous desired stage plus the one just published, never more.
    expect(mobile.stages.length).toBeLessThanOrEqual(2);
    expect(mobile.gatewayLifecycle!.attempts.length).toBeLessThanOrEqual(2);
    expect((mobile.desiredHistory ?? []).length).toBeLessThanOrEqual(1);
    expect(mobile.releases).toHaveLength(1);
    expect((await r.published()).length).toBeLessThanOrEqual(2);
  }
  const mobile = r.mobile();
  expect(mobile.consent.revision).toBe(1 + 2 * cycles);
  expect(mobile.retired).toEqual({
    stages: cycles - 2,
    revisionFloor: 1 + 2 * (cycles - 3),
    selections: cycles - 2,
    attempts: cycles - 2,
  });
  expect(cycles).toBeGreaterThan(MAX_MOBILE_REGISTRY_STAGES);
  // The next cycle still publishes, selects and launches: consent cycles are unlimited.
  const next = await r.publish();
  expect(next).toBe(`publication-fixture.r${mobile.consent.revision}`);
  await r.select(next);
  expect(r.mobile().desired!.revision).toBe(cycles + 1);
});

it("never retires the desired stage, the current stage or a live original's stage", async () => {
  const r = await retirementFixture();
  const first = await r.publish();
  await r.select(first);
  const live = await r.original(first, "attempted");
  await r.regrant();
  // Revoked consent fences the live original; it stays pinned and unsettled until exit.
  const report = await r.retire();
  expect(report.entries).toEqual([entry(first, "kept", "desired")]);
  const second = await r.publish();
  // Desired moves only through a selection, which itself needs settled children.
  await expect(r.select(second)).rejects.toThrow(/prior child cleanup/);
  expect((await r.retire()).entries).toEqual(
    expect.arrayContaining([
      entry(first, "kept", "desired"),
      entry(second, "kept", "current-consent"),
    ]),
  );
  expect(await r.exists(r.directory(first))).toBe(true);
  // Exit recorded: still the desired stage, so it stays until a newer selection replaces it.
  await r.settle(live);
  await r.select(second);
  await r.regrant();
  const third = await r.publish();
  const state = r.mobile();
  expect(state.stages.map((s) => s.id)).toEqual([second, third]);
  expect(state.retired?.stages).toBe(1);
});

it("keeps an unsettled original's stage even when nothing selects it", async () => {
  const r = await retirementFixture();
  const first = await r.publish();
  await r.select(first);
  await r.regrant();
  // An original launched on a stage that never became desired, then consent moved on twice.
  const second = await r.publish();
  const live = await r.original(second, "attempted");
  await r.regrant();
  await r.regrant();
  const keptLive = await r.retire();
  expect(keptLive.entries).toEqual(
    expect.arrayContaining([
      entry(first, "kept", "desired"),
      entry(second, "kept", "unsettled-attempt"),
    ]),
  );
  expect(await r.exists(r.directory(second))).toBe(true);
  // Exit recorded (or epoch ended): the old original is settled and its stage retires.
  await r.settle(live);
  expect((await r.retire()).entries).toEqual(
    expect.arrayContaining([entry(first, "kept", "desired"), entry(second, "retired", "retired")]),
  );
  expect(r.mobile().gatewayLifecycle!.attempts).toEqual([]);
  expect(r.mobile().retired).toMatchObject({ stages: 1, attempts: 1, selections: 0 });
});

it("waits for the orphan GC to remove an original's runtime tree before retiring its stage", async () => {
  const r = await retirementFixture();
  const first = await r.publish();
  await r.select(first);
  const original = await r.original(first);
  await r.settle(original);
  await r.regrant();
  await r.select(await r.publish());
  const runtime = join(r.f.stateDir, MOBILE_GATEWAY_RUNTIME_NAMESPACE);
  const receipt = join(runtime, `${original.assetsReference.generation}.receipt.json`);
  await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
  await fs.writeFile(receipt, "{}", { mode: 0o600 });
  expect((await r.retire()).entries).toContainEqual(entry(first, "kept", "runtime-assets-present"));
  expect(await r.exists(r.directory(first))).toBe(true);
  await fs.unlink(receipt);
  expect((await r.retire()).entries).toContainEqual(entry(first, "retired", "retired"));
});

it("is crash-safe and idempotent around file removal and the journal CAS", async () => {
  const r = await retirementFixture();
  const first = await r.publish();
  await r.select(first);
  await r.settle(await r.original(first));
  await r.regrant();
  await r.select(await r.publish());
  const directory = r.directory(first);
  // Crash mid-removal: one component already unlinked.
  await fs.unlink(join(directory, "gateway"));
  // Crash after the files went but before the rows: the CAS never lands.
  publicationWiring.before = async (script) => {
    if (script.includes("printf committed")) throw Error("simulated crash before CAS");
  };
  const crashed = await r.retire().finally(() => {
    publicationWiring.before = undefined;
  });
  expect(crashed.entries).toContainEqual(entry(first, "kept", "journal-changed"));
  expect(await r.exists(directory)).toBe(false);
  expect(r.mobile().stages.some((s) => s.id === first)).toBe(true);
  // Restart: absent files count as removed; the rows retire exactly once.
  expect((await r.retire()).entries).toContainEqual(entry(first, "retired", "retired"));
  const settled = r.f.read();
  const again = await r.retire();
  expect(again.retired).toBe(0);
  expect(r.f.read()).toEqual(settled);
});

it("preserves a foreign member in a retired stage's directory and keeps the stage", async () => {
  const r = await retirementFixture();
  const first = await r.publish();
  await r.select(first);
  await r.settle(await r.original(first));
  await r.regrant();
  await r.select(await r.publish());
  const foreign = join(r.directory(first), "foreign");
  await fs.writeFile(foreign, "keep me", { mode: 0o600 });
  expect((await r.retire()).entries).toContainEqual(entry(first, "kept", "publication-foreign"));
  expect(await fs.readFile(foreign, "utf8")).toBe("keep me");
  expect(await r.exists(join(r.directory(first), "gateway"))).toBe(true);
});
