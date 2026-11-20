import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { mobileGatewayBuildPin } from "../remote-agent/mobileGatewayLifecycle.transitions.ts";
import { repairMobileRuntimeAssets } from "./mobileGatewayAssets.orphan.ts";
import { orphanFixture } from "./mobileGatewayAssets.orphan.test-fixture.ts";

const held = vi.hoisted(() => new Set<string>());
vi.mock("./mobileGatewayProcess.assets.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mobileGatewayProcess.assets.ts")>()),
  mobileGatewayAssetsPathHeld: (path: string) => held.has(path),
}));
const fixtures: Awaited<ReturnType<typeof orphanFixture>>[] = [];
afterEach(async () => {
  held.clear();
  for (const f of fixtures.splice(0)) await f.close();
});
async function fixture() {
  const f = await orphanFixture();
  fixtures.push(f);
  return f;
}
const repair = (f: Awaited<ReturnType<typeof orphanFixture>>) =>
  repairMobileRuntimeAssets(f.journal, new AbortController().signal);
const only = (generation: string, outcome: "removed" | "kept", reason: string) => ({
  removed: outcome === "removed" ? 1 : 0,
  kept: outcome === "kept" ? 1 : 0,
  entries: [{ generation, outcome, reason }],
});

it("removes a journal-proven orphan tree and its receipt, then is idempotent", async () => {
  const f = await fixture();
  const t = await f.tree();
  expect(await repair(f)).toEqual(only(t.generation, "removed", "proven-orphan"));
  expect(await f.exists(t.root)).toBe(false);
  expect(await f.exists(t.receipt)).toBe(false);
  expect(await f.exists(f.namespace)).toBe(true);
  expect(await repair(f)).toEqual({ removed: 0, kept: 0, entries: [] });
});

it("finishes a receipt left behind by an interrupted removal", async () => {
  const f = await fixture();
  const t = await f.tree();
  await fs.rm(t.root, { recursive: true });
  expect(await repair(f)).toEqual(only(t.generation, "removed", "receipt-only"));
  expect(await f.exists(t.receipt)).toBe(false);
});

it("keeps a tree whose base pin or current attempt still references it", async () => {
  const f = await fixture();
  const pinned = await f.tree();
  f.state.pins.push({ owner: mobileGatewayBuildPin(pinned.attempt.nonce), buildId: "b" });
  const current = await f.tree({ stageId: "stage-2", phase: "attempted" });
  const report = await repair(f);
  expect(report.removed).toBe(0);
  expect(report.entries).toEqual(
    expect.arrayContaining([
      { generation: pinned.generation, outcome: "kept", reason: "pinned" },
      { generation: current.generation, outcome: "kept", reason: "attempt-not-exited" },
    ]),
  );
  // A second attempt claiming the same generation is ambiguous, never a proof.
  f.state.pins.length = 0;
  f.state.mobile.gatewayLifecycle.attempts.push({ ...pinned.attempt, nonce: "duplicate" });
  expect((await repair(f)).entries).toContainEqual({
    generation: pinned.generation,
    outcome: "kept",
    reason: "ambiguous-journal",
  });
  for (const t of [pinned, current]) expect(await f.exists(t.root)).toBe(true);
});

it("keeps the active stage: an unresolved attempt or in-flight publication on it", async () => {
  const f = await fixture();
  const exited = await f.tree();
  await f.tree({ phase: "attempted" });
  expect((await repair(f)).entries).toContainEqual({
    generation: exited.generation,
    outcome: "kept",
    reason: "active-stage",
  });
  f.state.mobile.gatewayLifecycle.attempts.pop();
  f.state.mobile.stages[0]!.phase = "publication-writing";
  expect((await repair(f)).entries).toContainEqual({
    generation: exited.generation,
    outcome: "kept",
    reason: "active-stage",
  });
  held.add(exited.root);
  f.state.mobile.stages[0]!.phase = "files-published";
  expect((await repair(f)).entries).toContainEqual({
    generation: exited.generation,
    outcome: "kept",
    reason: "in-use",
  });
  expect(await f.exists(exited.root)).toBe(true);
});

