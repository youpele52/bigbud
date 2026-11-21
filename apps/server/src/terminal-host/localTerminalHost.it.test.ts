import { afterEach, describe, expect, it } from "vitest";

import { RemoteAgentConnectionPool } from "../remote-agent/remoteAgentConnectionPool.ts";
import {
  collectLocalTerminalHostRuntimes,
  resolveLocalTerminalHostSource,
  stageLocalTerminalHostBinary,
  verifyStagedLocalTerminalHostBinary,
} from "./localTerminalHost.binary.ts";
import { makeLocalTerminalHostController } from "./localTerminalHost.host.ts";
import {
  launchLocalTerminalHost,
  prepareLocalTerminalHostGeneration,
} from "./localTerminalHost.launch.ts";
import {
  LOCAL_TERMINAL_HOST_REQUIRED_CAPABILITIES,
  LOCAL_TERMINAL_HOST_TARGET_ID,
  type LocalTerminalHostPaths,
} from "./localTerminalHost.paths.ts";
import {
  assertSecureLocalTerminalHostSocket,
  probeLocalTerminalHost,
} from "./localTerminalHost.probe.ts";
import { makeLocalTerminalHostProcesses, runProcessCommand } from "./localTerminalHost.process.ts";
import { makeLocalTerminalHostRegistry } from "./localTerminalHost.registry.ts";
import { makeShortTerminalHostRoot } from "./localTerminalHost.testUtils.ts";
import { makeLocalTerminalHostTransportFactory } from "./localTerminalHost.transport.ts";

const enabled = process.env.BIGBUD_TERMINAL_HOST_IT === "1" && process.platform !== "win32";
const processes = makeLocalTerminalHostProcesses();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function realController(paths: LocalTerminalHostPaths) {
  return makeLocalTerminalHostController({
    mode: "enabled",
    paths,
    registry: makeLocalTerminalHostRegistry(paths),
    processes,
    requiredCapabilities: LOCAL_TERMINAL_HOST_REQUIRED_CAPABILITIES,
    generationHasOwners: async () => false,
    log: () => {},
    stage: async () => stageLocalTerminalHostBinary(paths, resolveLocalTerminalHostSource()),
    verifyStaged: (staged) => verifyStagedLocalTerminalHostBinary(paths, staged),
    collectRuntimes: (keep) => collectLocalTerminalHostRuntimes(paths, keep),
    probe: (generation, proxyBinary) => probeLocalTerminalHost({ generation, proxyBinary }),
    prepareGeneration: (generation) => prepareLocalTerminalHostGeneration(paths.root, generation),
    launch: (input) => launchLocalTerminalHost(input),
  });
}

async function processGroup(pid: number): Promise<number> {
  const result = await runProcessCommand("ps", ["-o", "pgid=", "-p", String(pid)]);
  return Number(result.stdout.trim());
}

describe.skipIf(!enabled)("local terminal host with the real binary", () => {
  it("stages, launches detached, connects through the proxy, and survives a backend restart", async () => {
    const root = await makeShortTerminalHostRoot();
    cleanups.push(root.cleanup);
    const first = realController(root.paths);
    const binding = await first.resolveAdmittedBinding();
    expect(binding?.connectionId).toBe("state-1");
    const record = (await makeLocalTerminalHostRegistry(root.paths).read())[0]!;
    expect(record).toMatchObject({ generation: 1, state: "running" });
    const pid = record.pid!;
    cleanups.push(async () => {
      processes.signal(pid, "SIGTERM");
      await processes.waitForExit(pid, 3_000);
    });
    expect(await processes.verify(pid, record.pidStartTime)).toBe("verified");

    // `detached` = its own session and process group, so the backend's group signal misses it.
    expect(await processGroup(pid)).toBe(pid);
    expect(await processGroup(pid)).not.toBe(await processGroup(process.pid));

    // The pool reaches the host through the staged `--proxy`, validating the hello binding.
    const pool = new RemoteAgentConnectionPool(
      makeLocalTerminalHostTransportFactory({
        resolveBinding: first.resolveAdmittedBinding,
        proxyBinary: first.proxyBinary,
        assertSocket: assertSecureLocalTerminalHostSocket,
      }),
    );
    const connection = await pool.getBound(LOCAL_TERMINAL_HOST_TARGET_ID, binding!, [
      "terminal.pty",
    ]);
    expect(connection.supportsCapability("terminal.pty")).toBe(true);
    pool.closeAll();

    // A new backend adopts the same host: same generation, epoch and PID; nothing launched.
    const second = realController(root.paths);
    const adopted = await second.ready();
    expect(adopted.admitted?.binding).toMatchObject({
      connectionId: "state-1",
      expectedEpoch: binding!.expectedEpoch,
    });
    expect(await second.resolveAdmittedBinding()).toMatchObject({ connectionId: "state-1" });
    expect(
      (await makeLocalTerminalHostRegistry(root.paths).read()).map((entry) => entry.pid),
    ).toEqual([pid]);
    expect(processes.isAlive(pid)).toBe(true);
  }, 30_000);
});
