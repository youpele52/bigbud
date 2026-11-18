import { afterEach, describe, expect, it } from "vitest";
import type { RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import {
  createLinuxControlFixture,
  linuxControlAvailable,
} from "../remote-agent/remoteAgentUpgrade.linux.fixtures.ts";
import {
  decodeLocalSupervisorServiceConfig,
  encodeLocalSupervisorServiceConfig,
} from "./localSupervisorService.config.ts";
import { buildLocalSupervisorServiceProjection } from "./localSupervisorService.projection.ts";
import { serviceConfigFixture } from "./localSupervisorService.test.helpers.ts";

const fixtures: ReturnType<typeof createLinuxControlFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

async function setup() {
  const fixture = createLinuxControlFixture();
  fixtures.push(fixture);
  const statePath = `${fixture.root}/runtimes/g1`;
  const runtime: RemoteAgentRuntime = {
    generation: "g1",
    version: "0.3.3",
    sha256: serviceConfigFixture.rust_sha256,
    buildDigest: "fixture",
    targetTriple: "aarch64-unknown-linux-musl",
    origin: "managed",
    statePath,
    binaryPath: serviceConfigFixture.rust_binary,
    socketPath: `${statePath}/supervisor.sock`,
    logPath: `${statePath}/supervisor.log`,
  };
  const configPath = `${fixture.root}/config-v1`;
  const bootId = (await fixture.run("cat /proc/sys/kernel/random/boot_id")).trim();
  const previousConfig = encodeLocalSupervisorServiceConfig({
    ...serviceConfigFixture,
    rust_state: statePath,
  });
  await fixture.run(
    `umask 077; mkdir -p -m 700 '${statePath}'; : > '${statePath}/launch.lock'; printf attempt > '${statePath}/launch.intent'; printf '%s' '${bootId}' > '${statePath}/launch.boot'`,
  );
  await fixture.runInput(`umask 077; cat > '${configPath}'`, previousConfig);
  const projection = buildLocalSupervisorServiceProjection({
    runtime,
    configPath,
    previousConfig,
    attemptId: "attempt",
    priorEpoch: "42",
    bootId,
  });
  return { fixture, statePath, configPath, previousConfig, projection };
}

describe.runIf(linuxControlAvailable)("Linux private service projection publication", () => {
  it("atomically changes only the reserved projection and refuses stale config CAS", async () => {
    const f = await setup();
    await f.fixture.runInput(f.projection.script, f.projection.stdin);
    expect(
      decodeLocalSupervisorServiceConfig(await f.fixture.run(`cat '${f.configPath}'`)),
    ).toMatchObject({ launch_attempt: "attempt", prior_epoch: "42" });
    await expect(f.fixture.runInput(f.projection.script, f.projection.stdin)).rejects.toThrow();
    expect(await f.fixture.run(`cat '${f.configPath}'`)).toBe(f.projection.stdin);
    expect(await f.fixture.run(`stat -c '%a:%h' '${f.configPath}'`)).toBe("600:1\n");
  });
  it("refuses changed launch identity without replacing the account config", async () => {
    const f = await setup();
    await f.fixture.run(`printf other > '${f.statePath}/launch.intent'`);
    await expect(f.fixture.runInput(f.projection.script, f.projection.stdin)).rejects.toThrow();
    expect(await f.fixture.run(`cat '${f.configPath}'`)).toBe(f.previousConfig);
  });
  it("cannot change projection while an independent supervisor holds the canonical launch lock", async () => {
    const f = await setup();
    await f.fixture.run(
      `flock -x '${f.statePath}/launch.lock' sh -c 'touch "${f.statePath}/held"; sleep 2' >/dev/null 2>&1 &`,
    );
    await f.fixture.run(
      `for n in $(seq 1 50); do test ! -e '${f.statePath}/held' || exit 0; sleep .02; done; exit 1`,
    );
    await expect(f.fixture.runInput(f.projection.script, f.projection.stdin)).rejects.toThrow();
    expect(await f.fixture.run(`cat '${f.configPath}'`)).toBe(f.previousConfig);
  });
});
