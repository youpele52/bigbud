import { stat } from "node:fs/promises";
import { get } from "node:http";

import { WS_METHODS } from "@bigbud/contracts";
import { Effect } from "effect";
import { expect, it } from "vitest";

import {
  alias,
  makeBaselineFixture,
  withBaselineServer,
} from "./server.sshOwnerBaseline.fixture.ts";
import { withWsRpcClient, type WsRpcClient } from "./server.test.rpc.ts";

const executionTargetId = `ssh:${alias}`;
const target = { executionTargetId };
const folder = { ...target, path: "/fixture/selected" };
const listing = {
  path: folder.path,
  homePath: "/fixture",
  folders: [
    { name: "alpha", isGitRepo: false },
    { name: "Z repo", isGitRepo: true },
  ],
  truncated: false,
};

const rpc = <A, E>(url: string, run: (client: WsRpcClient) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.scoped(withWsRpcClient(url, run)).pipe(Effect.timeout("5 seconds")));

const httpStatus = (url: string) =>
  new Promise<number | undefined>((resolve, reject) => {
    // Use a direct socket, independent of any proxy settings in the Vitest process.
    get(url, { agent: false, signal: AbortSignal.timeout(5_000) }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).once("error", reject);
  });

async function readDisconnect(dbPath: string) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT disconnected_at FROM remote_execution_target_disconnects WHERE target_id = ?",
      )
      .get(executionTargetId);
  } finally {
    db.close();
  }
}

// Run explicitly with BIGBUD_TEST_SSH_OWNER_BASELINE_VB=1 and focused Vitest.
// Measures only the macOS direct-source Bun profile with recording executables (no OpenSSH).
it.skipIf(process.env.BIGBUD_TEST_SSH_OWNER_BASELINE_VB !== "1")(
  "S0 V-B: attributes folder SSH to the source Bun backend and preserves Disconnect across restart",
  async () => {
    const fixture = await makeBaselineFixture();
    const list = () =>
      rpc(fixture.wsUrl, (client) => client[WS_METHODS.serverListRemoteFolders](folder));
    const disconnected = () =>
      rpc(fixture.wsUrl, (client) => client[WS_METHODS.serverListDisconnectedExecutionTargets]({}));
    const assertBlocked = async () => {
      await expect(disconnected()).resolves.toEqual({ executionTargetIds: [executionTargetId] });
      await expect(list()).rejects.toThrow(
        "Remote workspace is disconnected. Connect it to continue.",
      );
    };
    try {
      const firstPid = await withBaselineServer(fixture.start(), async (pid) => {
        for (const suffix of ["", "?token=wrong-synthetic-token"]) {
          await expect(httpStatus(fixture.httpUrl + suffix)).resolves.toBe(401);
        }
        const config = await rpc(fixture.wsUrl, (client) => client[WS_METHODS.serverGetConfig]({}));
        expect(Object.keys(config.settings.providers).length).toBeGreaterThan(0);
        expect(Object.values(config.settings.providers).every(({ enabled }) => !enabled)).toBe(
          true,
        );
        expect(await fixture.readLaunches()).toEqual([]);
        await expect(disconnected()).resolves.toEqual({ executionTargetIds: [] });
        await expect(list()).resolves.toEqual(listing);
        const launches = await fixture.readLaunches();
        expect(launches).toEqual([
          {
            tool: "ssh",
            args: [
              "-T",
              "-o",
              "BatchMode=yes",
              "--",
              alias,
              expect.stringContaining("BIGBUD_REMOTE_FOLDERS_V1"),
            ],
            pid: expect.any(Number),
            ppid: pid,
            cwd: fixture.root,
            home: fixture.home,
            path: fixture.bin,
          },
        ]);
        expect(launches[0]?.pid).not.toBe(pid);
        await expect(
          rpc(fixture.wsUrl, (client) =>
            client[WS_METHODS.serverDisconnectExecutionTarget](target),
          ),
        ).resolves.toEqual({ ...target, disconnected: true });
        await assertBlocked();
        expect(await fixture.readLaunches()).toEqual(launches);
        return pid;
      });

      const { dev, ino } = await stat(fixture.db);
      const row = await readDisconnect(fixture.db);
      expect(row).toEqual({ disconnected_at: expect.any(Number) });
      const beforeRestart = await fixture.readLaunches();
      expect(beforeRestart).toHaveLength(1);
      await withBaselineServer(fixture.start(), async (pid) => {
        expect(pid).not.toBe(firstPid);
        expect(await stat(fixture.db)).toMatchObject({ dev, ino });
        expect(await fixture.readLaunches()).toEqual(beforeRestart);
        await assertBlocked();
        expect(await fixture.readLaunches()).toEqual(beforeRestart);
      });
      await expect(readDisconnect(fixture.db)).resolves.toEqual(row);
      expect(await fixture.readLaunches()).toEqual(beforeRestart);
    } finally {
      await fixture.dispose();
    }
  },
  120_000,
);
