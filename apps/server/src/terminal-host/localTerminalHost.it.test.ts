import { afterEach, describe, expect, it } from "vitest";

import { RemoteAgentConnectionPool } from "../remote-agent/remoteAgentConnectionPool.ts";
import { realLocalTerminalHostController } from "./localTerminalHost.parity.testUtils.ts";
import {
  LOCAL_TERMINAL_HOST_REQUIRED_CAPABILITIES,
  LOCAL_TERMINAL_HOST_TARGET_ID,
  type LocalTerminalHostPaths,
} from "./localTerminalHost.paths.ts";
import { assertSecureLocalTerminalHostSocket } from "./localTerminalHost.probe.ts";
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

const realController = (paths: LocalTerminalHostPaths) =>
  realLocalTerminalHostController(paths, processes);

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
    // Launched with --local-desktop-host, the host advertises every required 1.9 capability.
    const connection = await pool.getBound(
      LOCAL_TERMINAL_HOST_TARGET_ID,
      binding!,
      LOCAL_TERMINAL_HOST_REQUIRED_CAPABILITIES,
    );
    expect(connection.supportsCapability("terminal.local-launch")).toBe(true);
    // The 1.9 hello names the host's own PID and start time.
    expect(record.pidStartTime).toBeGreaterThan(0);
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
