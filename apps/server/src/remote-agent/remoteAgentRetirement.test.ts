import { describe, expect, it } from "vitest";
import { RemoteAgentRetirementFence } from "./remoteAgentRetirement.ts";
import {
  emptyRemoteAgentRegistry,
  type RemoteAgentRegistry,
  type RemoteAgentRegistryBuild,
} from "./remoteAgentInstall.registry.ts";
import {
  advanceRemoteAgentRetirement,
  reserveRemoteAgentRetirement,
} from "./remoteAgentInstall.registry.retirement.ts";
import { retireManagedRemoteAgentBuild } from "./remoteAgentInstall.retirement.ts";
import type { RemoteAgentControl } from "./remoteAgentControl.ts";

function build(number: number): RemoteAgentRegistryBuild {
  const version = `0.2.${number}`;
  const sha256 = String(number).repeat(64).slice(0, 64);
  const generation = `g${number}`;
  return {
    id: `${version}:${sha256}:aarch64-unknown-linux-gnu`,
    health: "healthy",
    promotion: number,
    authenticated: true,
    binary: "present",
    runtime: {
      generation,
      version,
      sha256,
      buildDigest: `digest-${number}`,
      targetTriple: "aarch64-unknown-linux-gnu",
      binaryPath: `/tmp/agent/bin/${version}/${sha256}/bigbud-remote-agent`,
      statePath: `/tmp/agent/runtimes/${generation}`,
      socketPath: `/tmp/agent/runtimes/${generation}/supervisor.sock`,
      logPath: `/tmp/agent/runtimes/${generation}/supervisor.log`,
      origin: "managed",
    },
  };
}

describe("remote agent retirement fencing", () => {
  it("blocks new acquisition while an existing acquisition drains", async () => {
    const fence = new RemoteAgentRetirementFence();
    const releaseAcquisition = fence.acquire("g1");
    const retiring = fence.begin("g1", { timeoutMs: 1000 });
    await Promise.resolve();
    expect(() => fence.acquire("g1")).toThrow("fenced");
    releaseAcquisition();
    const releaseRetirement = await retiring;
    releaseRetirement();
    expect(() => fence.acquire("g1")).not.toThrow();
  });

  it("requires a managed, unpinned obsolete generation and preserves the current build", () => {
    const current = build(1);
    const obsolete = build(2);
    const state = {
      ...emptyRemoteAgentRegistry(),
      current: current.id,
      promotionSequence: 2,
      builds: [current, obsolete],
    };
    const reserved = reserveRemoteAgentRetirement(state, {
      id: "retire-g2",
      buildId: obsolete.id,
      expectedEpoch: "epoch-2",
    });
    expect(reserved.retirementReservations[0]).toMatchObject({
      buildId: obsolete.id,
      phase: "reserved",
    });
    expect(() =>
      reserveRemoteAgentRetirement(
        { ...state, predecessor: obsolete.id },
        { id: "retire-predecessor", buildId: obsolete.id },
      ),
    ).toThrow("predecessor");
    const replacementReservation = reserveRemoteAgentRetirement(
      { ...state, predecessor: obsolete.id },
      { id: "retire-replacement", buildId: obsolete.id, withdrawPredecessor: true },
    );
    expect(replacementReservation.predecessor).toBeNull();
    expect(replacementReservation.retirementReservations[0]?.phase).toBe("reserved");
    const fenced = advanceRemoteAgentRetirement(reserved, "retire-g2", "fenced");
    expect(fenced.current).toBe(current.id);
  });

  it("defers native shutdown failures and keeps the binary occupied", async () => {
    const current = build(1);
    const obsolete = build(2);
    let state: RemoteAgentRegistry = {
      ...emptyRemoteAgentRegistry(),
      current: current.id,
      builds: [current, obsolete],
      promotionSequence: 2,
    };
    const control: RemoteAgentControl = {
      root: "/tmp/agent",
      run: async (command) =>
        command.includes("test -S")
          ? "live"
          : command.includes("shutdown-supervisor")
            ? "shutdown-rejected"
            : "",
      registry: {
        read: async () => state,
        update: async (transition) => {
          state = transition(state);
          return state;
        },
      },
    };
    await expect(
      retireManagedRemoteAgentBuild({
        control,
        buildId: obsolete.id,
        reservationId: "retire-g2",
      }),
    ).resolves.toBe("deferred");
    expect(state.builds.find((entry) => entry.id === obsolete.id)?.binary).toBe("present");
    expect(state.retirementReservations[0]).toMatchObject({
      phase: "failed",
      failure: "uncertain",
    });
  });
});
