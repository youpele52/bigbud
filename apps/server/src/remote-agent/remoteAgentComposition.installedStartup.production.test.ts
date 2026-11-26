import { afterEach, describe, expect, it, vi } from "vitest";

import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import { build } from "./remoteAgentAdmission.fixtures.ts";
import { InstalledObservationError } from "./remoteAgentComposition.installedObservation.ts";
import { composeProductionInstalledStartups } from "./remoteAgentComposition.installedStartup.production.ts";
import {
  clearInstalledRemoteAgentStartups,
  installedRemoteAgentStartup,
  installedRemoteAgentStartupRefusal,
} from "./remoteAgentInstalledStartup.state.ts";
import {
  emptyRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import type { RemoteAgentOwnerStore } from "./remoteAgentOwners.ts";

const target = "ssh:agent:approved";
const current = build(1, true);
const launch = {
  id: current.runtime.generation,
  buildId: current.id,
  phase: "ready",
  epoch: "e",
} as const;
const admitted: RemoteAgentRegistry = {
  ...emptyRemoteAgentRegistry(),
  builds: [current],
  current: current.id,
  currentConnectionId: "admitted",
  pins: [{ owner: "connection:admitted", buildId: current.id }],
  launches: [launch],
  admissions: [{ id: "admitted", buildId: current.id, phase: "ready", epoch: "e" }],
};
const binding = { connectionId: "admitted", runtime: current.runtime, expectedEpoch: "e" };
const live = { owner: () => ({}) as SshOwnerProductionRegistration };

function owners(bound = true): RemoteAgentOwnerStore {
  return {
    knownTargets: async () => [target],
    getBinding: async () => (bound ? binding : undefined),
  } as unknown as RemoteAgentOwnerStore;
}

const run = (overrides: Partial<Parameters<typeof composeProductionInstalledStartups>[0]>) =>
  composeProductionInstalledStartups({
    selection: live,
    owners: owners(),
    readRegistry: async () => admitted,
    isRemoteTarget: () => true,
    observe: async (input) => ({
      executionTargetId: input.executionTargetId,
      runtime: input.runtime,
      supervisorEpoch: input.expectedEpoch,
      agentInstanceId: "instance",
    }),
    ...overrides,
  });

afterEach(() => clearInstalledRemoteAgentStartups());

describe("U25 production normal startup (local owner store binding)", () => {
  it("observes the locally bound runtime and epoch, then composes the installed proxy", async () => {
    const observe = vi.fn(
      async (input: {
        executionTargetId: string;
        runtime: typeof current.runtime;
        expectedEpoch: string;
      }) => ({
        executionTargetId: input.executionTargetId,
        runtime: input.runtime,
        supervisorEpoch: input.expectedEpoch,
        agentInstanceId: "instance",
      }),
    );
    const results = await run({ observe });
    expect(results.get(target)?.kind).toBe("ready");
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: current.runtime, expectedEpoch: "e" }),
    );
    expect(installedRemoteAgentStartup(target)).not.toBeNull();
  });

  it("records a sticky typed refusal when an admitted build does not answer as bound", async () => {
    const results = await run({
      observe: async () => {
        throw new InstalledObservationError("identity-mismatch", "epoch changed");
      },
    });
    expect(results.get(target)).toEqual({ kind: "refused", reason: "identity-mismatch" });
    expect(installedRemoteAgentStartupRefusal(target)).toBe("identity-mismatch");
  });

  it.each([
    ["no stored binding", { owners: owners(false) }],
    ["an unreadable host", { readRegistry: async () => Promise.reject(new Error("offline")) }],
    ["an unadmitted registry", { readRegistry: async () => emptyRemoteAgentRegistry() }],
  ] as const)("composes nothing and refuses nothing for %s", async (_label, overrides) => {
    const observe = vi.fn();
    const results = await run({ ...overrides, observe });
    expect(results.size).toBe(0);
    expect(observe).not.toHaveBeenCalled();
    expect(installedRemoteAgentStartupRefusal(target)).toBeNull();
  });

  it("waits for the owner and never refuses when it does not register", async () => {
    const observe = vi.fn();
    const results = await run({ selection: { owner: () => undefined }, ownerWaitMs: 10, observe });
    expect(results.size).toBe(0);
    expect(installedRemoteAgentStartupRefusal(target)).toBeNull();
  });
});
