import os from "node:os";
import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { processStartToken } from "../../../utils/processStartToken.ts";
import { assertV2PreviousHistoryRetired } from "./Orchestration.enrollment.recovery.ts";
import { V2_DEAD_BACKEND_MESSAGES } from "./Orchestration.enrollment.deadBackend.ts";
import { writeV2OwnerMarker } from "./Orchestration.instances.ts";
import {
  withV2DeadBackendScenario,
  type V2DeadBackendScenario,
} from "./Orchestration.enrollment.restart.fixture.ts";

const TRANSPORT = "dead-backend-transport";
const USER_ERROR =
  "V2 previous owner retirement is not durably physically settled; no replacement or history replay.";

/** A refusal changes no enrollment record and creates no retirement evidence. */
async function expectRefused(scenario: V2DeadBackendScenario, message: string) {
  const before = await scenario.records.read(scenario.key);
  const context = (await scenario.recovery()).context(scenario.client, TRANSPORT)!;
  await expect(
    assertV2PreviousHistoryRetired(scenario.records, scenario.scope, context),
  ).rejects.toThrow(message);
  expect(await scenario.records.read(scenario.key)).toEqual(before);
  return (await (await scenario.records.sibling("retirements")).entries()).map(
    (entry) => (entry.value as { phase: string }).phase,
  );
}

it("an active native session left by a dead backend is refused with an actionable message", async () => {
  await withV2DeadBackendScenario(async (scenario) => {
    scenario.active[scenario.scope.nativeSessionId] = { type: "busy" };
    expect(await expectRefused(scenario, V2_DEAD_BACKEND_MESSAGES.nativeActive)).toEqual([]);
    expect(scenario.calls).toEqual([]);
    expect(V2_DEAD_BACKEND_MESSAGES.nativeActive).not.toMatch(
      /already active|ongoing provider work|cannot start another turn|unresolved turn/i,
    );
    // Once the native turn ends, the same thread recovers.
    delete scenario.active[scenario.scope.nativeSessionId];
    await assertV2PreviousHistoryRetired(
      scenario.records,
      scenario.scope,
      (await scenario.recovery()).context(scenario.client, TRANSPORT),
    );
  });
}, 60_000);

it("without the lock-holder context (tests, CLI, lockless readers) today's refusal is unchanged", async () => {
  await withV2DeadBackendScenario(async (scenario) => {
    await expect(assertV2PreviousHistoryRetired(scenario.records, scenario.scope)).rejects.toThrow(
      USER_ERROR,
    );
    expect(scenario.calls).toEqual([]);
  });
}, 60_000);

it("a lock that is released, replaced or unreadable disproves dead-backend authority", async () => {
  for (const tamper of ["release", "replace", "garble"] as const)
    await withV2DeadBackendScenario(async (scenario) => {
      if (tamper === "release") await scenario.lock.release();
      else
        await writeFile(
          scenario.lock.lockPath,
          tamper === "garble"
            ? "{"
            : JSON.stringify({ ...scenario.lock.record, nonce: "e".repeat(32) }),
        );
      expect(await expectRefused(scenario, V2_DEAD_BACKEND_MESSAGES.lockUnproved)).toEqual([]);
      expect(scenario.calls).toEqual([]);
    });
}, 120_000);

it("an attributed previous backend whose process is still alive is refused", async () => {
  await withV2DeadBackendScenario(async (scenario) => {
    await writeV2OwnerMarker(
      scenario.records,
      {
        nonce: "1".repeat(32),
        pid: process.pid,
        startedAt: processStartToken(process.pid) ?? null,
        hostname: os.hostname(),
      },
      scenario.digest,
      scenario.owner.enrollmentNonce,
    );
    await expectRefused(scenario, V2_DEAD_BACKEND_MESSAGES.ownerAlive(process.pid));
    expect(scenario.calls).toEqual([]);
  });
}, 60_000);

it("an owner attributed to this very backend instance keeps the original live-owner rule", async () => {
  await withV2DeadBackendScenario(async (scenario) => {
    await writeV2OwnerMarker(
      scenario.records,
      scenario.lock.record,
      scenario.digest,
      scenario.owner.enrollmentNonce,
    );
    await expectRefused(scenario, USER_ERROR);
    expect(scenario.calls).toEqual([]);
  });
}, 60_000);

it("a native detach or activity failure is refused without proof and is retried later", async () => {
  await withV2DeadBackendScenario(async (scenario) => {
    scenario.failing.add("detach");
    expect(await expectRefused(scenario, V2_DEAD_BACKEND_MESSAGES.nativeUnconfirmed)).toEqual([
      "retiring",
    ]);
    scenario.failing.clear();
    await assertV2PreviousHistoryRetired(
      scenario.records,
      scenario.scope,
      (await scenario.recovery()).context(scenario.client, TRANSPORT),
    );
    expect(scenario.calls).toEqual(["inspect", "detach", "inspect", "detach"]);
  });
  await withV2DeadBackendScenario(async (scenario) => {
    const client = scenario.client as unknown as { session: { active: () => Promise<unknown> } };
    client.session.active = async () => {
      throw new Error("synthetic activity failure");
    };
    expect(await expectRefused(scenario, V2_DEAD_BACKEND_MESSAGES.nativeUnconfirmed)).toEqual([]);
  });
}, 120_000);
