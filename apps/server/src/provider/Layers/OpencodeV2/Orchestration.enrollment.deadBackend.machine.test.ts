import os from "node:os";
import { expect, it } from "vitest";
import { machineIdentity } from "../../../utils/machineIdentity.ts";
import { assertV2PreviousHistoryRetired } from "./Orchestration.enrollment.recovery.ts";
import { V2_DEAD_BACKEND_MESSAGES } from "./Orchestration.enrollment.deadBackend.ts";
import { readV2OwnerMarker, writeV2OwnerMarker } from "./Orchestration.instances.ts";
import {
  withV2DeadBackendScenario,
  type V2DeadBackendScenario,
} from "./Orchestration.enrollment.restart.fixture.ts";

const TRANSPORT = "dead-backend-transport";
const OTHER_MACHINE = `machine-v1:${"0".repeat(64)}`;
const attribute = (
  scenario: V2DeadBackendScenario,
  host: { hostname: string; machineId?: string | null },
) =>
  writeV2OwnerMarker(
    scenario.records,
    { nonce: scenario.backendA.nonce, pid: scenario.backendA.pid, startedAt: null, ...host },
    scenario.digest,
    scenario.owner.enrollmentNonce,
  );
const recover = async (scenario: V2DeadBackendScenario) =>
  assertV2PreviousHistoryRetired(
    scenario.records,
    scenario.scope,
    (await scenario.recovery()).context(scenario.client, TRANSPORT),
  );

it.skipIf(machineIdentity() === null)(
  "a dead owner attributed on this machine under another hostname is recovered",
  async () => {
    await withV2DeadBackendScenario(async (scenario) => {
      await attribute(scenario, { hostname: "renamed-host", machineId: machineIdentity() });
      expect((await readV2OwnerMarker(scenario.records, scenario.digest))?.machineId).toBe(
        machineIdentity(),
      );
      await recover(scenario);
      expect(scenario.calls).toEqual(["inspect", "detach"]);
    });
  },
  60_000,
);

it("an owner attributed to another machine, or an id-less owner under another hostname, is refused naming both hosts", async () => {
  for (const host of [
    { hostname: os.hostname(), machineId: OTHER_MACHINE },
    { hostname: "renamed-host" },
  ])
    await withV2DeadBackendScenario(async (scenario) => {
      await attribute(scenario, host);
      const before = await scenario.records.read(scenario.key);
      await expect(recover(scenario)).rejects.toThrow(
        V2_DEAD_BACKEND_MESSAGES.ownerOtherHost(host.hostname, os.hostname()),
      );
      expect(await scenario.records.read(scenario.key)).toEqual(before);
      expect(scenario.calls).toEqual([]);
    });
}, 120_000);
