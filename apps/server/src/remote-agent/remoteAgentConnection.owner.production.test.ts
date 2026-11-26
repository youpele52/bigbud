import { describe, expect, it } from "vitest";

import { routeProductionRemoteAgentProxy } from "./remoteAgentConnection.owner.production.ts";
import { build } from "./remoteAgentAdmission.fixtures.ts";

const { runtime } = build(1, true);
const legacy = { executionTargetId: "ssh:host=a", runtime, binaryPath: runtime.binaryPath };

describe("U25 production proxy routing", () => {
  it("turns a pinned runtime into an owner proxy lease", () => {
    const routed = routeProductionRemoteAgentProxy(legacy);
    expect(routed).toMatchObject({ executionTargetId: "ssh:host=a", runtime });
    expect("owner" in routed && typeof routed.owner.openAgentProxy).toBe("function");
    expect("binaryPath" in routed).toBe(false);
  });

  it("refuses an unpinned binary command", () => {
    expect(() =>
      routeProductionRemoteAgentProxy({ executionTargetId: "ssh:host=a", binaryPath: "/x" }),
    ).toThrow(/pinned agent runtime/);
  });
});
