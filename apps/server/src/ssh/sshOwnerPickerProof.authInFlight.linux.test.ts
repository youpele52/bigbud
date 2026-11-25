import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it, vi } from "vitest";

import { makeSshOwnerDevPicker } from "./sshOwnerDevPicker.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import { storageScope } from "./sshOwnerPickerProof.integration.ts";
import { makeLinuxLoopbackPickerFixture } from "./sshPicker.loopback.fixture.linux.ts";
import { linuxPickerKeyDaemonLog } from "./sshPicker.loopback.fixture.linux.sandbox.ts";
import { REMOTE_TARGET_DISCONNECTED_MESSAGE } from "./sshTargetDisconnects.ts";

const run = promisify(execFile);
const optedIn =
  process.platform === "linux" && process.env.BIGBUD_TEST_SSH_OWNER_LINUX_AUTH_IN_FLIGHT === "1";
type Fixture = Awaited<ReturnType<typeof makeLinuxLoopbackPickerFixture>>;
interface ChildIdentity {
  readonly pid: number;
  readonly started: string;
  readonly command: string;
}

/** Exact owned master instances by PID, start time and argv; PID alone is not identity. */
async function masters(prefix: string): Promise<ChildIdentity[]> {
  const { stdout } = await run("/usr/bin/ps", ["-eww", "-o", "pid=,lstart=,args="], { env: {} });
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
    if (!match?.[3]?.includes("ControlMaster=yes") || !match[3].includes(`ControlPath=${prefix}`))
      return [];
    return [{ pid: Number(match[1]), started: match[2] ?? "", command: match[3] }];
  });
}
const stillRunning = async (child: ChildIdentity) =>
  (await masters("")).some(
    (live) =>
      live.pid === child.pid && live.started === child.started && live.command === child.command,
  );

async function scenario(
  name: string,
  body: (
    fixture: Fixture,
    gate: NonNullable<Fixture["hostKeyGate"]>,
    sql: SqlClient.SqlClient,
    picker: ReturnType<typeof makeSshOwnerDevPicker>,
    targetId: string,
    counts: () => Promise<{ connections: number; accepted: number }>,
  ) => Promise<void>,
) {
  const fixture = await makeLinuxLoopbackPickerFixture({
    observeKeyDaemon: true,
    hostKeyGate: true,
    outsideMaster: true,
  });
  const gate = fixture.hostKeyGate;
  if (!gate) throw new Error("Expected the host-key gate");
  try {
    const binary = await fixture.installOwner(
      process.env.BIGBUD_SSH_OWNER_PICKER_PROOF_BIN ??
        fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url)),
      { ownedMasterLane: true },
    );
    await writeFile(fixture.knownHosts, `${fixture.host} ${await fixture.getHostPublicKey()}\n`, {
      mode: 0o600,
    });
    await fixture.start();
    const targetId = `ssh:${fixture.loopback}:${fixture.port}`;
    const counts = async () => {
      const log = await readFile(path.join(fixture.root, linuxPickerKeyDaemonLog), "utf8").catch(
        () => "",
      );
      return {
        connections: log.match(/^Connection from /gm)?.length ?? 0,
        accepted: log.match(/^Accepted publickey /gm)?.length ?? 0,
      };
    };
    await storageScope(path.join(fixture.root, `${name}.sqlite`), (sql) =>
      Effect.promise(async () => {
        let starts = 0;
        const picker = makeSshOwnerDevPicker({
          executionTargetId: targetId,
          host: fixture.host,
          startOwner: (profileBinding) => {
            starts++;
            return startPickerProofOwner({
              binary,
              profileBinding,
              targetId,
              lockFile: path.join(fixture.root, "owner.lock"),
              host: fixture.loopback,
              port: fixture.port,
              user: fixture.user,
              sshBinary: fixture.ssh,
              keyscanBinary: fixture.keyscan,
              identityFile: fixture.identity,
              knownHostsFile: fixture.knownHosts,
              sql,
              posixMuxPickerCancellation: true,
            });
          },
          listWithCancellation: (owner, input, signal) =>
            owner.listCancellableRemoteFolders(input, signal),
        });
        try {
          await body(fixture, gate, sql, picker, targetId, counts);
          expect(starts).toBe(1);
        } finally {
          gate.release();
          await picker.close();
        }
      }),
    );
  } finally {
    gate.release();
    await fixture.dispose();
  }
}

