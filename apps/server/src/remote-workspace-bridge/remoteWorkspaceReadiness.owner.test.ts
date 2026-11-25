import { beforeAll, expect, it, vi } from "vitest";

import { createCopilotRemoteWorkspaceBridge } from "../provider/Layers/Copilot/CopilotRemoteWorkspaceBridge.ts";
import { activateDevSshOwner } from "../ssh/sshOwnerDevMode.fixture.ts";
import { runToolCommand } from "../tool-transport/toolTransport.ts";
import { resolveWorkspaceTarget } from "../workspace-target/workspaceTarget.ts";
import { createRemoteWorkspaceBridge } from "./remoteWorkspaceBridge.ts";
import {
  makeRemoteWorkspaceReadinessProbe,
  probeRemoteWorkspaceReadiness,
  SelectedSshOwnerWorkspaceBridgeError,
} from "./remoteWorkspaceReadiness.ts";

vi.mock("../tool-transport/toolTransport.ts", async (load) => ({
  ...(await load<typeof import("../tool-transport/toolTransport.ts")>()),
  runToolCommand: vi.fn(async () => {
    throw new Error("Unexpected tool transport dispatch");
  }),
}));

vi.mock("./remoteWorkspaceBridge.ts", () => ({
  createRemoteWorkspaceBridge: vi.fn(async () => {
    throw new Error("Unexpected workspace bridge allocation");
  }),
}));

const remoteTarget = (transport: "direct-ssh" | "agent") =>
  resolveWorkspaceTarget({
    executionTargetId: `ssh:host=fixture.invalid&transport=${transport}`,
    cwd: "/srv/project",
  });

beforeAll(activateDevSshOwner);

it.each(["direct-ssh", "agent"] as const)(
  "refuses %s readiness at the production probe before tool transport dispatch",
  async (transport) => {
    await expect(probeRemoteWorkspaceReadiness(remoteTarget(transport))).rejects.toMatchObject({
      name: SelectedSshOwnerWorkspaceBridgeError.name,
      code: "unsupported-by-selected-ssh-owner",
      operation: "readiness",
    });
    expect(runToolCommand).not.toHaveBeenCalled();
  },
);

it.each(["direct-ssh", "agent"] as const)(
  "refuses the Copilot %s session filesystem before a custom probe or bridge allocation",
  async (transport) => {
    const readinessProbe = vi.fn(async () => ({ os: "linux" as const, architecture: "x86_64" }));
    await expect(
      createCopilotRemoteWorkspaceBridge(remoteTarget(transport), readinessProbe),
    ).rejects.toMatchObject({
      name: SelectedSshOwnerWorkspaceBridgeError.name,
      code: "unsupported-by-selected-ssh-owner",
      operation: "session-filesystem",
    });
    expect(readinessProbe).not.toHaveBeenCalled();
    expect(createRemoteWorkspaceBridge).not.toHaveBeenCalled();
    expect(runToolCommand).not.toHaveBeenCalled();
  },
);

it("leaves local readiness unchanged under source-dev selection", async () => {
  const target = resolveWorkspaceTarget({ executionTargetId: "local", cwd: "/tmp/project" });
  const run = vi.fn(async () => ({
    stdout: "Linux\nx86_64\n",
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
  }));
  await expect(makeRemoteWorkspaceReadinessProbe(run)(target)).resolves.toEqual({
    os: "linux",
    architecture: "x86_64",
  });
  expect(run).toHaveBeenCalledExactlyOnceWith({ workspaceTarget: target, timeoutMs: 10_000 });
});