it("keeps trees with mismatched identity, ownership, receipt or journal owner", async () => {
  const f = await fixture();
  const moved = await f.tree();
  // Same bytes in a new inode: the recorded dev/inode no longer matches.
  await fs.rename(moved.root, `${f.stateDir}/aside`);
  await fs.cp(`${f.stateDir}/aside`, moved.root, { recursive: true });
  const foreign = await f.tree();
  Object.assign(foreign.attempt, { controller: { ...foreign.attempt.controller, pid: 9 } });
  const renonced = await f.tree();
  Object.assign(renonced.attempt, { nonce: "another-preparation" });
  const tampered = await f.tree();
  await fs.appendFile(tampered.receipt, " ");
  const report = await repair(f);
  expect(report.removed).toBe(0);
  expect(report.entries).toEqual(
    expect.arrayContaining([
      { generation: moved.generation, outcome: "kept", reason: "identity-mismatch" },
      { generation: foreign.generation, outcome: "kept", reason: "ownership-mismatch" },
      { generation: renonced.generation, outcome: "kept", reason: "ownership-mismatch" },
      { generation: tampered.generation, outcome: "kept", reason: "receipt-mismatch" },
    ]),
  );
  f.state.mobile.owner = {
    ...f.state.mobile.owner,
    installationFingerprint: `sha256:${"f".repeat(64)}`,
  };
  expect(new Set((await repair(f)).entries.map((e) => e.reason))).toEqual(
    new Set(["journal-owner-mismatch"]),
  );
  for (const t of [moved, foreign, renonced, tampered]) expect(await f.exists(t.root)).toBe(true);
});

it("never follows a planted symlink and keeps changed trees and unknown entries", async () => {
  const f = await fixture();
  const outside = join(f.stateDir, "outside.txt");
  await fs.writeFile(outside, "keep me", { mode: 0o600 });
  const linked = await f.tree();
  await fs.symlink(outside, join(linked.root, "static", "link.js"));
  const extra = await f.tree();
  await fs.writeFile(join(extra.root, "late.txt"), "x", { mode: 0o600 });
  const rewritten = await f.tree();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await fs.writeFile(join(rewritten.root, "index.html"), "<html>!!</html>"); // same member count
  const swapped = await f.tree();
  await fs.rm(swapped.root, { recursive: true });
  await fs.symlink(join(f.stateDir), swapped.root);
  await fs.writeFile(join(f.namespace, "stray"), "x", { mode: 0o600 });
  const report = await repair(f);
  expect(report.removed).toBe(0);
  expect(report.entries).toEqual(
    expect.arrayContaining([
      { generation: linked.generation, outcome: "kept", reason: "tree-changed" },
      { generation: extra.generation, outcome: "kept", reason: "tree-changed" },
      { generation: rewritten.generation, outcome: "kept", reason: "tree-changed" },
      { generation: swapped.generation, outcome: "kept", reason: "not-a-directory" },
      { generation: "unknown", outcome: "kept", reason: "unknown-entry" },
    ]),
  );
  expect(await fs.readFile(outside, "utf8")).toBe("keep me");
  expect(await f.exists(join(linked.root, "index.html"))).toBe(true);
  expect(await f.exists(join(f.stateDir, "outside.txt"))).toBe(true);
  // Kept work is stable: a second run changes nothing and reports the same.
  expect(await repair(f)).toEqual(report);
});

it("treats journal failures as uncertainty and does nothing without a namespace", async () => {
  const f = await fixture();
  const t = await f.tree();
  f.failReads(Error("journal unavailable"));
  expect(await repair(f)).toEqual(only(t.generation, "kept", "uncertain"));
  expect(await f.exists(t.root)).toBe(true);
  f.failReads(undefined);
  await fs.rm(f.namespace, { recursive: true });
  expect(await repair(f)).toEqual({ removed: 0, kept: 0, entries: [] });
});
