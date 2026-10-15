import { expect, it } from "vitest";
import { captureV2OperationAuthority } from "./Client.guard.ts";
import { verifyV2NativeEligibility } from "./NativeCompatibility.runtime.ts";
import { withV2RuntimeWarningFixture } from "./NativeCompatibility.runtime.warning.fixture.ts";

it("a proof can be checked by the operation guard without recursively invoking that guard", async () => {
  await withV2RuntimeWarningFixture("2.0.29", async (f) => {
    const proof = await verifyV2NativeEligibility(f.artifact, f.client, f.directory, f.root);
    let expired = false,
      checks = 0;
    f.context.operationGuard = () => {
      checks++;
      proof.assertCurrent();
      if (expired) throw new Error("V2 fixture publication gate expired");
    };
    const authority = captureV2OperationAuthority();
    expect(() => authority.assertCurrent()).not.toThrow();
    expect(checks).toBe(1);
    expired = true;
    expect(() => authority.assertCurrent()).toThrow("publication gate expired");
    expect(checks).toBe(2);
    f.revoke();
    expect(() => proof.assertCurrent()).toThrow("consent revoked");
  });
});

it("leaf proof checks still reject the current operation signal without invoking its guard", async () => {
  await withV2RuntimeWarningFixture("2.0.29", async (f) => {
    const proof = await verifyV2NativeEligibility(f.artifact, f.client, f.directory, f.root);
    const controller = new AbortController();
    f.context.operationSignal = controller.signal;
    controller.abort(new Error("fixture operation expired"));
    expect(() => proof.assertCurrent()).toThrow("fixture operation expired");
  });
});
