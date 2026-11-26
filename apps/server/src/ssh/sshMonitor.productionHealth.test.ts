import { describe, expect, it } from "vitest";

import { makeProductionSshMonitorHealth } from "./sshMonitor.productionHealth.ts";
import type { SshOwnerProductionRegistration } from "./sshOwnerProductionRegistry.ts";

const TARGET = "ssh:host=vps.example&user=dev";

function live(sample: () => Promise<boolean>) {
  const calls: string[] = [];
  const registration = {
    descriptorFor: async (targetId: string) => ({ targetId, kind: "structured" }),
    handle: {
      target: (descriptor: { targetId: string }) => ({
        targetId: descriptor.targetId,
        sampleCancellableProofHealth: async (id: string) => {
          calls.push(id);
          return sample();
        },
      }),
    },
  } as unknown as SshOwnerProductionRegistration;
  return { calls, registration };
}

describe("W7 production SSH monitor health", () => {
  const signal = () => new AbortController().signal;

  it("maps the owner's typed sample for the exact target", async () => {
    const up = live(async () => true);
    expect(
      await makeProductionSshMonitorHealth(() => up.registration).sampleHealth(TARGET, signal()),
    ).toBe("reachable");
    expect(up.calls).toEqual([TARGET]);
    const down = live(async () => false);
    expect(
      await makeProductionSshMonitorHealth(() => down.registration).sampleHealth(TARGET, signal()),
    ).toBe("unreachable");
  });

  it("never reports an absent, failing or cancelled owner as a dead transport", async () => {
    expect(
      await makeProductionSshMonitorHealth(() => undefined).sampleHealth(TARGET, signal()),
    ).toBe("unavailable");
    const failing = live(async () => {
      throw new Error("ownerUnavailable");
    });
    expect(
      await makeProductionSshMonitorHealth(() => failing.registration).sampleHealth(
        TARGET,
        signal(),
      ),
    ).toBe("unavailable");
    const aborted = new AbortController();
    aborted.abort();
    const up = live(async () => true);
    expect(
      await makeProductionSshMonitorHealth(() => up.registration).sampleHealth(
        TARGET,
        aborted.signal,
      ),
    ).toBe("unavailable");
    expect(up.calls).toEqual([]);
  });
});
