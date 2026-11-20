import { reconcileRemoteAgentLaunchExits } from "./remoteAgentInstall.reconcile.ts";
import {
  emptyRemoteAgentRegistry,
  parseRemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import { remoteAgentBuildId } from "./remoteAgentRuntime.ts";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { buildRemoteAgentSupervisorObservation } from "./remoteAgentSupervisorLiveness.ts";
import {
  buildManagedRemoteAgentReplacementLaunch,
  buildRemoteAgentReplacementDeathEvidence,
  buildRemoteAgentReplacementReadiness,
} from "./remoteAgentRuntime.launch.ts";
import { validateRemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import {
  createLinuxControlFixture,
  linuxControlAvailable,
} from "./remoteAgentUpgrade.linux.fixtures.ts";

describe.runIf(linuxControlAvailable)("restart launch and boot evidence on Linux", () => {
  let fixture: ReturnType<typeof createLinuxControlFixture>;
  afterEach(() => fixture?.close());

  async function setup() {
    fixture = createLinuxControlFixture();
    const binary = '#!/bin/sh\nprintf new-epoch > "$BIGBUD_AGENT_STATE_DIR/epoch"\n';
    const sha256 = createHash("sha256").update(binary).digest("hex");
    const statePath = `${fixture.root}/runtimes/g-boot`;
    const runtime = validateRemoteAgentRuntime({
      generation: "g-boot",
      version: "0.3.3",
      sha256,
      buildDigest: "fixture",
      targetTriple: "x86_64-unknown-linux-musl",
      origin: "managed",
      statePath,
      binaryPath: `${fixture.root}/bin/0.3.3/${sha256}/bigbud-remote-agent`,
      socketPath: `${statePath}/supervisor.sock`,
      logPath: `${statePath}/supervisor.log`,
    });
    await fixture.run(`umask 077; mkdir -p '${statePath}' '${fixture.root}/bin/0.3.3/${sha256}'
printf '%s' '${Buffer.from(binary).toString("base64")}' | base64 -d > '${runtime.binaryPath}'
chmod 700 '${runtime.binaryPath}'
: > '${statePath}/launch.lock'; printf old-attempt > '${statePath}/launch.intent'
printf old-epoch > '${statePath}/epoch'; chmod 700 '${statePath}/epoch'
cat /proc/sys/kernel/random/boot_id > '${statePath}/launch.boot'
python3 -c "import socket,os; s=socket.socket(socket.AF_UNIX); s.bind('${runtime.socketPath}'); os._exit(0)"`);
    const observe = (attempt = "old-attempt", prefix = "") =>
      fixture.run(
        prefix +
          "set -eu\n" +
          buildRemoteAgentSupervisorObservation(runtime, attempt) +
          "\nobserve_supervisor",
      );
    const launch = () =>
      fixture.run(
        buildManagedRemoteAgentReplacementLaunch(
          runtime,
          "new-attempt",
          "old-epoch",
          "old-attempt",
        ),
      );
    const previousBoot = () =>
      fixture.run(`printf 00000000-0000-0000-0000-000000000000 > '${statePath}/launch.boot'`);
    const heldLock = `exec 9< '${statePath}/launch.lock'; flock -x 9\n`;
    return { runtime, statePath, observe, launch, previousBoot, heldLock };
  }

  it("keeps same-boot wrapper loss unknown and never uses the stale socket as ready", async () => {
    const f = await setup();
    expect(await f.observe()).toBe("unknown");
    expect(await f.launch()).toBe("launch-uncertain");
    expect(
      await fixture.run(
        buildRemoteAgentReplacementReadiness(f.runtime, "old-attempt").replace(
          "seq 1 300",
          "seq 1 2",
        ),
      ),
    ).toBe("unavailable");
    expect(await fixture.run(`cat '${f.statePath}/epoch'`)).toBe("old-epoch");
  });

  it("distinguishes matching prior-boot death only with a free lock", async () => {
    const f = await setup();
    await f.previousBoot();
    expect(await f.observe()).toBe("prior-boot-dead");
    expect(await f.observe("wrong-attempt")).toBe("unknown");
    expect(await f.observe("old-attempt", f.heldLock)).toBe("live");
    expect(
      await fixture.run(buildRemoteAgentReplacementDeathEvidence(f.runtime, "old-attempt")),
    ).toBe("prior-boot-dead");
  });

  it("fails closed for missing, malformed, symlinked boot evidence or unsupported platform", async () => {
    const f = await setup();
    await f.previousBoot();
    expect(await f.observe("old-attempt", "uname() { printf Darwin; }\n")).toBe("unknown");
    await fixture.run(`printf invalid > '${f.statePath}/launch.boot'`);
    expect(await f.observe()).toBe("unknown");
    await fixture.run(`rm '${f.statePath}/launch.boot'`);
    expect(await f.observe()).toBe("unknown");
    await fixture.run(`ln -s /proc/sys/kernel/random/boot_id '${f.statePath}/launch.boot'`);
    expect(await f.observe()).toBe("unknown");
  });

  it.each(["receipt", "prior boot"])(
    "relaunches after %s proof despite a stale socket, recording new boot and attempt",
    async (proof) => {
      const f = await setup();
      if (proof === "receipt")
        await fixture.run(`umask 077; printf 0 > '${f.statePath}/launch.exit'`);
      else await f.previousBoot();
      expect(await f.launch()).toBe("launch-reserved");
      expect(
        await fixture.run(`for n in $(seq 1 100); do test ! -f '${f.statePath}/launch.exit' || break; sleep .01; done
cat '${f.statePath}/launch.intent'; printf ':'; cat '${f.statePath}/epoch'
test ! -e '${f.runtime.socketPath}'
test "$(cat '${f.statePath}/launch.boot')" = "$(cat /proc/sys/kernel/random/boot_id)"`),
      ).toBe("new-attempt:new-epoch");
      expect(await f.observe("new-attempt")).toBe("exited:0");
      expect(await f.observe("old-attempt")).toBe("unknown");
    },
  );

  it("reconciles only a matching prior-boot launch and preserves same-boot uncertainty", async () => {
    const f = await setup();
    const buildId = remoteAgentBuildId(f.runtime);
    let registry = parseRemoteAgentRegistry(
      JSON.stringify({
        ...emptyRemoteAgentRegistry(),
        builds: [
          {
            id: buildId,
            runtime: f.runtime,
            health: "staged",
            promotion: 0,
            binary: "present",
            authenticated: true,
          },
        ],
        launches: [
          {
            id: f.runtime.generation,
            buildId,
            attemptId: "old-attempt",
            phase: "ready",
            epoch: "old-epoch",
          },
        ],
      }),
    );
    const control = {
      root: fixture.root,
      run: fixture.run,
      registry: {
        read: async () => registry,
        update: async (transition: (state: typeof registry) => typeof registry) => {
          registry = parseRemoteAgentRegistry(JSON.stringify(transition(registry)));
          return registry;
        },
      },
    };
    await reconcileRemoteAgentLaunchExits(control);
    expect(registry.launches[0]?.phase).toBe("ready");
    await f.previousBoot();
    await fixture.run(`printf mismatched > '${f.statePath}/launch.intent'`);
    await reconcileRemoteAgentLaunchExits(control);
    expect(registry.launches[0]?.phase).toBe("ready");
    await fixture.run(`printf old-attempt > '${f.statePath}/launch.intent'`);
    await reconcileRemoteAgentLaunchExits(control);
    expect(registry.launches[0]?.phase).toBe("proven-dead");
  });

  it("does not remove a socket or overwrite evidence when the launch lock is held", async () => {
    const f = await setup();
    expect(
      await fixture.run(
        f.heldLock +
          buildManagedRemoteAgentReplacementLaunch(
            f.runtime,
            "new-attempt",
            "old-epoch",
            "old-attempt",
          ),
      ),
    ).toBe("launch-in-progress");
    expect(
      await fixture.run(`test -S '${f.runtime.socketPath}'; cat '${f.statePath}/launch.intent'`),
    ).toBe("old-attempt");
  });
});
