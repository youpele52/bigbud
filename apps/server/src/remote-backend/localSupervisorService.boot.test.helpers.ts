import { vi } from "vitest";
import {
  emptyRemoteAgentRegistry,
  parseRemoteAgentRegistry,
} from "../remote-agent/remoteAgentInstall.registry.ts";
import { runtime } from "../remote-agent/remoteAgentRestart.test.helpers.ts";
import { remoteAgentBuildId } from "../remote-agent/remoteAgentRuntime.ts";
import { makeLocalSupervisorBootProgressStore } from "./localSupervisorService.boot.store.ts";

export function bootFixture(observation: "live" | "prior-boot-dead" = "prior-boot-dead") {
  const selected = runtime("g1");
  const target = `remote-backend:${"a".repeat(32)}`;
  const requestId = "account-boot:fixture";
  const buildId = remoteAgentBuildId(selected);
  let state = parseRemoteAgentRegistry(
    JSON.stringify({
      ...emptyRemoteAgentRegistry(),
      builds: [
        {
          id: buildId,
          runtime: selected,
          health: "healthy",
          promotion: 1,
          binary: "present",
          authenticated: true,
        },
      ],
      promotionSequence: 1,
      current: buildId,
      currentConnectionId: "original",
      launches: [
        { id: selected.generation, buildId, attemptId: "original", phase: "ready", epoch: "42" },
      ],
      admissions: [{ id: "original", buildId, phase: "ready", epoch: "42" }],
      pins: [{ owner: "connection:original", buildId }],
    }),
  );
  const run = vi.fn(async (command: string) => {
    if (command.endsWith("observe_supervisor\n")) return observation;
    if (command.includes("printf dead")) return "prior-boot-dead";
    if (command.includes("printf ready")) return "ready";
    throw new Error("Unexpected boot control operation");
  });
  const registry = {
    read: async () => state,
    update: async (transition: (current: typeof state) => typeof state) => {
      state = parseRemoteAgentRegistry(JSON.stringify(transition(state)));
      return state;
    },
  };
  const owner = { root: "/tmp/agent", run, registry };
  const control = { targetId: target, openControl: async () => owner };
  const store = makeLocalSupervisorBootProgressStore({
    control,
    runtime: selected,
    oldEpoch: "42",
    requestId,
  });
  return { selected, target, requestId, owner, control, store, run, state: () => state };
}
