import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLinuxControlFixture,
  linuxControlAvailable,
} from "./remoteAgentUpgrade.linux.fixtures.ts";
import { makeRemoteAgentRegistryStore } from "./remoteAgentInstall.registry.store.ts";
import { cleanupRemoteAgentBuilds } from "./remoteAgentInstall.cleanup.ts";
import {
  reserveRemoteAgentStage,
  pinRemoteAgentBuild,
} from "./remoteAgentInstall.registry.transitions.ts";
import { remoteAgentBuildId } from "./remoteAgentRuntime.ts";
import type { RemoteAgentRegistryBuild } from "./remoteAgentInstall.registry.ts";

describe.runIf(linuxControlAvailable)("install-manager Linux binary retention", () => {
  let fixture: ReturnType<typeof createLinuxControlFixture>;
  afterEach(() => fixture?.close());
  async function setup() {
    fixture = createLinuxControlFixture();
    await fixture.run(`umask 077; mkdir -p '${fixture.root}'`);
    const registry = makeRemoteAgentRegistryStore(fixture.root, fixture);
    const builds: RemoteAgentRegistryBuild[] = [];
    for (let number = 1; number <= 3; number++) {
      const bytes = `fixture-binary-${number}`;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const generation = `g${number}`;
      const statePath = `${fixture.root}/runtimes/${generation}`;
      const runtime = {
        generation,
        version: `0.2.${number}`,
        sha256,
        buildDigest: "fixture",
        targetTriple: "aarch64-unknown-linux-gnu",
        origin: "managed" as const,
        binaryPath: `${fixture.root}/bin/0.2.${number}/${sha256}/bigbud-remote-agent`,
        statePath,
        socketPath: `${statePath}/supervisor.sock`,
        logPath: `${statePath}/supervisor.log`,
      };
      await fixture.run(
        `umask 077; mkdir -p '${fixture.root}/bin/0.2.${number}/${sha256}' '${statePath}'; printf '%s' '${bytes}' > '${runtime.binaryPath}'; chmod 700 '${runtime.binaryPath}'; printf retained-log > '${runtime.logPath}'`,
      );
      builds.push({
        id: remoteAgentBuildId(runtime),
        runtime,
        health: "healthy",
        promotion: number,
        binary: "present",
        authenticated: true,
      });
    }
    await registry.update((state) => ({
      ...state,
      revision: state.revision + 1,
      builds,
      promotionSequence: 3,
      launches: builds.map((build) => ({
        id: build.runtime.generation,
        buildId: build.id,
        phase: "proven-dead",
        epoch: `epoch-${build.runtime.generation}`,
      })),
    }));
    return { control: { root: fixture.root, run: fixture.run, registry }, builds };
  }

  it("keeps restaging reservations and two healthy slots, deleting only an unreferenced binary and no logs", async () => {
    const { control, builds } = await setup();
    const old = builds[0]!;
    await control.registry.update((state) => reserveRemoteAgentStage(state, "restage", old));
    expect((await cleanupRemoteAgentBuilds(control)).deleted).toBe(0);
    await control.registry.update((state) => ({
      ...state,
      revision: state.revision + 1,
      stages: state.stages.map((stage) => ({ ...stage, phase: "cancelled" })),
    }));
    expect((await cleanupRemoteAgentBuilds(control)).deleted).toBe(1);
    expect(
      await fixture.run(`test ! -e '${old.runtime.binaryPath}'; cat '${old.runtime.logPath}'`),
    ).toBe("retained-log");
    for (const build of builds.slice(1))
      expect(await fixture.run(`test -f '${build.runtime.binaryPath}' && printf retained`)).toBe(
        "retained",
      );
  });

  it("rechecks ownership acquired after selection and before tombstoning", async () => {
    const { control, builds } = await setup();
    const update = control.registry.update;
    let raced = false;
    control.registry.update = async (transition) => {
      if (!raced) {
        raced = true;
        await update((state) => pinRemoteAgentBuild(state, "recovery-owner", builds[0]!.id));
      }
      return update(transition);
    };
    expect((await cleanupRemoteAgentBuilds(control)).deleted).toBe(0);
    expect(await fixture.run(`test -f '${builds[0]!.runtime.binaryPath}' && printf retained`)).toBe(
      "retained",
    );
  });

  it("reconciles an unlink with lost acknowledgement while retaining its tombstone", async () => {
    const { control, builds } = await setup();
    let lost = false;
    const failing = {
      ...control,
      run: async (command: string) => {
        const result = await control.run(command);
        if (!lost) {
          lost = true;
          throw new Error("lost deletion acknowledgement");
        }
        return result;
      },
    };
    await expect(cleanupRemoteAgentBuilds(failing)).rejects.toThrow(
      "lost deletion acknowledgement",
    );
    expect((await control.registry.read()).builds[0]?.binary).toBe("deleting");
    expect((await cleanupRemoteAgentBuilds(control)).deleted).toBe(1);
    expect((await control.registry.read()).builds[0]?.binary).toBe("absent");
    expect(await fixture.run(`cat '${builds[0]!.runtime.logPath}'`)).toBe("retained-log");
  });
});
