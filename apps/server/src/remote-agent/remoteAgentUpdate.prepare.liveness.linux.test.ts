import { afterEach, describe, expect, it } from "vitest";

import {
  buildRemoteAgentCandidateExitWaitCommand,
  buildRemoteAgentCandidateStartupWaitCommand,
} from "./remoteAgentUpdate.prepare.ts";
import { validateRemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import {
  createLinuxControlFixture,
  linuxControlAvailable,
} from "./remoteAgentUpgrade.linux.fixtures.ts";

describe.runIf(linuxControlAvailable)("candidate launch liveness on Linux", () => {
  let fixture: ReturnType<typeof createLinuxControlFixture>;
  let holderPid: string | undefined;
  afterEach(async () => {
    try {
      if (holderPid) {
        await fixture.run(`kill ${holderPid} 2>/dev/null || true
for n in $(seq 1 100); do kill -0 ${holderPid} 2>/dev/null || exit 0; sleep .01; done
kill -KILL ${holderPid} 2>/dev/null || true`);
      }
    } finally {
      holderPid = undefined;
      fixture?.close();
    }
  });

  async function setup() {
    fixture = createLinuxControlFixture();
    const statePath = `${fixture.root}/runtimes/g-wait`;
    const runtime = validateRemoteAgentRuntime({
      generation: "g-wait",
      version: "0.3.3",
      sha256: "a".repeat(64),
      buildDigest: "fixture",
      targetTriple: "x86_64-unknown-linux-musl",
      origin: "managed",
      binaryPath: `${fixture.root}/bin/0.3.3/${"a".repeat(64)}/bigbud-remote-agent`,
      statePath,
      socketPath: `${statePath}/supervisor.sock`,
      logPath: `${statePath}/supervisor.log`,
    });
    await fixture.run(`umask 077; mkdir -p '${statePath}'; : > '${statePath}/launch.lock'; printf launch-g-wait > '${statePath}/launch.intent'; cat /proc/sys/kernel/random/boot_id > '${statePath}/launch.boot'
python3 -c "import socket,os; s=socket.socket(socket.AF_UNIX); s.bind('${runtime.socketPath}'); os._exit(0)"`);
    // Exercise the unchanged polling body, but avoid waiting 30 seconds for negative cases.
    const run = (command: string) => fixture.run(command.replace("seq 1 300", "seq 1 2"));
    const startup = (attemptId?: string) =>
      run(buildRemoteAgentCandidateStartupWaitCommand(runtime, attemptId));
    const exit = (attemptId?: string) =>
      run(buildRemoteAgentCandidateExitWaitCommand(runtime, attemptId));
    const receipt = (value: string) =>
      fixture.run(`umask 077; printf '%s' '${value}' > '${statePath}/launch.exit'`);
    const holdLock = async () => {
      holderPid = (
        await fixture.run(
          `nohup python3 -c "import fcntl,time; f=open('${statePath}/launch.lock'); fcntl.flock(f,fcntl.LOCK_EX); open('${statePath}/held','w').close(); time.sleep(60)" >/dev/null 2>&1 & echo $!`,
        )
      ).trim();
      if (!/^[1-9][0-9]*$/.test(holderPid)) throw new Error("Invalid fixture lock-holder PID.");
      await fixture.run(
        `for n in $(seq 1 100); do test ! -f '${statePath}/held' || exit 0; sleep .01; done; exit 1`,
      );
    };
    return { runtime, startup, exit, receipt, holdLock, statePath };
  }

  it("does not mistake a stale socket for readiness and accepts a proven exit despite it", async () => {
    const f = await setup();
    expect(await f.startup()).toBe("unavailable");
    expect(await f.exit()).toBe("unavailable");
    await f.receipt("0");
    expect(await f.startup()).toBe("startup-exit:0");
    expect(await f.exit()).toBe("exited");
    expect(await fixture.run(`test -S '${f.runtime.socketPath}' && printf retained`)).toBe(
      "retained",
    );
  });

  it("requires the held lock, matching intent and readiness signal together", async () => {
    const f = await setup();
    await f.holdLock();
    expect(await f.startup()).toBe("ready");
    expect(await f.startup("another-attempt")).toBe("unavailable");
    await fixture.run(`rm '${f.runtime.socketPath}'`);
    expect(await f.startup()).toBe("unavailable");
  });

  it("never proves exit while the lock is held, even with an old receipt", async () => {
    const f = await setup();
    await f.holdLock();
    await f.receipt("0");
    expect(await f.exit()).toBe("unavailable");
    expect(await f.startup()).toBe("unavailable");
  });

  it("rejects a mismatched attempt, malformed receipt and symlinked evidence", async () => {
    const f = await setup();
    await f.receipt("0");
    expect(await f.exit("another-attempt")).toBe("unavailable");
    await f.receipt("not-an-exit");
    expect(await f.exit()).toBe("unavailable");
    await f.receipt("0");
    await fixture.run(
      `mv '${f.statePath}/launch.exit' '${f.statePath}/receipt'; ln -s receipt '${f.statePath}/launch.exit'`,
    );
    expect(await f.exit()).toBe("unavailable");
  });

  it("accepts a matching nondefault attempt and rejects nonprivate metadata", async () => {
    const f = await setup();
    await fixture.run(`printf custom-attempt > '${f.statePath}/launch.intent'`);
    await f.receipt("17");
    expect(await f.startup("custom-attempt")).toBe("startup-exit:17");
    expect(await f.exit("custom-attempt")).toBe("exited");
    await fixture.run(`chmod 644 '${f.statePath}/launch.lock'`);
    expect(await f.exit("custom-attempt")).toBe("unavailable");
  });
});
