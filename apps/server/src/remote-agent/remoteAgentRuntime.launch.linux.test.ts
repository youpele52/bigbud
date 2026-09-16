import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildIsolatedRemoteAgentLaunch } from "./remoteAgentRuntime.launch.ts";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import {
  createLinuxControlFixture,
  linuxControlAvailable,
} from "./remoteAgentUpgrade.linux.fixtures.ts";

describe.runIf(linuxControlAvailable)("Linux launch reservation parent/child handoff", () => {
  let fixture: ReturnType<typeof createLinuxControlFixture>;
  let runtime: RemoteAgentRuntime;
  beforeAll(async () => {
    fixture = createLinuxControlFixture();
    // The child deliberately has no socket; this reproduces the pre-bind ownership window.
    const binary =
      '#!/bin/sh\nprintf "writer\\n" >> "$BIGBUD_AGENT_STATE_DIR/writers"\nsleep 2\nprintf epoch > "$BIGBUD_AGENT_STATE_DIR/epoch"\nsleep 60\n';
    const sha256 = createHash("sha256").update(binary).digest("hex");
    const statePath = `${fixture.root}/runtimes/g1`;
    runtime = {
      generation: "g1",
      version: "0.2.207",
      sha256,
      buildDigest: "fixture",
      targetTriple: "aarch64-unknown-linux-gnu",
      origin: "managed",
      statePath,
      binaryPath: `${fixture.root}/bin/0.2.207/${sha256}/bigbud-remote-agent`,
      socketPath: `${statePath}/supervisor.sock`,
      logPath: `${statePath}/supervisor.log`,
    };
    await fixture.run(
      `mkdir -p -m 700 '${fixture.root}/bin/0.2.207/${sha256}'; printf '%s' '${Buffer.from(binary).toString("base64")}' | base64 --decode > '${runtime.binaryPath}'; chmod 700 '${runtime.binaryPath}'`,
    );
  });
  afterAll(() => fixture?.close());

  it("controller death postspawn/prebind cannot start a second writer", async () => {
    const launch = buildIsolatedRemoteAgentLaunch(runtime, "attempt1");
    await expect(fixture.run(`${launch}\nkill -KILL $$`)).rejects.toThrow();
    expect(await fixture.run(buildIsolatedRemoteAgentLaunch(runtime, "attempt2"))).toBe(
      "launch-in-progress",
    );
    await fixture.run("sleep 2.2");
    expect(await fixture.run(`cat '${runtime.statePath}/writers'`)).toBe("writer\n");
    expect(await fixture.run(`cat '${runtime.statePath}/epoch'`)).toBe("epoch");
  });

  it("an unlocked reservation without a socket is still uncertain, never nonlaunch proof", async () => {
    const statePath = `${fixture.root}/runtimes/g2`;
    const other = {
      ...runtime,
      generation: "g2",
      statePath,
      socketPath: `${statePath}/supervisor.sock`,
      logPath: `${statePath}/supervisor.log`,
    };
    await fixture.run(
      `mkdir -m 700 '${statePath}'; umask 077; printf reserved > '${statePath}/launch.intent'`,
    );
    expect(await fixture.run(buildIsolatedRemoteAgentLaunch(other, "attempt3"))).toBe(
      "launch-uncertain",
    );
    expect(await fixture.run(`test ! -e '${statePath}/epoch' && printf unchanged`)).toBe(
      "unchanged",
    );
  });
});
