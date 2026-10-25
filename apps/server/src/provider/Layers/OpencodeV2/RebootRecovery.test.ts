import { expect, it } from "vitest";
import { withRebootRecoveryFixture } from "./RebootRecovery.fixture.ts";
import { applyV2RebootRecovery, prepareV2RebootRecovery } from "./RebootRecovery.ts";
import { V2ThreadReceipts } from "./Orchestration.receipts.ts";
import { assertV2PluginUpgradeIdle } from "./PluginSetup.upgrade.ts";

it("same-boot preparation never releases owners or makes a reserved receipt replayable", async () => {
  await withRebootRecoveryFixture(async (f) => {
    await prepareV2RebootRecovery(f.prepare);
    await expect(applyV2RebootRecovery(f.apply)).rejects.toThrow("same boot");
    await expect(assertV2PluginUpgradeIdle(f.artifact)).rejects.toThrow("retirement");
    expect(await new V2ThreadReceipts(f.receipts).unsettledCount()).toBe(1);
  });
});

it("new boot retires only captured owners, preserves uncertain receipts, and retries idempotently", async () => {
  await withRebootRecoveryFixture(async (f) => {
    await prepareV2RebootRecovery(f.prepare);
    f.reboot();
    await applyV2RebootRecovery(f.apply);
    await applyV2RebootRecovery(f.apply);
    await expect(assertV2PluginUpgradeIdle(f.artifact)).resolves.toBeUndefined();
    expect(await f.receipts.read("call")).toEqual(f.originalReceipt);
    const receipts = new V2ThreadReceipts(f.receipts);
    expect(await receipts.unsettledCount()).toBe(1);
    expect(await receipts.retirementEvidence()).toMatchObject({
      receiptsSettled: false,
      rebootReceiptCheckpointDigest: expect.any(String),
    });
    let dispatched = false;
    await expect(
      receipts.run("call", "fingerprint", async () => {
        dispatched = true;
        return { content: "never" };
      }),
    ).rejects.toThrow("uncertain");
    expect(dispatched).toBe(false);
    const other = { ...f.legacy, enrollmentNonce: "c".repeat(32), threadId: "other" };
    await f.addOwner(other);
    await expect(assertV2PluginUpgradeIdle(f.artifact)).rejects.toThrow("retirement");
  });
});

it.each(["owner", "receipt", "journal", "host", "activity"] as const)(
  "rejects changed %s evidence without releasing ownership",
  async (scenario) => {
    await withRebootRecoveryFixture(async (f) => {
      await prepareV2RebootRecovery(f.prepare);
      f.reboot();
      await f.change(scenario);
      await expect(applyV2RebootRecovery(f.apply)).rejects.toThrow();
      await expect(assertV2PluginUpgradeIdle(f.artifact)).rejects.toThrow("retirement");
    });
  },
);

it("a crash before the final group seal cannot leave partially usable retirement evidence", async () => {
  await withRebootRecoveryFixture(async (f) => {
    await prepareV2RebootRecovery(f.prepare);
    f.reboot();
    f.failBeforeSeal();
    await expect(applyV2RebootRecovery(f.apply)).rejects.toThrow("simulated crash");
    await expect(assertV2PluginUpgradeIdle(f.artifact)).rejects.toThrow("retirement");
    f.resume();
    await applyV2RebootRecovery(f.apply);
    await expect(assertV2PluginUpgradeIdle(f.artifact)).resolves.toBeUndefined();
  });
});
