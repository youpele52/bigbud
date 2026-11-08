import { expect, it, vi } from "vitest";
import {
  assertV2RequestContext,
  currentV2RequestContext,
  runV2Cleanup,
  runV2RequestContext,
} from "./Client.guard.ts";
import { v2Request } from "./Client.ts";
import { verifyV2NativeEligibility } from "./NativeCompatibility.runtime.ts";
import { withV2RuntimeWarningFixture } from "./NativeCompatibility.runtime.warning.fixture.ts";

it("checks inherited publication authority in its execution scope, without lending it to cleanup", async () => {
  await withV2RuntimeWarningFixture("2.2.6", async (f) => {
    const parent = currentV2RequestContext()!;
    const proof = await verifyV2NativeEligibility(f.artifact, f.client, f.directory, f.root);
    let checks = 0;
    f.context.operationGuard = () => {
      checks++;
      proof.assertCurrent();
    };
    const read = vi.fn(async () => {
      expect(currentV2RequestContext()?.intent).toBe("cleanup");
      expect(currentV2RequestContext()?.permit.revision).toBe(-1);
      assertV2RequestContext(
        parent.transport,
        new URL("http://localhost/api/session/active"),
        "GET",
      );
      // The proof itself has NOT acquired cleanup authority or a special bypass.
      expect(() => proof.assertCurrent()).toThrow("consent/transport scope");
      expect(() =>
        assertV2RequestContext(parent.transport, new URL("http://localhost/api/config"), "GET"),
      ).toThrow("configuration-read authority");
      expect(() =>
        assertV2RequestContext(parent.transport, new URL("http://localhost/api/session"), "POST"),
      ).toThrow("cleanup route rejected");
      return {};
    });
    await runV2Cleanup(parent.transport, "old-session", () => v2Request("activity", read));
    expect(read).toHaveBeenCalledOnce();
    expect(checks).toBeGreaterThan(0);
    expect(currentV2RequestContext()).toBe(parent);
  });
});

it.each(["revoked", "expired", "cancelled", "wrong-transport"])(
  "does not issue cleanup when inherited authority is %s",
  async (scenario) => {
    await withV2RuntimeWarningFixture("2.2.6", async (f) => {
      const parent = currentV2RequestContext()!;
      const proof = await verifyV2NativeEligibility(f.artifact, f.client, f.directory, f.root);
      const controller = new AbortController();
      f.context.operationGuard = () => {
        proof.assertCurrent();
        if (scenario === "expired") throw new Error("V2 publication expired");
      };
      f.context.operationSignal = controller.signal;
      if (scenario === "revoked") f.revoke();
      if (scenario === "cancelled") controller.abort();
      const read = vi.fn(async () => ({}));
      await expect(
        runV2Cleanup(
          scenario === "wrong-transport" ? "another-transport" : parent.transport,
          "old-session",
          () => v2Request("activity", read),
        ),
      ).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
    });
  },
);

it("retains an inherited guard across nested cleanup scopes and restores the caller", async () => {
  await withV2RuntimeWarningFixture("2.2.6", async (f) => {
    const parent = currentV2RequestContext()!;
    const proof = await verifyV2NativeEligibility(f.artifact, f.client, f.directory, f.root);
    const observed = vi.fn();
    f.context.operationGuard = () => proof.assertCurrent();
    await runV2RequestContext({ ...parent, observeOperation: observed }, () =>
      runV2Cleanup(parent.transport, "old-session", () =>
        runV2Cleanup(parent.transport, "old-session", () =>
          v2Request("activity", async () => ({})),
        ),
      ),
    );
    expect(observed).toHaveBeenCalledOnce();
    expect(currentV2RequestContext()).toBe(parent);
  });
});
