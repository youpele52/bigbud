import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { requestBackendDrain } from "../startup/backendDrain.client.ts";
import { backendDrainExitCode } from "../startup/backendDrain.protocol.ts";
import { startBackendDrainControlServer } from "../startup/backendDrain.server.ts";

const roots: string[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];
const token = "c".repeat(64);

async function endpoint(
  status: "drained" | "consent-required" | "cancelled" | "timeout" | "unknown-artifact",
) {
  const stateDir = await mkdtemp("/tmp/bbdrain-prod-");
  roots.push(stateDir);
  const seen: Array<{ consent: string; marker: boolean }> = [];
  const server = await startBackendDrainControlServer({
    stateDir,
    token,
    handle: async (request) => {
      seen.push({ consent: request.consent, marker: status === "drained" });
      return { v: 1, ok: true, status };
    },
  });
  servers.push(server);
  return { stateDir, seen };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("backend stop --for-upgrade production path", () => {
  it("reaches the running backend endpoint and drains with explicit saved-work consent", async () => {
    const { stateDir, seen } = await endpoint("drained");
    const response = await requestBackendDrain({
      stateDir,
      artifactId: "bigbud-server@1.0.0",
      consent: "non-interactive",
    });
    expect(response).toEqual({ v: 1, ok: true, status: "drained" });
    expect(seen).toEqual([{ consent: "non-interactive", marker: true }]);
  });

  it("requires UI consent without the explicit flag and writes no marker", async () => {
    const { stateDir, seen } = await endpoint("consent-required");
    const response = await requestBackendDrain({
      stateDir,
      artifactId: "bigbud-server@1.0.0",
      consent: "ui",
    });
    expect(response).toMatchObject({ status: "consent-required" });
    expect(seen).toEqual([{ consent: "ui", marker: false }]);
  });

  it.each([
    ["cancelled", 5],
    ["timeout", 6],
    ["unknown-artifact", 4],
  ] as const)("maps %s to a distinct non-zero exit without a marker", async (status, exit) => {
    const { stateDir, seen } = await endpoint(status);
    const response = await requestBackendDrain({
      stateDir,
      artifactId: "bigbud-server@1.0.0",
      consent: "non-interactive",
    });
    expect(response).toMatchObject({ status });
    if (response.ok) expect(backendDrainExitCode(response.status)).toBe(exit);
    expect(seen[0]?.marker).toBe(false);
  });
});

describe("peer follower drain", () => {
  it("drains through the coordinator and refuses a partial or unreachable set", async () => {
    const { requestFollowerDrain } = await import("./cli.backend.drain.ts");
    await expect(requestFollowerDrain(2, async () => 2)).resolves.toEqual({
      kind: "drain-through-coordinator",
      followers: 2,
    });
    await expect(requestFollowerDrain(2, async () => 1)).resolves.toMatchObject({
      kind: "refuse",
    });
    await expect(
      requestFollowerDrain(2, async () => Promise.reject(new Error("down"))),
    ).resolves.toMatchObject({ kind: "refuse", error: { reason: "unavailable" } });
  });
});

describe("offline drain rule", () => {
  it("drains offline only with proof of no live panes", async () => {
    const { planOfflineDrain } = await import("./cli.backend.drain.ts");
    expect(planOfflineDrain(0)).toEqual({ kind: "drain" });
    expect(planOfflineDrain(1)).toMatchObject({
      kind: "refuse",
      error: { reason: "offline-panes-unknown" },
    });
    expect(planOfflineDrain(-1)).toMatchObject({ kind: "refuse" });
  });
});
