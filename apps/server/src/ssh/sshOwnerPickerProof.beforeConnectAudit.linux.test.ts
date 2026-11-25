import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";

import { makeRoutesLayer } from "../server.routes.ts";
import { buildAppUnderTest } from "../server.test.app.ts";
import { serverHttpTestLayer } from "../server.test.http.ts";
import { getWsServerUrl, serverTestLayer, withWsRpcClient } from "../server.test.rpc.ts";
import { activateDevSshOwner } from "./sshOwnerDevMode.fixture.ts";
import { makeSshOwnerDevPicker } from "./sshOwnerDevPicker.ts";
import { DevSshOwnerRuntime } from "./sshOwnerDevRuntime.ts";
import {
  startPickerProofOwner,
  type LaunchedPickerProofOwner,
} from "./sshOwnerPickerProof.client.ts";
import { storageScope } from "./sshOwnerPickerProof.integration.ts";
import { makeLinuxLoopbackPickerFixture } from "./sshPicker.loopback.fixture.linux.ts";
import { REMOTE_TARGET_DISCONNECTED_MESSAGE } from "./sshTargetDisconnects.ts";

const trace = process.env.BIGBUD_TEST_SSH_OWNER_STRACE_FILE;

function interval(log: string, start: string, end: string) {
  const lines = log.split("\n");
  const marker = (name: string) =>
    lines.findIndex((line) => /\brename(?:at2?)?\(/.test(line) && line.includes(`/${name}"`));
  const first = marker(start);
  const last = marker(end);
  expect(first, `missing syscall boundary ${start}`).toBeGreaterThanOrEqual(0);
  expect(last, `missing syscall boundary ${end}`).toBeGreaterThan(first);
  return lines.slice(first + 1, last);
}

function execPaths(lines: string[]) {
  return lines
    .filter((line) => /\bexecve(?:at)?\(/.test(line))
    .map((line) => {
      const match = /\bexecve(?:at)?\((?:[^,]+, )?"([^"\n]*)"/.exec(line);
      if (match?.[1] === undefined) throw new Error("Could not decode an exec syscall");
      return match[1];
    });
}

it.skipIf(process.platform !== "linux" || !trace)(
  "audits the restarted disconnected owner for resolver traffic and child launches before explicit Connect",
  async () => {
    const fixture = await makeLinuxLoopbackPickerFixture({ observeKeyDaemon: true });
    try {
      const mark = async (name: string) => {
        const input = path.join(fixture.root, "audit-marker");
        await writeFile(input, "", { flag: "wx", mode: 0o600 });
        await rename(input, path.join(fixture.root, name));
      };
      const binary = await fixture.installOwner(
        process.env.BIGBUD_SSH_OWNER_PICKER_PROOF_BIN ??
          fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url)),
      );
      await writeFile(fixture.knownHosts, `${fixture.host} ${await fixture.getHostPublicKey()}\n`, {
        mode: 0o600,
      });
      await fixture.start();
      const db = path.join(fixture.root, "audit.sqlite");
      const options = {
        binary,
        profileBinding: new Uint8Array(32).fill(7),
        targetId: `ssh:${fixture.loopback}:${fixture.port}`,
        lockFile: path.join(fixture.root, "owner.lock"),
        host: fixture.loopback,
        port: fixture.port,
        user: fixture.user,
        sshBinary: fixture.ssh,
        keyscanBinary: fixture.keyscan,
        identityFile: fixture.identity,
        knownHostsFile: fixture.knownHosts,
      };
      const epoch = await storageScope(db, (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({ ...options, sql });
          try {
            await owner.disconnect();
            return Uint8Array.from(owner.ownerEpoch);
          } finally {
            await owner.close();
          }
        }),
      );
      activateDevSshOwner();
      await storageScope(db, (sql) =>
        Effect.gen(function* () {
          let restarted: LaunchedPickerProofOwner | undefined;
          const picker = yield* Effect.acquireRelease(
            Effect.sync(() =>
              makeSshOwnerDevPicker({
                executionTargetId: options.targetId,
                host: fixture.host,
                startOwner: async (profileBinding) => {
                  const owner = await startPickerProofOwner({ ...options, sql, profileBinding });
                  try {
                    expect(owner.ownerEpoch).not.toEqual(epoch);
                    await mark("audit-after-restart");
                    restarted = owner;
                    return owner;
                  } catch (error) {
                    await owner.close();
                    throw error;
                  }
                },
              }),
            ),
            (value) => Effect.promise(value.close),
          );
          const runtime = Layer.succeed(DevSshOwnerRuntime, {
            session: {
              kind: "unix",
              alias: "proof-syscall-audit",
              targetId: options.targetId,
              fixture,
              picker,
              sql,
              terminal: undefined,
            },
          });
          const authToken = randomUUID();
          yield* buildAppUnderTest({
            config: { authToken },
            routes: makeRoutesLayer.pipe(Layer.provide(runtime)),
          });
          const url = yield* getWsServerUrl("/ws");
          yield* withWsRpcClient(`${url}?token=${authToken}`, (client) =>
            Effect.gen(function* () {
              const target = { executionTargetId: options.targetId };
              const read = client[WS_METHODS.serverListRemoteFolders]({
                ...target,
                path: fixture.folder,
              });
              // Establish the authenticated socket outside the audited interval. This
              // store-only call does not construct the owner for the selected target.
              expect(yield* client[WS_METHODS.serverListDisconnectedExecutionTargets]({})).toEqual({
                executionTargetIds: [options.targetId],
              });
              yield* Effect.promise(() => mark("audit-before-restart"));
              for (let attempt = 0; attempt < 3; attempt++) {
                expect(yield* read.pipe(Effect.flip)).toMatchObject({
                  _tag: "ServerListRemoteFoldersError",
                  message: REMOTE_TARGET_DISCONNECTED_MESSAGE,
                });
                const owner = restarted;
                if (!owner) throw new Error("The selected picker did not start the audited owner");
                yield* Effect.promise(() =>
                  expect(owner.sampleProofHealth(options.targetId)).rejects.toMatchObject({
                    code: "targetDisconnected",
                  }),
                );
              }
              yield* Effect.promise(() => mark("audit-before-connect"));
              expect(yield* client[WS_METHODS.serverConnectExecutionTarget](target)).toMatchObject({
                disconnected: false,
              });
              yield* Effect.promise(() => mark("audit-after-connect"));
              expect(yield* read).toMatchObject({ path: fixture.folder });
              yield* Effect.promise(() => mark("audit-after-read"));
            }).pipe(Effect.timeout("25 seconds")),
          );
        }).pipe(Effect.scoped, Effect.provide(Layer.merge(serverTestLayer, serverHttpTestLayer))),
      );
      const log = await readFile(trace!, "utf8");
      const boot = interval(log, "audit-before-restart", "audit-after-restart");
      const before = interval(log, "audit-after-restart", "audit-before-connect");
      const connect = interval(log, "audit-before-connect", "audit-after-connect");
      const positive = interval(log, "audit-after-connect", "audit-after-read");
      expect(
        execPaths(boot).filter((image) => image === path.join(fixture.root, "picker-owner")),
      ).toHaveLength(1);
      expect(
        execPaths(boot).filter(
          (image) =>
            ![
              binary,
              path.join(fixture.root, "picker-owner"),
              "/usr/bin/bwrap",
              "/bin/sh",
              "/usr/sbin/sshd",
              "/usr/bin/grep",
              "/usr/bin/id",
              "/usr/bin/sleep",
            ].includes(image),
        ),
      ).toEqual([]);
      expect(execPaths([...before, ...connect])).toEqual([]);
      const dial = /\b(?:connect|sendto|sendmsg|sendmmsg)\(.*\b(?:AF_INET6?|AF_UNIX|TCP|UDP)\b/;
      const launch = boot.filter((line) => line.includes('execve("/usr/sbin/sshd",'));
      expect(launch).toHaveLength(1);
      const daemonPid = launch[0]!.split(/\s+/, 1)[0];
      // The fixture daemon probes libc's local passwd/group cache at startup.
      // Permit only its own failed socket lookup, never a successful IPC or IP dial.
      const fixtureNssMiss = (line: string) =>
        line.startsWith(`${daemonPid} `) &&
        line.includes('sun_path="/var/run/nscd/socket"') &&
        line.includes("= -1 ENOENT");
      expect(boot.filter((line) => dial.test(line) && !fixtureNssMiss(line))).toEqual([]);
      expect([...before, ...connect].filter((line) => dial.test(line))).toEqual([]);
      const sshLaunch = positive.filter((line) => line.includes(`execve("${fixture.ssh}",`));
      expect(sshLaunch).toHaveLength(1);
      const sshPid = sshLaunch[0]!.split(/\s+/, 1)[0];
      expect(
        positive.some(
          (line) =>
            line.startsWith(`${sshPid} `) &&
            dial.test(line) &&
            line.includes(`htons(${fixture.port})`),
        ),
      ).toBe(true);
      expect(await fixture.readKeyDaemonLog()).toMatch(/^Accepted publickey for picker /m);
    } finally {
      await fixture.dispose();
    }
  },
  120_000,
);
