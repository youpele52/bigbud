import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { makeRemoteAgentAdmission } from "./remoteAgentAdmission.ts";
import { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentRuntimeBinding } from "./remoteAgentConnectionPool.ts";
import { RemoteAgentProcessClient } from "./remoteAgentProcessClient.ts";
import { remoteAgentRequestDigest } from "./remoteAgentRequestDigest.ts";
import type { RemoteAgentRuntime } from "./remoteAgentRuntime.ts";
import { createRemoteAgentSetupFixture } from "./remoteAgentSetup.linux.fixture.ts";
import { makeRemoteAgentUpdateCoordinator } from "./remoteAgentUpdate.coordinator.ts";
import {
  createLinuxControlFixture,
  linuxControlAvailable,
  linuxFixtureName,
} from "./remoteAgentUpgrade.linux.fixtures.ts";
import { RemoteAgentWorkspaceClient } from "./remoteAgentWorkspaceClient.ts";

// A current source-built binary can be provided directly, without requiring old release fixtures.
const explicitBinary = process.env.BIGBUD_TEST_AGENT_BINARY?.trim();
const fixtureDirectory = process.env.BIGBUD_TEST_AGENT_FIXTURES?.trim();
const enabled =
  process.env.BIGBUD_TEST_LINUX_DOCKER === "1" &&
  linuxControlAvailable &&
  Boolean(explicitBinary || fixtureDirectory);

describe.runIf(enabled)("real Linux remote agent setup with production registry CAS", () => {
  it.for(["fresh", "retry-readiness-publication"])(
    "prepares %s setup, admits it, and runs a command",
    async (scenario, { skip }) => {
      const fixture = createLinuxControlFixture();
      const connections: RemoteAgentConnection[] = [];
      try {
        const architecture = (await fixture.run("uname -m")).trim();
        if (architecture !== "aarch64" && architecture !== "x86_64") {
          skip(`Unsupported container architecture: ${architecture}`);
          return;
        }
        const binaryPath =
          explicitBinary ?? join(fixtureDirectory!, linuxFixtureName("candidate", architecture));
        expect(existsSync(binaryPath), "The configured Linux agent binary must exist").toBe(true);
        const { target, control, source, manager } = await createRemoteAgentSetupFixture(
          fixture,
          binaryPath,
        );
        if (scenario === "retry-readiness-publication") {
          const installed = await manager.install({ executionTargetId: target, source });
          expect(installed.status).toBe("staged");
        }
        const staged = await control.registry.read();
        expect(staged.current).toBeNull();
        expect(staged.launches).toEqual([]);
        expect(staged.stages[0]?.phase).toBe(
          scenario === "retry-readiness-publication" ? "published" : undefined,
        );

        const connect = (_target: string, runtime: RemoteAgentRuntime) => {
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
        };
        const bindings = new Map<string, RemoteAgentRuntimeBinding>();
        const admission = makeRemoteAgentAdmission({
          control: async () => control,
          connect,
          bindings: {
            getBinding: async (target) => bindings.get(target),
            bindConnection: async (target, connectionId, binding) => {
              bindings.set(target, { ...binding, connectionId });
            },
            hasDurableReferences: async () => false,
            listConnectionIds: async () => [],
          },
        });
        await expect(admission.fresh(target, "before-preparation")).rejects.toMatchObject({
          code: "ADMISSION_UNAVAILABLE",
        });
        let metadataLoads = 0;
        const loadSource = async () => {
          metadataLoads += 1;
          return source;
        };
        const coordinator = makeRemoteAgentUpdateCoordinator({
          installManager: manager,
          loadInstallSource: Object.assign(loadSource, { refresh: loadSource }),
          openControl: async () => control,
          hasReusableCredentials: () => true,
          knownTargets: async () => [],
          connect,
        });
        let launches = 0;
        const runControl = control.run;
        control.run = async (command) => {
          if (command.includes("printf launch-reserved")) launches += 1;
          return runControl(command);
        };
        let previousEpoch: string | undefined;
        if (scenario === "retry-readiness-publication") {
          // Reproduce the old failure after a real supervisor/health check, before durable readiness.
          const updateRegistry = control.registry.update;
          let rejectReadiness = true;
          control.registry.update = (transition) =>
            updateRegistry((current) => {
              const next = transition(current);
              if (rejectReadiness && next.launches.some((launch) => launch.phase === "ready")) {
                rejectReadiness = false;
                throw new Error("Invalid registry transition revision.");
              }
              return next;
            });
          await expect(
            coordinator.prepareForAdmission(target, "after-preparation"),
          ).rejects.toThrow("Invalid registry transition revision.");
          const interrupted = await control.registry.read();
          expect(interrupted.launches[0]?.phase).toBe("spawn-uncertain");
          expect(interrupted.updates[0]?.phase).toBe("uncertain");
          const runtime = interrupted.builds.find(
            (build) => build.id === interrupted.pending,
          )!.runtime;
          previousEpoch = (await fixture.run(`cat '${runtime.statePath}/epoch'`)).trim();
        }
        // The real store still enforces exactly one revision for every successful publication.
        await coordinator.prepareForAdmission(target, "after-preparation");
        expect(metadataLoads).toBe(scenario === "fresh" ? 1 : 2);
        expect(launches).toBe(1);
        const ready = await control.registry.read();
        expect(ready.current).toBeNull();
        expect(ready.stages[0]?.phase).toBe("published");
        expect(ready.launches[0]?.phase).toBe("ready");
        expect(ready.updates[0]?.phase).toBe("ready-for-reconnect");
        const preparedEpoch = ready.launches[0]?.epoch;
        if (previousEpoch) expect(preparedEpoch).toBe(previousEpoch);
        const result = await admission.fresh(target, "after-preparation");
        expect(result.state.current).toBe(ready.pending);
        const binding = await admission.resolveBinding(target);
        expect(binding?.expectedEpoch).toBe(preparedEpoch);
        const connection = connect(target, binding!.runtime);
        await connection.handshake();
        await new RemoteAgentWorkspaceClient(connection).openWorkspace("setup", "/tmp/workspace");
        const process = await new RemoteAgentProcessClient(connection).run({
          workspaceHandle: "setup",
          operationId: "setup-command",
          requestDigest: remoteAgentRequestDigest("setup-command"),
          command: "sh",
          args: ["-c", "printf agent-setup-ready"],
          timeoutMs: 5_000,
        });
        expect(new TextDecoder().decode(process.stdout)).toBe("agent-setup-ready");
        expect(process.completed.exitCode).toBe(0);
      } finally {
        for (const connection of connections) connection.close();
        fixture.close();
      }
    },
  );
});
