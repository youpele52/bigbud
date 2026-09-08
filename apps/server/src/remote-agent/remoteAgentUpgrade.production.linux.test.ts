import { installSourceFixture } from "./remoteAgentUpgrade.installFixture.ts";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Effect, ManagedRuntime } from "effect";
import * as NodeSqlite from "../persistence/NodeSqliteClient.ts";
import OwnersMigration from "../persistence/Migrations/111_RemoteAgentRuntimeBindings.ts";
import ReplayMigration from "../persistence/Migrations/112_RemoteAgentReplayFence.ts";
const Migration = Effect.andThen(OwnersMigration, ReplayMigration);
import { makeRemoteAgentRuntimeBindings } from "../persistence/Layers/RemoteAgentRuntimeBindings.ts";
import type { RemoteAgentOwnerStore } from "./remoteAgentOwners.ts";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import { RemoteAgentConnectionPool } from "./remoteAgentConnectionPool.ts";
import { RemoteAgentProcessClient } from "./remoteAgentProcessClient.ts";
import { openRemoteAgentControl } from "./remoteAgentControl.ts";
import { makeRemoteAgentAdmission } from "./remoteAgentAdmission.ts";
import {
  countPhysicalRemoteAgentExecutables,
  createLinuxControlFixture,
  linuxFixtureAvailability,
  linuxFixtureName,
  type LinuxFixtureArchitecture,
} from "./remoteAgentUpgrade.linux.fixtures.ts";
import { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";
import { remoteAgentRequestDigest } from "./remoteAgentRequestDigest.ts";
import { reconcileRemoteAgentLaunchExits } from "./remoteAgentInstall.reconcile.ts";

const architectures: ReadonlyArray<LinuxFixtureArchitecture> = ["aarch64", "x86_64"];

for (const architecture of architectures) {
  const gate = linuxFixtureAvailability(architecture, ["legacy", "candidate", "journal-seed"]);
  const legacyFixture = gate.available ? linuxFixtureName("legacy", architecture) : "";
  const candidateFixture = gate.available ? linuxFixtureName("candidate", architecture) : "";
  describe.runIf(gate.available).each(["fresh", "unmatched", "expired"])(
    `production install/admission with ${architecture} Linux %s journal${
      gate.available ? "" : ` (skipped: ${gate.reason})`
    }`,
    (history) => {
      let architectureSkipReason: string | undefined;
      let directory: string;
      let local: ReturnType<
        typeof ManagedRuntime.make<import("effect/unstable/sql/SqlClient").SqlClient, never>
      >;
      let bindings: RemoteAgentOwnerStore;
      let fixture: ReturnType<typeof createLinuxControlFixture>;
      const connections: RemoteAgentConnection[] = [];
      const home = "/tmp/home";
      const root = `${home}/.bigbud/agent`;
      beforeAll(async () => {
        directory = mkdtempSync(join(tmpdir(), "bigbud-linux-admission-"));
        local = ManagedRuntime.make(
          NodeSqlite.layer({ filename: join(directory, "routes.sqlite") }),
        );
        await local.runPromise(Migration);
        bindings = await local.runPromise(makeRemoteAgentRuntimeBindings);
        fixture = createLinuxControlFixture();
        const containerArchitecture = (await fixture.run("uname -m")).trim();
        if (containerArchitecture !== architecture) {
          architectureSkipReason = `matching ${architecture} container is unavailable (got ${containerArchitecture})`;
          return;
        }
        await fixture.run(`umask 077; mkdir -p -m 700 '${root}/state'`);
        if (history !== "fresh")
          await fixture.run(
            `/fixtures/legacy-journal-seed '${root}/state/operations.journal' '${history}'`,
          );
        await fixture.run(
          `umask 077; mkdir -p -m 700 '${root}/bin' '${root}/state' /tmp/workspace; ln -s '/fixtures/${legacyFixture}' '${root}/bin/current'; BIGBUD_AGENT_STATE_DIR='${root}/state' nohup '/fixtures/${legacyFixture}' --supervisor </dev/null >/tmp/legacy.log 2>&1 &`,
        );
        await fixture.run(
          `for n in $(seq 1 100); do test ! -S '${root}/state/supervisor.sock' || exit 0; sleep .05; done; exit 1`,
        );
      });
      afterAll(async () => {
        for (const connection of connections) connection.close();
        fixture?.close();
        await local?.dispose();
        if (directory) rmSync(directory, { recursive: true, force: true });
      });

      it("stages authenticated test bytes without startup, retains old clients, and activates only on fresh admission", async ({
        skip,
      }) => {
        if (architectureSkipReason) {
          skip(architectureSkipReason);
          return;
        }
        const run = (command: string) => fixture.run(`export HOME='${home}'; ${command}`);
        const execute = async (input: { args?: ReadonlyArray<string> }) => ({
          stdout: await run(input.args?.[1] ?? "exit 1"),
        });
        const control = await openRemoteAgentControl("ssh:fixture", execute);
        const admission = makeRemoteAgentAdmission({
          bindings,
          control: async () => control,
          connect: (_target, runtime) => {
            const connection = RemoteAgentConnection.local({
              binaryPath: "docker",
              args: [
                "exec",
                "-i",
                "-e",
                `BIGBUD_AGENT_STATE_DIR=${runtime.statePath}`,
                fixture.container!,
                runtime.binaryPath,
                "--proxy",
              ],
            });
            connections.push(connection);
            return connection;
          },
        });
        const pool = new RemoteAgentConnectionPool({
          resolveBinding: admission.resolveBinding,
          create: async (_target, binding) => {
            if (!binding) throw new Error("Missing runtime binding");
            const connection = RemoteAgentConnection.local({
              binaryPath: "docker",
              args: [
                "exec",
                "-i",
                "-e",
                `BIGBUD_AGENT_STATE_DIR=${binding.runtime.statePath}`,
                fixture.container!,
                binding.runtime.binaryPath,
                "--proxy",
              ],
            });
            connections.push(connection);
            return connection;
          },
        });
        const old = await pool.getProcessClient("ssh:fixture");
        await new RemoteAgentWorkspaceClient(old.connection).openWorkspace(
          "workspace",
          "/tmp/workspace",
        );
        const oldEpoch = pool.snapshot("ssh:fixture").agentEpoch;
        const independent = RemoteAgentConnection.local({
          binaryPath: "docker",
          args: [
            "exec",
            "-i",
            "-e",
            `BIGBUD_AGENT_STATE_DIR=${root}/state`,
            fixture.container!,
            `/fixtures/${legacyFixture}`,
          ],
        });
        connections.push(independent);
        await independent.handshake();
        await new RemoteAgentWorkspaceClient(independent).openWorkspace(
          "independent",
          "/tmp/workspace",
        );
        const independentRun = (phase: string) =>
          new RemoteAgentProcessClient(independent).run({
            workspaceHandle: "independent",
            operationId: `independent-${phase}`,
            requestDigest: remoteAgentRequestDigest(phase),
            command: "/bin/sh",
            args: [
              "-c",
              `printf '${phase} ' >> /tmp/workspace/independent${phase === "during" ? "; while test ! -f /tmp/workspace/release; do sleep .05; done" : ""}`,
            ],
            timeoutMs: 60_000,
          });
        await independentRun("before");
        // Opening the independent legacy stdio session rotates its own state epoch; candidate must not.
        const diskEpoch = await run(`cat '${root}/state/epoch'`);
        const journalBeforeStage = await run(`sha256sum '${root}/state/operations.journal'`);
        const bytes = readFileSync(join(process.env.BIGBUD_TEST_AGENT_FIXTURES!, candidateFixture));
        const installed = await installSourceFixture(
          fixture,
          home,
          control,
          bytes,
          "0.2.207",
          "1d02e44cd090cc0e2bce25a2cca1a88442e4873e",
          architecture,
        );
        expect(installed.status).toBe("staged");
        expect(await countPhysicalRemoteAgentExecutables(fixture, root)).toBe(1);
        const staged = await control.registry.read();
        const candidate = staged.builds.find((build) => build.id === staged.pending)!;
        expect(await run(`test ! -e '${candidate.runtime.statePath}' && printf not-started`)).toBe(
          "not-started",
        );
        expect(await run(`readlink '${root}/bin/current'`)).toBe(`/fixtures/${legacyFixture}\n`);
        expect((await admission.resolveBinding("ssh:fixture"))?.expectedEpoch).toBe(oldEpoch);
        expect(staged.pending).not.toBeNull();
        expect(await run(`sha256sum '${root}/state/operations.journal'`)).toBe(journalBeforeStage);
        const operation = old.run({
          workspaceHandle: "workspace",
          operationId: "one-marker",
          requestDigest: remoteAgentRequestDigest("one-marker"),
          command: "/bin/sh",
          args: [
            "-c",
            "printf marker >> /tmp/workspace/marker; while test ! -f /tmp/workspace/release; do sleep .05; done; printf old-result",
          ],
          timeoutMs: 60_000,
        });
        await run(
          "for n in $(seq 1 100); do test ! -f /tmp/workspace/marker || exit 0; sleep .02; done; exit 1",
        );
        pool.markTransportLoss("ssh:fixture");
        const independentDuring = independentRun("during");
        await run(
          "for n in $(seq 1 100); do grep -q during /tmp/workspace/independent && exit 0; sleep .02; done; exit 1",
        );
        const fresh = await admission.fresh("ssh:fixture", "deliberate-fresh");
        expect(fresh.state.current).toBe(candidate.id);
        expect(fresh.state.pending).toBeNull();
        expect(await run("test ! -f /tmp/workspace/release && printf still-held")).toBe(
          "still-held",
        );
        await run("touch /tmp/workspace/release");
        await independentDuring;
        expect(new TextDecoder().decode((await operation).stdout)).toBe("old-result");
        expect(await run("cat /tmp/workspace/marker")).toBe("marker");
        expect(await run(`cat '${root}/state/epoch'`)).toBe(diskEpoch);
        await independentRun("after");
        expect(await run("cat /tmp/workspace/independent")).toBe("before during after ");
        expect((await admission.resolveBinding("ssh:fixture"))?.runtime.generation).toBe(
          candidate.runtime.generation,
        );
        expect((await admission.fresh("ssh:fixture", "deliberate-fresh")).connectionId).toBe(
          "deliberate-fresh",
        );
        pool.closeAll();
      });

      it("retains two real healthy versions and falls back to verified legacy after build-specific startup failure", async ({
        skip,
      }) => {
        if (architectureSkipReason) {
          skip(architectureSkipReason);
          return;
        }
        const execute = async (input: { args?: ReadonlyArray<string> }) => ({
          stdout: await fixture.run(`export HOME='${home}'; ${input.args?.[1] ?? "exit 1"}`),
        });
        const control = await openRemoteAgentControl("ssh:fixture", execute);
        const admission = makeRemoteAgentAdmission({
          bindings,
          control: async () => control,
          connect: (_target, runtime) => {
            const connection = RemoteAgentConnection.local({
              binaryPath: "docker",
              args: [
                "exec",
                "-i",
                "-e",
                `BIGBUD_AGENT_STATE_DIR=${runtime.statePath}`,
                fixture.container!,
                runtime.binaryPath,
                "--proxy",
              ],
            });
            connections.push(connection);
            return connection;
          },
        });
        const legacyBytes = readFileSync(
          join(process.env.BIGBUD_TEST_AGENT_FIXTURES!, legacyFixture),
        );
        await installSourceFixture(
          fixture,
          home,
          control,
          legacyBytes,
          "0.2.205",
          "461b7865cd28bb2570d9f580405fa53daee7b51f",
          architecture,
        );
        const legacyAdmission = await admission.fresh("ssh:fixture", "fresh-verified-legacy");
        expect(
          legacyAdmission.state.builds
            .filter((build) => build.health === "healthy")
            .map((build) => build.runtime.version)
            .toSorted(),
        ).toEqual(["0.2.205", "0.2.207"]);
        const broken = new TextEncoder().encode(
          `#!/bin/sh\nif test "$1" = --check; then printf 'bigbud-remote-agent\\t0.2.208\\t1\\t2\\tbroken-fixture\\tlinux\\t${architecture}\\n'; exit 0; fi\nexit 1\n`,
        );
        await installSourceFixture(
          fixture,
          home,
          control,
          broken,
          "0.2.208",
          "broken-fixture",
          architecture,
        );
        const fallback = await admission.fresh("ssh:fixture", "fresh-fallback");
        expect(
          fallback.state.builds.find((build) => build.id === fallback.state.current)?.runtime
            .version,
        ).toBe("0.2.205");
        expect(
          fallback.state.builds.find((build) => build.runtime.version === "0.2.208")?.health,
        ).toBe("quarantined");
        expect(fallback.state.builds.filter((build) => build.health === "healthy")).toHaveLength(2);
        expect(await fixture.run(`readlink '${root}/bin/current'`)).toBe(
          `/fixtures/${legacyFixture}\n`,
        );
      });

      it("reconciles actual managed supervisor death without invalidating historical admissions or recovery pins", async ({
        skip,
      }) => {
        if (architectureSkipReason) {
          skip(architectureSkipReason);
          return;
        }
        const control = await openRemoteAgentControl("ssh:fixture", async (input) => ({
          stdout: await fixture.run(`export HOME='${home}'; ${input.args?.[1] ?? "exit 1"}`),
        }));
        const before = await control.registry.read();
        const build = before.builds.find((entry) => entry.id === before.current)!;
        await control.registry.update((state) => ({
          ...state,
          revision: state.revision + 1,
          pins: [...state.pins, { owner: "recovery:fixture", buildId: build.id }],
        }));
        await fixture.runInput(
          "python3 -",
          `import os, signal, socket, struct
s = socket.socket(socket.AF_UNIX)
s.connect(${JSON.stringify(build.runtime.socketPath)})
pid, uid, gid = struct.unpack('3i', s.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
assert uid == os.getuid() and pid > 1
fd = os.pidfd_open(pid)
signal.pidfd_send_signal(fd, signal.SIGTERM)
os.close(fd)
s.close()
`,
        );
        await fixture.run(
          `for n in $(seq 1 100); do test ! -f '${build.runtime.statePath}/launch.exit' || exit 0; sleep .05; done; exit 1`,
        );
        await reconcileRemoteAgentLaunchExits(control);
        const after = await control.registry.read();
        expect(after.launches.find((entry) => entry.buildId === build.id)?.phase).toBe(
          "proven-dead",
        );
        expect(after.admissions).toEqual(before.admissions);
        expect(after.pins).toContainEqual({ owner: "recovery:fixture", buildId: build.id });
      });
    },
  );
}
