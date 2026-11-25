import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { Effect, Fiber, Layer, Option, Stream } from "effect";
import { expect, it, vi } from "vitest";

import { makeRoutesLayer } from "../server.routes.ts";
import { buildAppUnderTest } from "../server.test.app.ts";
import { serverHttpTestLayer } from "../server.test.http.ts";
import { getWsServerUrl, serverTestLayer, withWsRpcClient } from "../server.test.rpc.ts";
import { activateDevSshOwner } from "./sshOwnerDevMode.ts";
import { makeSshOwnerDevPicker } from "./sshOwnerDevPicker.ts";
import { DevSshOwnerRuntime } from "./sshOwnerDevRuntime.ts";
import { bindDevOwnerAlias } from "./sshOwnerDevRuntime.profileConfig.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  rejectStartup,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLinuxLoopbackPickerFixture } from "./sshPicker.loopback.fixture.linux.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

const execute = promisify(execFile);

async function fixtureChildren(identity: string) {
  const { stdout } = await execute(
    "/bin/ps",
    [process.platform === "linux" ? "-eww" : "-axww", "-o", "pid=,lstart=,args="],
    {
      env: {},
    },
  );
  return stdout
    .split("\n")
    .filter((line) => /\s\/usr\/bin\/ssh\s/.test(line) && line.includes(`-i ${identity} `));
}

const linuxOptedIn =
  process.platform === "linux" &&
  process.arch === "arm64" &&
  process.env.BIGBUD_TEST_SSH_OWNER_LINUX_SNAPSHOT_CANCEL === "approved-disposable";

async function makeScenario(interactive: boolean, snapshotCancellation = true) {
  if (process.platform === "linux") {
    const fixture = await makeLinuxLoopbackPickerFixture({
      observeKeyDaemon: true,
      hostKeyGate: true,
    });
    return {
      fixture,
      gate: fixture.hostKeyGate,
      options: async () => ({
        binary: await fixture.installOwner(
          process.env.BIGBUD_SSH_OWNER_PICKER_PROOF_BIN ??
            fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url)),
          { snapshotCancellation },
        ),
        targetId: "ssh:host=rust-ssh-owner-dev&auth=ssh-key&transport=direct-ssh",
        lockFile: path.join(fixture.root, "owner.lock"),
        host: fixture.loopback,
        port: fixture.port,
        user: fixture.user,
        sshBinary: fixture.ssh,
        keyscanBinary: fixture.keyscan,
        identityFile: fixture.identity,
        knownHostsFile: fixture.knownHosts,
      }),
      publicKey: fixture.getHostPublicKey,
      counts: async () => {
        const log = await fixture.readKeyDaemonLog();
        return [
          log.match(/^Connection from /gm)?.length ?? 0,
          log.match(/^Accepted publickey /gm)?.length ?? 0,
        ];
      },
    };
  }
  const fixture = await makeLoopbackPickerFixture({
    authenticationGate: true,
    snapshotCancellation: !interactive,
    allowInteractiveShell: interactive,
  });
  return {
    fixture,
    gate: fixture.authGate,
    options: () => proofOptions(fixture, undefined, interactive),
    publicKey: async () => fixture.hostPublicKey,
    counts: async () => [fixture.connectionStarts(), fixture.acceptedPublicKeys()],
    launchNames: fixture.launchNames,
  };
}

