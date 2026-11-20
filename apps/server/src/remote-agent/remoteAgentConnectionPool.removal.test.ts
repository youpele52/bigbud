import { describe, expect, it, vi } from "vitest";

import {
  assertRemoteAgentTargetUsable,
  beginRemoteAgentTargetRemoval,
  isRemoteAgentTargetRemoving,
} from "./remoteAgentConnectionPool.removal.ts";
import { makeRemoteAgentInstaller } from "./remoteAgentServerLayer.installer.ts";
import { artifact, source } from "./remoteAgentInstallManager.fixtures.ts";
import { RemoteTargetDisconnectedError } from "../ssh/sshTargetDisconnects.ts";

const TARGET = "ssh:host=removing&transport=agent";

describe("pool removal fence", () => {
  it("refuses to dial a target while any removal of it runs", () => {
    const first = beginRemoteAgentTargetRemoval(TARGET);
    const second = beginRemoteAgentTargetRemoval(TARGET);
    expect(() => assertRemoteAgentTargetUsable(TARGET)).toThrow(RemoteTargetDisconnectedError);
    first();
    first();
    expect(isRemoteAgentTargetRemoving(TARGET)).toBe(true);
    second();
    expect(() => assertRemoteAgentTargetUsable(TARGET)).not.toThrow();
  });

  it("is held by the installer's removal and released afterwards", async () => {
    let usableDuring = true;
    const close = vi.fn();
    const installer = makeRemoteAgentInstaller({
      installManager: {
        install: async () => ({ artifact }),
        remove: async (input) => {
          const release = input.markRemoving!();
          try {
            input.closeLocalConnections!();
            usableDuring = !isRemoteAgentTargetRemoving(TARGET);
          } finally {
            release();
          }
          return { outcome: "removed" };
        },
      },
      loadInstallSource: async () => source,
      pool: { close },
    });
    await expect(installer.remove!(TARGET)).resolves.toEqual({ outcome: "removed" });
    expect(usableDuring).toBe(false);
    expect(close).toHaveBeenCalledWith(TARGET);
    expect(isRemoteAgentTargetRemoving(TARGET)).toBe(false);
  });
});
