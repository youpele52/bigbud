import { afterEach, describe, expect, it } from "vitest";

import { probeRemoteAgentSupervisorState } from "./remoteAgentInstall.retirement.ts";
import { makeRemoteAgentRegistryStore } from "./remoteAgentInstall.registry.store.ts";
import { remoteAgentBuildId, validateRemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import {
  createLinuxControlFixture,
  linuxControlAvailable,
} from "./remoteAgentUpgrade.linux.fixtures.ts";

/**
 * The agent does not unlink supervisor.sock on exit (observed live on 0.3.2 and 0.3.3), so the
 * probe must decide liveness from the launch lock and exit receipt, never from the socket file.
 */
describe.runIf(linuxControlAvailable)("remote agent supervisor liveness probe", () => {
  let fixture: ReturnType<typeof createLinuxControlFixture>;
  afterEach(() => fixture?.close());

  async function setup() {
    fixture = createLinuxControlFixture();
    const statePath = `${fixture.root}/runtimes/g-probe`;
    const runtime = validateRemoteAgentRuntime({
      generation: "g-probe",
      version: "0.3.2",
      sha256: "a".repeat(64),
      buildDigest: "fixture",
      targetTriple: "x86_64-unknown-linux-musl",
      origin: "managed",
      binaryPath: `${fixture.root}/bin/0.3.2/${"a".repeat(64)}/bigbud-remote-agent`,
      statePath,
      socketPath: `${statePath}/supervisor.sock`,
      logPath: `${statePath}/supervisor.log`,
    });
    await fixture.run(
      `umask 077; mkdir -p '${statePath}'; : > '${statePath}/launch.lock'; chmod 600 '${statePath}/launch.lock'`,
    );
    // A real socket file whose listener died without unlinking it.
    await fixture.run(
      `python3 -c "import socket,os; s=socket.socket(socket.AF_UNIX); s.bind('${runtime.socketPath}'); os._exit(0)"`,
    );
    expect(await fixture.run(`test -S '${runtime.socketPath}' && printf stale`)).toBe("stale");
    const control = {
      root: fixture.root,
      run: fixture.run,
      registry: makeRemoteAgentRegistryStore(fixture.root, fixture),
    };
    await fixture.run(`umask 077; printf probe-attempt > '${statePath}/launch.intent'`);
    await control.registry.update((state) => ({
      ...state,
      revision: state.revision + 1,
      builds: [
        {
          id: remoteAgentBuildId(runtime),
          runtime,
          health: "staged",
          promotion: 0,
          binary: "present",
          authenticated: true,
        },
      ],
      launches: [
        {
          id: runtime.generation,
          buildId: remoteAgentBuildId(runtime),
          attemptId: "probe-attempt",
          phase: "ready",
          epoch: "probe-epoch",
        },
      ],
    }));
    return { runtime, control, statePath };
  }

  it("treats a leftover socket with a free lock and an exit receipt as dead", async () => {
    const { runtime, control, statePath } = await setup();
    expect(await probeRemoteAgentSupervisorState(control, runtime)).toBe("uncertain");
    await fixture.run(`umask 077; printf 0 > '${statePath}/launch.exit'`);
    expect(await probeRemoteAgentSupervisorState(control, runtime)).toBe("dead");
  });

  it("reports live while the supervisor holds the launch lock, whatever the socket says", async () => {
    const { runtime, control, statePath } = await setup();
    await fixture.run(`umask 077; printf 0 > '${statePath}/launch.exit'`);
    const holder = (
      await fixture.run(
        `nohup flock -x '${statePath}/launch.lock' sleep 20 >/dev/null 2>&1 & echo $!; sleep 0.3`,
      )
    ).trim();
    expect(await probeRemoteAgentSupervisorState(control, runtime)).toBe("live");
    await fixture.run(`rm -f '${runtime.socketPath}'`);
    expect(await probeRemoteAgentSupervisorState(control, runtime)).toBe("live");
    await fixture.run(`kill ${holder}`);
  });
});
