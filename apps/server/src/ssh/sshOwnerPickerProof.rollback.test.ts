import { stat } from "node:fs/promises";
import { WS_METHODS } from "@bigbud/contracts";
import { Effect } from "effect";
import { expect, it } from "vitest";

import {
  alias,
  makeBaselineFixture,
  withBaselineServer,
} from "../server.sshOwnerBaseline.fixture.ts";
import { type WsRpcClient, withWsRpcClient } from "../server.test.rpc.ts";
import { applySshOwnerTransition } from "../persistence/Layers/SshOwnerTransitions.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  picker,
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";

const target = { executionTargetId: `ssh:${alias}` };
const folder = { ...target, path: "/fixture/selected" };

it.skipIf(!pickerProofOptedIn)(
  "rehearses local legacy-to-owner-to-legacy database handoff without two active writers",
  async () => {
    const legacy = await makeBaselineFixture();
    try {
      const sshd = await makeLoopbackPickerFixture();
      try {
        const options = { ...(await proofOptions(sshd)), targetId: target.executionTargetId };
        const rpc = <A, E>(fn: (client: WsRpcClient) => Effect.Effect<A, E>) =>
          Effect.runPromise(
            Effect.scoped(withWsRpcClient(legacy.wsUrl, fn)).pipe(Effect.timeout("5 seconds")),
          );
        const disconnected = () =>
          rpc((client) => client[WS_METHODS.serverListDisconnectedExecutionTargets]({}));
        const oldList = () => rpc((client) => client[WS_METHODS.serverListRemoteFolders](folder));
        const assertLegacyDisconnect = async () => {
          await expect(disconnected()).resolves.toEqual({
            executionTargetIds: [target.executionTargetId],
          });
          await expect(oldList()).rejects.toThrow(
            "Remote workspace is disconnected. Connect it to continue.",
          );
        };
        await withBaselineServer(legacy.start(), async () => {
          await expect(
            rpc((client) => client[WS_METHODS.serverDisconnectExecutionTarget](target)),
          ).resolves.toEqual({
            ...target,
            disconnected: true,
          });
          await assertLegacyDisconnect();
          expect(await legacy.readLaunches()).toEqual([]);
        });
        const { dev, ino } = await stat(legacy.db);
        await sshd.start();
        const firstRustEpoch = await storageScope(legacy.db, (sql) =>
          Effect.promise(async () => {
            const owner = await startPickerProofOwner({ ...options, sql });
            try {
              const list = picker(owner, sshd, options.targetId);
              const connections = sshd.connectionStarts();
              await expect(list()).rejects.toMatchObject({ cause: { code: "targetDisconnected" } });
              expect(sshd.connectionStarts()).toBe(connections);
              await owner.connect();
              const trust = await owner.inspectTrust();
              if (trust.state !== "approvalRequired")
                throw new Error("Expected first-use fixture trust");
              await owner.approveTrust(trust.challenge);
              await expect(list()).resolves.toMatchObject({ path: sshd.folder });
              await owner.disconnect();
              const [row] = await Effect.runPromise(sql<{ writerEpoch: string }>`
              SELECT writer_epoch AS writerEpoch FROM ssh_owner_writer WHERE singleton = 1
            `);
              if (!row) throw new Error("Expected a fenced writer");
              return row.writerEpoch;
            } finally {
              await owner.close();
            }
          }),
        );
        await withBaselineServer(legacy.start(), async () => {
          expect(await stat(legacy.db)).toMatchObject({ dev, ino });
          await assertLegacyDisconnect();
          expect(await legacy.readLaunches()).toEqual([]);
          await expect(
            rpc((client) => client[WS_METHODS.serverConnectExecutionTarget](target)),
          ).resolves.toEqual({
            ...target,
            disconnected: false,
          });
          await expect(disconnected()).resolves.toEqual({ executionTargetIds: [] });
          await expect(oldList()).resolves.toMatchObject({ path: folder.path });
          expect(await legacy.readLaunches()).toHaveLength(1);
        });
        await storageScope(legacy.db, (sql) =>
          Effect.promise(async () => {
            const owner = await startPickerProofOwner({ ...options, sql });
            try {
              expect(await stat(legacy.db)).toMatchObject({ dev, ino });
              // Legacy cleared the flag but knows nothing about the last Rust receipt.
              await expect(
                Effect.runPromise(
                  applySshOwnerTransition(sql, {
                    writerEpoch: firstRustEpoch,
                    targetId: options.targetId,
                    expectedSeq: 2,
                    requestId: "pre-rollback-stale-write",
                    desiredState: "disconnected",
                  }),
                ),
              ).resolves.toEqual({ kind: "epochMismatch" });
              await expect(picker(owner, sshd, options.targetId)()).resolves.toMatchObject({
                path: sshd.folder,
              });
            } finally {
              await owner.close();
            }
          }),
        );
      } finally {
        await sshd.dispose();
      }
    } finally {
      await legacy.dispose();
    }
  },
  120_000,
);
