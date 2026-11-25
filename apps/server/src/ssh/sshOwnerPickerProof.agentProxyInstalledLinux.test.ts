import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { expect, it } from "vitest";

import type { RemoteAgentProxyLease } from "../remote-agent/remoteAgentConnection.owner.ts";
import { makeRemoteAgentComposition } from "../remote-agent/remoteAgentComposition.ts";
import { parseRemoteAgentCheckOutput } from "../remote-agent/remoteAgentIdentity.ts";
import type { RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import { observeLocalInstalledSupervisor } from "../remote-agent/remoteAgentComposition.installedObservation.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import { storageScope } from "./sshOwnerPickerProof.integration.ts";
import { makeLinuxLoopbackPickerFixture } from "./sshPicker.loopback.fixture.linux.ts";

const optedIn =
  process.platform === "linux" && process.env.BIGBUD_TEST_SSH_OWNER_PICKER_PROOF === "1";
const buildDir = new URL("../../../../target/debug/", import.meta.url);
const timeoutMs = 5_000;

type Fixture = Awaited<ReturnType<typeof makeLinuxLoopbackPickerFixture>>;

async function stageInstalledAgent(fixture: Fixture) {
  const source = new URL("bigbud-remote-agent", buildDir);
  const identity = parseRemoteAgentCheckOutput(
    execFileSync(fileURLToPath(source), ["--check"], { encoding: "utf8", timeout: timeoutMs }),
  );
  expect(identity.operatingSystem).toBe("linux");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(source)) digest.update(chunk);
  const sha256 = digest.digest("hex");
  const generation = "fixture-1";
  const root = path.join(fixture.root, "installed");
  const statePath = path.join(root, "runtimes", generation);
  const binaryPath = path.join(root, "bin", identity.version, sha256, "bigbud-remote-agent");
  await mkdir(path.dirname(binaryPath), { mode: 0o700, recursive: true });
  await mkdir(statePath, { mode: 0o700, recursive: true });
  await copyFile(source, binaryPath);
  await chmod(binaryPath, 0o500);
  return {
    generation,
    sha256,
    binaryPath,
    statePath,
    version: identity.version,
    buildDigest: identity.buildDigest,
    targetTriple: `${identity.architecture}-unknown-linux-gnu`,
    socketPath: path.join(statePath, "supervisor.sock"),
    logPath: path.join(statePath, "supervisor.log"),
    origin: "managed",
  } satisfies RemoteAgentRuntime;
}

async function installOwnerWithSupervisor(fixture: Fixture, runtime: RemoteAgentRuntime) {
  // The fixture starts sshd first. This test-only wrapper then starts the real
  // supervisor in the same namespace, before replacing itself with the owner.
  const nativeOwner = path.join(fixture.root, "native-owner");
  await copyFile(new URL("bigbud-ssh-owner", buildDir), nativeOwner);
  await chmod(nativeOwner, 0o700);
  const startup = path.join(fixture.root, "owner-with-supervisor");
  await writeFile(
    startup,
    [
      "#!/bin/sh",
      "set -eu",
      "umask 077",
      "root=${0%/*}",
      `state="$root/${path.relative(fixture.root, runtime.statePath)}"`,
      `BIGBUD_AGENT_STATE_DIR="$state" "$root/${path.relative(fixture.root, runtime.binaryPath)}" --supervisor \\`,
      '  3<&- 4>&- 5>&- </dev/null >"$state/supervisor.log" 2>&1 &',
      "supervisor=$!",
      "attempt=0",
      'until [ -S "$state/supervisor.sock" ] && [ -s "$state/epoch" ]; do',
      '  if ! kill -0 "$supervisor" 2>/dev/null || [ "$attempt" -ge 50 ]; then',
      '    tail -n 10 "$state/supervisor.log" >&2',
      "    exit 1",
      "  fi",
      "  attempt=$((attempt + 1))",
      "  sleep 0.1",
      "done",
      'exec "$root/native-owner" "$@"',
      "",
    ].join("\n"),
    { mode: 0o700, flag: "wx" },
  );
  return fixture.installOwner(startup);
}

it.skipIf(!optedIn)(
  "binds selected workspace traffic to the installed Linux supervisor through the typed Rust owner",
  async () => {
    const fixture = await makeLinuxLoopbackPickerFixture();
    try {
      const runtime = await stageInstalledAgent(fixture);
      const stateDir = runtime.statePath;
      const agentProxyFixture = { binaryPath: runtime.binaryPath, sha256: runtime.sha256 };
      const binary = await installOwnerWithSupervisor(fixture, runtime);
      const targetId = `ssh:${fixture.host}`;
      await storageScope(path.join(fixture.root, "installed-agent.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            binary,
            sql,
            profileBinding: randomBytes(32),
            targetId,
            lockFile: path.join(fixture.root, "owner.lock"),
            sshBinary: fixture.ssh,
            keyscanBinary: fixture.keyscan,
            host: fixture.loopback,
            port: fixture.port,
            user: fixture.user,
            identityFile: fixture.identity,
            knownHostsFile: fixture.knownHosts,
            agentProxyFixture,
            installedAgentStateDir: stateDir,
          });
          try {
            const epoch = await readFile(path.join(stateDir, "epoch"), "utf8");
            const observe = () =>
              observeLocalInstalledSupervisor({
                executionTargetId: targetId,
                runtime,
                expectedEpoch: epoch,
              });
            const direct = await observe();

            const trust = await owner.inspectTrust();
            if (trust.state !== "approvalRequired")
              throw new Error("Expected fixture trust approval");
            await expect(owner.approveTrust(trust.challenge)).resolves.toMatchObject({
              state: "verified",
              fingerprint: trust.fingerprint,
            });
            let exit: RemoteAgentProxyLease["exit"] | undefined;
            const composition = makeRemoteAgentComposition({
              installedProxy: {
                executionTargetId: targetId,
                binding: {
                  runtime: direct.runtime,
                  expectedEpoch: direct.supervisorEpoch,
                  expectedInstanceId: direct.agentInstanceId,
                },
                owner: {
                  openAgentProxy: async (target, signal) => {
                    const lease = await owner.openProofAgentProxy(
                      {
                        executionTargetId: target.executionTargetId,
                        binaryPath: target.runtime.binaryPath,
                        sha256: target.runtime.sha256,
                      },
                      signal,
                    );
                    exit = lease.exit;
                    return lease;
                  },
                },
              },
            });
            try {
              const workspace = await composition.pool.getWorkspaceClient(targetId);
              try {
                expect(workspace.connection.processId).toBeUndefined();
                const handle = randomUUID();
                await expect(
                  workspace.openWorkspace(handle, fixture.folder),
                ).resolves.toMatchObject({
                  workspaceHandle: handle,
                  accepted: true,
                });
                await workspace.connection.gracefulClose(timeoutMs);
                await expect(exit).resolves.toEqual({ code: 0, signal: null });
              } finally {
                await workspace.connection.closeConfirmed(timeoutMs);
              }
            } finally {
              composition.pool.closeAll();
            }
            await expect(observe()).resolves.toEqual(direct);
          } finally {
            await owner.close();
          }
        }),
      );
    } finally {
      await fixture.dispose();
    }
  },
  30_000,
);
