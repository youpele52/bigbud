import { expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { withRebootRecoveryFixture } from "./RebootRecovery.fixture.ts";
import { prepareV2RebootRecovery } from "./RebootRecovery.ts";
import { recoverV2RebootForSetup } from "./RebootRecovery.setup.ts";
import { makeV2ActivationJobsFixture } from "./PluginSetup.activation.jobs.fixture.ts";
import { V2ThreadToolsActivation } from "./PluginSetup.activation.ts";
import * as Activity from "./PluginSetup.activity.ts";
import { runV2RequestContext } from "./Client.guard.ts";
import type { V2ActivationJobScope } from "./PluginSetup.activation.jobs.ts";
import type { OpencodeV2Client } from "./Client.ts";
import { assertV2PluginUpgradeIdle } from "./PluginSetup.upgrade.ts";

it.each(["same-boot", "missing-consent", "missing-journal", "busy-native", "idle"] as const)(
  "consent-gated setup handles %s without issuing native mutation or model work",
  async (scenario) => {
    await withRebootRecoveryFixture(async (f) => {
      await prepareV2RebootRecovery(f.prepare);
      if (scenario !== "same-boot") f.reboot();
      const fixture = await makeV2ActivationJobsFixture();
      const activation = new V2ThreadToolsActivation(fixture.settings);
      const permit = activation.consent.capture();
      const descriptor = {
        registrationFile: "owned-test",
        generation: "new-boot-generation",
      } as V2ActivationJobScope["descriptor"];
      const journal = await f.apply.readJournal();
      const sql = {
        unsafe: (query: string) =>
          Effect.succeed(
            query.includes("provider_turn_admissions") ? journal.admissions : journal.bindings,
          ),
      } as unknown as SqlClient.SqlClient;
      const activity = vi.spyOn(Activity, "readV2NativeActivity").mockResolvedValue({
        foregroundCount: scenario === "busy-native" ? 1 : 0,
        runningShellCount: 0,
        directories: ["/owned-location"],
      });
      const requestSetup = vi.spyOn(activation, "requestSetup");
      const run = () =>
        recoverV2RebootForSetup({
          artifact: f.artifact,
          activation,
          descriptor,
          client: {} as OpencodeV2Client,
          sql: scenario === "missing-journal" ? undefined : sql,
          signal: permit.signal,
        });
      try {
        const pending =
          scenario === "missing-consent"
            ? run()
            : runV2RequestContext({ transport: "owned-test", intent: "execute", permit }, run);
        if (scenario === "idle") {
          await pending;
          await expect(assertV2PluginUpgradeIdle(f.artifact)).resolves.toBeUndefined();
          expect(activity).toHaveBeenCalledTimes(2);
        } else {
          await expect(pending).rejects.toThrow();
          expect(await (await f.enrollments.sibling("retirements")).entries()).toEqual([]);
        }
        // Publication is still the next, normal managed setup transaction, never this recovery helper.
        expect(requestSetup).not.toHaveBeenCalled();
        expect(await f.receipts.read("call")).toEqual(f.originalReceipt);
      } finally {
        permit.release();
        await activation.close();
        fixture.consent.close();
        activity.mockRestore();
      }
    });
  },
);