it.skipIf(!(process.platform === "darwin" && pickerProofOptedIn) && !linuxOptedIn).each(
  process.platform === "linux"
    ? [{ mode: "disposable Debian direct", interactive: false }]
    : [
        { mode: "snapshot-only", interactive: false },
        { mode: "selected alias with terminal enabled", interactive: true },
      ],
)(
  "$mode unsubscribes an active snapshot without closing the owner or canceling another watch",
  async ({ interactive }) => {
    const {
      fixture,
      gate,
      options: makeOptions,
      publicKey,
      counts,
      launchNames,
    } = await makeScenario(interactive);
    try {
      if (!gate) throw new Error("Expected an authentication gate");
      const options = await makeOptions();
      const alias = "proof-ws-snapshot-cancel";
      const { aliasConfig } = interactive ? await bindDevOwnerAlias(fixture, alias, undefined) : {};
      const targetId = options.targetId;
      await writeFile(fixture.knownHosts, `${fixture.host} ${await publicKey()}\n`, {
        mode: 0o600,
      });
      await fixture.start();
      await gate.arm();
      activateDevSshOwner();
      await storageScope(path.join(fixture.root, "watch-cancel.sqlite"), (sql) =>
        Effect.gen(function* () {
          const outcomes: Promise<unknown>[] = [];
          const startOwner = vi.fn(async (profileBinding: Uint8Array) => {
            const owner = await startPickerProofOwner({
              ...options,
              profileBinding,
              sql,
              workspaceRoot: fixture.folder,
              posixWorkspaceSnapshotCancellation: true,
              ...(aliasConfig ? { aliasConfig, devInteractiveTerminal: true } : {}),
            });
            const snapshot = owner.snapshotProofWorkspaceDirectory;
            vi.spyOn(owner, "snapshotProofWorkspaceDirectory").mockImplementation((...args) => {
              const result = snapshot(...args);
              outcomes.push(
                result.then(
                  () => "completed",
                  (error: unknown) => error,
                ),
              );
              return result;
            });
            return owner;
          });
          const picker = yield* Effect.acquireRelease(
            Effect.sync(() =>
              makeSshOwnerDevPicker({
                executionTargetId: targetId,
                host: fixture.host,
                startOwner,
              }),
            ),
            (value) => Effect.promise(value.close),
          );
          const authToken = randomUUID();
          const runtime = Layer.succeed(DevSshOwnerRuntime, {
            session: {
              kind: "unix",
              alias,
              targetId,
              fixture,
              picker,
              sql,
              terminal: undefined,
            },
          });
          yield* buildAppUnderTest({
            config: { authToken },
            routes: makeRoutesLayer.pipe(Layer.provide(runtime)),
          });
          const endpoint = `${yield* getWsServerUrl("/ws")}?token=${authToken}`;
          const input = { executionTargetId: targetId, cwd: fixture.folder };
          const subscribe = withWsRpcClient(endpoint, (client) =>
            Stream.runHead(client[WS_METHODS.subscribeProjectDirectoryChanges](input)),
          );
          const canceled = yield* Effect.forkScoped(subscribe);
          yield* Effect.promise(() =>
            vi.waitFor(async () => expect(await gate.isHeld()).toBe(true), { timeout: 5_000 }),
          );
          const children = yield* Effect.promise(() => fixtureChildren(fixture.identity));
          expect(children).toHaveLength(1);
          expect((yield* Effect.promise(counts))[1]).toBe(0);
          const remaining = yield* Effect.forkScoped(subscribe);
          yield* Fiber.interrupt(canceled);
          yield* Effect.promise(() =>
            vi.waitFor(
              async () => {
                expect(await fixtureChildren(fixture.identity)).not.toContain(children[0]);
              },
              { timeout: 3_000 },
            ),
          );
          const event = yield* Fiber.join(remaining);
          expect(yield* Effect.promise(() => Promise.all(outcomes))).toEqual([
            expect.objectContaining({ code: "listCancelled" }),
            "completed",
          ]);
          expect(Option.getOrUndefined(event)).toMatchObject({
            type: "directoryChanged",
            generation: 1,
          });
          expect(startOwner).toHaveBeenCalledTimes(1);
          expect(yield* Effect.promise(counts)).toEqual([2, 1]);
          if (launchNames) expect(yield* Effect.promise(launchNames)).toEqual([]);
        }).pipe(
          Effect.scoped,
          Effect.timeout("20 seconds"),
          Effect.provide(Layer.merge(serverTestLayer, serverHttpTestLayer)),
        ),
      );
    } finally {
      await gate?.release();
      await fixture.dispose();
    }
  },
  60_000,
);

it.skipIf(!linuxOptedIn)(
  "does not bind Linux FD3 without the disposable launcher opt-in",
  async () => {
    const { fixture, options } = await makeScenario(false, false);
    try {
      const startup = await options();
      await storageScope(path.join(fixture.root, "watch-cancel-refused.sqlite"), (sql) =>
        Effect.promise(() =>
          rejectStartup(
            startPickerProofOwner({
              ...startup,
              profileBinding: randomBytes(32),
              workspaceRoot: fixture.folder,
              posixWorkspaceSnapshotCancellation: true,
              sql,
            }),
            "ownerUnavailable",
          ),
        ),
      );
    } finally {
      await fixture.dispose();
    }
  },
);
