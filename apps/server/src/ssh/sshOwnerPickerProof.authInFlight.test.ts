import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it, vi } from "vitest";

import { makeSshOwnerDevPicker } from "./sshOwnerDevPicker.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";
import { REMOTE_TARGET_DISCONNECTED_MESSAGE } from "./sshTargetDisconnects.ts";

const run = promisify(execFile);
type Fixture = Awaited<ReturnType<typeof makeLoopbackPickerFixture>>;
interface ChildIdentity {
  readonly pid: number;
  readonly started: string;
  readonly command: string;
}

/** Exact process instances whose argv selects a ControlPath under `prefix` (pid alone is not identity). */
async function masters(prefix: string): Promise<ChildIdentity[]> {
  const { stdout } = await run("/bin/ps", ["-axww", "-o", "pid=,lstart=,command="], { env: {} });
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
    fixture: Fixture & { authGate: NonNullable<Fixture["authGate"]> },
    sql: SqlClient.SqlClient,
    picker: ReturnType<typeof makeSshOwnerDevPicker>,
    starts: () => number,
  ) => Promise<void>,
  beforeDispose: () => void = () => undefined,
) {
  const fixture = await makeLoopbackPickerFixture({ authenticationGate: true });
  const { authGate } = fixture;
  if (!authGate) throw new Error("Expected the authentication gate fixture");
  try {
    const options = await proofOptions(fixture, undefined, false, true);
    await writeFile(fixture.knownHosts, `${fixture.host} ${fixture.hostPublicKey}\n`, {
      mode: 0o600,
    });
    await fixture.start();
    await storageScope(path.join(fixture.root, `${name}.sqlite`), (sql) =>
      Effect.promise(async () => {
        let starts = 0;
        const picker = makeSshOwnerDevPicker({
          executionTargetId: options.targetId,
          host: fixture.host,
          startOwner: (profileBinding) => {
            starts++;
            return startPickerProofOwner({
              ...options,
              sql,
              profileBinding,
              posixMuxPickerCancellation: true,
            });
          },
          listWithCancellation: (owner, input, signal) =>
            owner.listCancellableRemoteFolders(input, signal),
        });
        try {
          await body({ ...fixture, authGate }, sql, picker, () => starts);
        } finally {
          await authGate.release();
          await picker.close();
        }
      }),
    );
  } finally {
    await authGate.release();
    beforeDispose();
    await fixture.dispose();
  }
}

async function heldMaster(
  fixture: Fixture & { authGate: { isHeld(): Promise<boolean> } },
  accepted = 0,
) {
  await vi.waitFor(async () => expect(await fixture.authGate.isHeld()).toBe(true), {
    timeout: 5_000,
  });
  const owned = await masters(`${fixture.root}/bbcm-`);
  expect(owned).toHaveLength(1);
  expect(fixture.acceptedPublicKeys()).toBe(accepted);
  return owned[0]!;
}

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "cancels one waiter while native SSH authentication is in flight and serves the other",
  () =>
    scenario("auth-waiter", async (fixture, _sql, picker, starts) => {
      const target = { executionTargetId: fixture.executionTargetId, path: fixture.folder };
      await fixture.authGate.arm();
      const controller = new AbortController();
      const first = picker.listRemoteFolders(target, controller.signal);
      void first.catch(() => undefined);
      const child = await heldMaster(fixture);
      const second = picker.listRemoteFolders(target);
      void second.catch(() => undefined);
      controller.abort();
      await expect(first).rejects.toThrow();
      // The exact owned child that was authenticating is gone; its lease is gone too.
      expect(await stillRunning(child)).toBe(false);
      await fixture.authGate.release();
      await expect(second).resolves.toMatchObject({ path: fixture.folder });
      expect(starts()).toBe(1);
      await vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(1));
      expect(fixture.connectionStarts()).toBe(2);
      const [replacement] = await masters(`${fixture.root}/bbcm-`);
      expect(replacement && replacement.pid !== child.pid).toBe(true);
      expect(await fixture.launchNames()).toEqual([]);
    }),
  60_000,
);

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "fences a late native startup behind Disconnect and retires only its exact owned child",
  async () => {
    const outsideRoot = await mkdtemp("/private/tmp/bigbud-outside-master-");
    const outsideSocket = path.join(outsideRoot, "s");
    let outsideChild: ChildProcess | undefined;
    try {
      await scenario(
        "auth-disconnect",
        async (fixture, sql, picker) => {
          const target = { executionTargetId: fixture.executionTargetId, path: fixture.folder };
          // A pre-existing master to the same endpoint that the owner must neither use nor touch.
          const outsideArgs = [
            "-F",
            "/dev/null",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "BatchMode=yes",
            "-o",
            `UserKnownHostsFile=${fixture.knownHosts}`,
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "IdentityAgent=none",
            "-i",
            fixture.identity,
            "-p",
            String(fixture.port),
            "-o",
            `ControlPath=${outsideSocket}`,
            `${fixture.user}@${fixture.loopback}`,
          ];
          outsideChild = spawn("/usr/bin/ssh", ["-N", "-o", "ControlMaster=yes", ...outsideArgs], {
            stdio: "ignore",
            env: {},
          });
          await vi.waitFor(
            () => run("/usr/bin/ssh", ["-O", "check", ...outsideArgs], { env: {} }),
            {
              timeout: 5_000,
            },
          );
          const [outside] = await masters(outsideSocket);
          expect(outside).toBeDefined();
          expect(fixture.acceptedPublicKeys()).toBe(1);

          await fixture.authGate.arm();
          const active = picker.listRemoteFolders(target);
          void active.catch(() => undefined);
          const child = await heldMaster(fixture, 1);
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
          expect(rows.map((row) => row.target_id)).toEqual([fixture.executionTargetId]);

          // Let the held server-side lookup finish: the late success admits nothing.
          const connections = fixture.connectionStarts();
          await fixture.authGate.release();
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          await expect(picker.listRemoteFolders(target)).rejects.toThrow(
            REMOTE_TARGET_DISCONNECTED_MESSAGE,
          );
          expect(fixture.acceptedPublicKeys()).toBe(1);
          expect(fixture.connectionStarts()).toBe(connections);
          expect(await stillRunning(outside!)).toBe(true);
          await run("/usr/bin/ssh", ["-O", "check", ...outsideArgs], { env: {} });

          await picker.connectExecutionTarget(target);
          expect(fixture.connectionStarts()).toBe(connections);
          await expect(picker.listRemoteFolders(target)).resolves.toMatchObject({
            path: fixture.folder,
          });
          await vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(2));
          expect(await stillRunning(outside!)).toBe(true);
        },
        () => outsideChild?.kill("SIGTERM"),
      );
    } finally {
      // Only the test's own spawned handle; the fixture's sshd stderr stays open until it exits.
      outsideChild?.kill("SIGTERM");
      await rm(outsideRoot, { recursive: true, force: true });
    }
  },
  60_000,
);