/** The test-owned outside master in the same namespace; the owner must never touch it. */
async function outsideMaster(fixture: Fixture) {
  const [outside] = await masters(path.join(fixture.root, "outside.sock"));
  if (!outside) throw new Error("Expected the in-namespace outside master");
  const check = () =>
    run(
      "/usr/bin/ssh",
      ["-F", "/dev/null", "-S", path.join(fixture.root, "outside.sock"), "-O", "check", "outside"],
      { env: {} },
    );
  await check();
  return {
    async assertUntouched() {
      expect(await stillRunning(outside)).toBe(true);
      await check();
    },
  };
}

async function heldMaster(fixture: Fixture, gate: { isHeld(): boolean }) {
  await vi.waitFor(() => expect(gate.isHeld()).toBe(true), { timeout: 8_000 });
  const owned = await masters(`${fixture.root}/bbcm-`);
  expect(owned).toHaveLength(1);
  return owned[0]!;
}

it.skipIf(!optedIn)(
  "Linux: cancels one waiter while the native handshake is held and serves the other",
  () =>
    scenario("auth-waiter", async (fixture, gate, _sql, picker, targetId, counts) => {
      const target = { executionTargetId: targetId, path: fixture.folder };
      // Warm the owner so the held handshake belongs to the read, not to startup.
      await picker.connectExecutionTarget(target);
      const outside = await outsideMaster(fixture);
      const base = await counts();
      gate.arm();
      const controller = new AbortController();
      const first = picker.listRemoteFolders(target, controller.signal);
      void first.catch(() => undefined);
      const child = await heldMaster(fixture, gate);
      expect((await counts()).accepted).toBe(base.accepted);
      const second = picker.listRemoteFolders(target);
      void second.catch(() => undefined);
      controller.abort();
      await expect(first).rejects.toThrow();
      expect(await stillRunning(child)).toBe(false);
      gate.release();
      await expect(second).resolves.toMatchObject({ path: fixture.folder });
      const [replacement] = await masters(`${fixture.root}/bbcm-`);
      expect(replacement && replacement.pid !== child.pid).toBe(true);
      await vi.waitFor(async () => expect((await counts()).accepted).toBe(base.accepted + 1));
      expect((await counts()).connections).toBe(base.connections + 2);
      await outside.assertUntouched();
    }),
  90_000,
);

it.skipIf(!optedIn)(
  "Linux: fences a late native startup behind Disconnect and retires only its exact child",
  () =>
    scenario("auth-disconnect", async (fixture, gate, sql, picker, targetId, counts) => {
      const target = { executionTargetId: targetId, path: fixture.folder };
      await picker.connectExecutionTarget(target);
      const outside = await outsideMaster(fixture);
      const base = await counts();
      gate.arm();
      const active = picker.listRemoteFolders(target);
      void active.catch(() => undefined);
      const child = await heldMaster(fixture, gate);
      const queued = picker.listRemoteFolders(target);
      void queued.catch(() => undefined);
      await expect(picker.disconnectExecutionTarget(target)).resolves.toMatchObject({
        disconnected: true,
      });
      await expect(active).rejects.toThrow(REMOTE_TARGET_DISCONNECTED_MESSAGE);
      await expect(queued).rejects.toThrow(REMOTE_TARGET_DISCONNECTED_MESSAGE);
      expect(await stillRunning(child)).toBe(false);
      expect(await masters(`${fixture.root}/bbcm-`)).toEqual([]);
      const rows = await Effect.runPromise(
        sql<{ target_id: string }>`SELECT target_id FROM remote_execution_target_disconnects`,
      );
      expect(rows.map((row) => row.target_id)).toEqual([targetId]);
      const before = await counts();
      gate.release();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await expect(picker.listRemoteFolders(target)).rejects.toThrow(
        REMOTE_TARGET_DISCONNECTED_MESSAGE,
      );
      expect(await counts()).toEqual({ ...before, accepted: base.accepted });
      await outside.assertUntouched();
      await picker.connectExecutionTarget(target);
      expect((await counts()).connections).toBe(before.connections);
      await expect(picker.listRemoteFolders(target)).resolves.toMatchObject({
        path: fixture.folder,
      });
      await vi.waitFor(async () => expect((await counts()).accepted).toBe(base.accepted + 1));
      await outside.assertUntouched();
    }),
  90_000,
);
