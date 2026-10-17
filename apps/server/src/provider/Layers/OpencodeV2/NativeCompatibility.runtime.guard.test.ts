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
    // Proof validation is a leaf: it never invokes the dynamic operation guard.
    expect(() => proof.assertCurrent()).not.toThrow();
    expect(checks).toBe(0);
    const authority = captureV2OperationAuthority();
    expect(() => authority.assertCurrent()).not.toThrow();
    expect(checks).toBe(1);
    expired = true;
    expect(() => authority.assertCurrent()).toThrow("publication gate expired");
    expect(checks).toBe(2);
    expect(() => captureV2OperationAuthority().assertCurrent()).toThrow("publication gate expired");
    expired = false;
    f.revoke();
    expect(() => proof.assertCurrent()).toThrow("consent revoked");
    // Execution authority still rejects revoked consent independently of the proof.
    expect(() => authority.assertCurrent()).toThrow("consent revoked");
    expect(() => captureV2OperationAuthority().assertCurrent()).toThrow("consent revoked");
  });
});

it("leaf proof checks still reject the current operation signal without invoking its guard", async () => {
  await withV2RuntimeWarningFixture("2.0.29", async (f) => {
    const proof = await verifyV2NativeEligibility(f.artifact, f.client, f.directory, f.root);
    const controller = new AbortController();
    let checks = 0;
    f.context.operationGuard = () => {
      checks++;
    };
    f.context.operationSignal = controller.signal;
    const authority = captureV2OperationAuthority();
    controller.abort(new Error("fixture operation expired"));
    expect(() => proof.assertCurrent()).toThrow("fixture operation expired");
    expect(checks).toBe(0);
    // An aborted operation signal is still rejected by execution authority.
    expect(() => authority.assertCurrent()).toThrow("fixture operation expired");
    expect(() => captureV2OperationAuthority().assertCurrent()).toThrow(
      "fixture operation expired",
    );
  });
});
