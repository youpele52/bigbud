import { expect, it } from "vitest";
import {
  managedNativeLeaseChannel,
  type ManagedNativeLeaseChannel,
} from "./localSupervisorService.leaseChannel.ts";
it("structural channels cannot promote injected clients into managed account provenance", () => {
  const fake = {
    client: { assertActivationCapability() {}, dispose() {} },
    nativeEpoch: "epoch",
    targetId: `remote-backend:${"a".repeat(32)}`,
    assertCurrent: async () => {},
  };
  for (const value of [{}, fake, Object.freeze({ ...fake }), new Proxy(fake, {})])
    expect(() => managedNativeLeaseChannel(value as ManagedNativeLeaseChannel)).toThrow(
      "unavailable",
    );
});
