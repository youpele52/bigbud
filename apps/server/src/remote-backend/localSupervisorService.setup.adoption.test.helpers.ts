import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import {
  emptyRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "../remote-agent/remoteAgentInstall.registry.ts";
import { remoteAgentBuildId, type RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import { makeLocalSupervisorControl } from "./localSupervisorControl.ts";
import type { SetupAgentState } from "./localSupervisorService.setup.adoption.ts";
import { prepareSetupRuntimeState } from "./localSupervisorService.setup.runtime.ts";
import { makeLocalSupervisorServiceSetup } from "./localSupervisorService.setup.ts";
import type { SetupFixture } from "./localSupervisorService.setup.test.helpers.ts";

export interface ManagedAgentSeed {
  readonly root: string;
  readonly runtime: RemoteAgentRuntime;
  readonly buildId: string;
  readonly registryPath: string;
  readonly registryText: string;
  /** Stand-in for the laptop-launched supervisor that owns live PTYs. */
  readonly supervisor: ChildProcess;
}

/** A D5-approved host: signed managed build, laptop pins and a live supervisor generation. */
export async function seedManagedAgent(
  f: SetupFixture,
  mutate: (registry: RemoteAgentRegistry, buildId: string) => RemoteAgentRegistry = (r) => r,
): Promise<ManagedAgentSeed> {
  const root = join(f.home, ".bigbud/agent");
  for (const path of [join(f.home, ".bigbud"), root, join(root, "control-v1")])
    await fs.mkdir(path, { mode: 0o700 });
  const runtime = await f.makeRuntime(
    makeLocalSupervisorControl({ homeDir: f.home, targetId: `remote-backend:${"0".repeat(32)}` }),
  );
  for (const [name, body] of [
    ["epoch", "777"],
    ["launch.intent", "launch-g1"],
    ["launch.lock", ""],
  ] as const)
    await fs.writeFile(join(runtime.statePath, name), body, { mode: 0o600 });
  const buildId = remoteAgentBuildId(runtime);
  const registry = mutate(
    {
      ...emptyRemoteAgentRegistry(),
      revision: 7,
      promotionSequence: 1,
      builds: [
        {
          id: buildId,
          runtime,
          health: "healthy",
          promotion: 1,
          binary: "present",
          authenticated: true,
        },
      ],
      pins: [{ owner: "connection:laptop-1", buildId }],
      launches: [{ id: "g1", attemptId: "launch-g1", buildId, phase: "ready", epoch: "777" }],
      admissions: [{ id: "laptop-1", buildId, phase: "ready", epoch: "777" }],
      current: buildId,
      currentConnectionId: "laptop-1",
    },
    buildId,
  );
  const registryText = JSON.stringify(registry);
  const registryPath = join(root, "control-v1/registry.json");
  await fs.writeFile(registryPath, registryText, { mode: 0o600 });
  const supervisor = spawn("sleep", ["120"], { detached: true, stdio: "ignore" });
  supervisor.unref();
  return { root, runtime, buildId, registryPath, registryText, supervisor };
}

export function stopSupervisor(seed: ManagedAgentSeed): void {
  if (seed.supervisor.pid && seed.supervisor.exitCode === null) seed.supervisor.kill("SIGKILL");
}

export function supervisorAlive(seed: ManagedAgentSeed): boolean {
  try {
    process.kill(seed.supervisor.pid!, 0);
    return seed.supervisor.exitCode === null && seed.supervisor.signalCode === null;
  } catch {
    return false;
  }
}

/** Setup whose install reuses the real runtime-state step and whose admit checks pin safety. */
export function adoptingSetup(f: SetupFixture, seed: ManagedAgentSeed) {
  const seen: {
    adoption?: SetupAgentState | undefined;
    laptopPinKept?: boolean | undefined;
    lines: string[];
  } = {
    lines: [],
  };
  const setup = makeLocalSupervisorServiceSetup({
    ...f.dependencies,
    reportRefusal: (line) => seen.lines.push(line),
    install: async (_control, _source, signal, adoption) => {
      f.events.push("install");
      seen.adoption = adoption;
      await prepareSetupRuntimeState(seed.runtime, adoption ?? { mode: "fresh" }, signal);
      return seed.runtime;
    },
    admit: async (context, control, runtime, _path, id) => {
      f.events.push("admit");
      seen.laptopPinKept = await context.owners.hasDurableReferences?.(
        control.targetId,
        "laptop-1",
      );
      await context.owners.bindConnection(control.targetId, `setup-admit-${id}`, {
        runtime,
        expectedEpoch: "777",
      });
      return "777";
    },
  });
  return { setup, seen };
}

export async function expectUntouched(seed: ManagedAgentSeed): Promise<void> {
  expect(await fs.readFile(seed.registryPath, "utf8")).toBe(seed.registryText);
  expect(await fs.readFile(join(seed.runtime.statePath, "epoch"), "utf8")).toBe("777");
  expect(supervisorAlive(seed)).toBe(true);
}
