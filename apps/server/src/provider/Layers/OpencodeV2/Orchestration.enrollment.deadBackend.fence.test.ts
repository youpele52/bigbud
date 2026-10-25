import { Effect, Logger, ServiceMap } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { makeBackendInstance } from "../../../startup/backendInstance.ts";
import { assertV2PreviousHistoryRetired } from "./Orchestration.enrollment.recovery.ts";
import {
  prepareV2DeadBackendRecovery,
  V2_DEAD_BACKEND_MESSAGES,
} from "./Orchestration.enrollment.deadBackend.ts";
import { withV2DeadBackendScenario } from "./Orchestration.enrollment.restart.fixture.ts";
import type { V2ThreadRecords } from "./Orchestration.records.ts";
import { bindV2SettlementLogServices } from "./Runtime.settlement.log.ts";

afterEach(() => bindV2SettlementLogServices(ServiceMap.empty()));

const captureServerLogs = async (messages: unknown[]) =>
  Effect.runPromise(
    Effect.gen(function* () {
      bindV2SettlementLogServices(yield* Effect.services());
    }).pipe(
      Effect.provide(
        Logger.layer([Logger.make(({ message }) => void messages.push(message))], {
          mergeWithExisting: false,
        }),
      ),
    ),
  );

it("a fence that cannot be written at the first open disables dead-backend recovery for the instance's lifetime", async () => {
  const messages: unknown[] = [];
  await captureServerLogs(messages);
  await withV2DeadBackendScenario(async (scenario) => {
    const broken = {
      sibling: async () => {
        throw Object.assign(new Error("EACCES: permission denied, open '/private/secret'"), {
          code: "EACCES",
        });
      },
    } as unknown as V2ThreadRecords;
    const first = await prepareV2DeadBackendRecovery({
      stateDir: scenario.app.root,
      instance: makeBackendInstance(scenario.lock, scenario.app.root),
      records: broken,
      privateKey: scenario.app.artifact.privateKey,
    });
    expect(first?.fence).toBeUndefined();
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(JSON.stringify(messages)).not.toContain("/private/secret");
    expect(messages[0]).toEqual([
      "OpenCode v2 dead-backend receipt fence could not be written; dead-backend recovery is disabled for this backend instance",
      { errorName: "Error", errorCode: "EACCES" },
    ]);

    // A reopen by the same backend instance never builds a late fence (it could capture this
    // instance's own reserved receipts); recovery stays disabled with an explicit refusal.
    const later = await scenario.recovery();
    expect(later.fence).toBeUndefined();
    expect(await (await scenario.records.sibling("instances")).entries()).toEqual([]);
    const before = await scenario.records.read(scenario.key);
    await expect(
      assertV2PreviousHistoryRetired(
        scenario.records,
        scenario.scope,
        later.context(scenario.client, "dead-backend-transport"),
      ),
    ).rejects.toThrow(V2_DEAD_BACKEND_MESSAGES.fenceUnavailable);
    expect(V2_DEAD_BACKEND_MESSAGES.fenceUnavailable).toMatch(/^V2 .*Nothing was replayed\.$/);
    expect(await scenario.records.read(scenario.key)).toEqual(before);
    expect(scenario.calls).toEqual([]);
    expect(await (await scenario.records.sibling("retirements")).entries()).toEqual([]);
  });
}, 60_000);
