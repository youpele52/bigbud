import { randomBytes } from "node:crypto";
import path from "node:path";

import { WS_METHODS, WsRpcGroup } from "@bigbud/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcTest from "effect/unstable/rpc/RpcTest";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";

import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { listRemoteFoldersEffect } from "../ws/wsRemoteFolders.ts";
import type { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";
import type { PickerProofOwner, PickerProofOwnerErrorCode } from "./sshOwnerPickerProof.client.ts";
import { installIsolatedPickerOwner } from "./sshOwnerPickerProof.fixture.ts";

export const pickerProofOptedIn = process.env.BIGBUD_TEST_SSH_OWNER_PICKER_PROOF === "1";
const pickerRpc = WS_METHODS.serverListRemoteFolders;
const pickerRequest = WsRpcGroup.requests.get(pickerRpc);
if (pickerRequest?._tag !== pickerRpc) throw new Error("The folder picker RPC is not registered.");
const rpcGroup = RpcGroup.make(pickerRequest);
type Fixture = Awaited<ReturnType<typeof makeLoopbackPickerFixture>>;

export function picker(
  owner: PickerProofOwner,
  fixture: Pick<Fixture, "folder" | "executionTargetId">,
  executionTargetId = fixture.executionTargetId,
) {
  const input = { executionTargetId, path: `~/${path.basename(fixture.folder)}` };
  const handler = rpcGroup.toLayer({
    [pickerRpc]: (request) =>
      listRemoteFoldersEffect(request, (value) => owner.listRemoteFolders(value)),
  });
  return () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(rpcGroup);
          return yield* client[pickerRpc](input);
        }),
      ).pipe(Effect.provide(handler)),
    );
}

export function storageScope<A, E>(
  db: string,
  body: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>,
) {
  const layer = makeSqlitePersistenceLive(db, { worker: false }).pipe(
    Layer.provide(NodeServices.layer),
  );
  return Effect.runPromise(
    Effect.flatMap(Effect.service(SqlClient.SqlClient), body).pipe(Effect.provide(layer)),
  );
}

export async function proofOptions(
  fixture: Fixture,
  socketPath?: string,
  allowPty = socketPath !== undefined,
  allowPosixPickerMaster = false,
) {
  return {
    binary: await installIsolatedPickerOwner(
      fixture.root,
      fixture.clientSandboxPolicy,
      socketPath,
      allowPty,
      allowPosixPickerMaster,
    ),
    profileBinding: randomBytes(32),
    targetId: fixture.executionTargetId,
    lockFile: path.join(fixture.root, "owner.lock"),
    sshBinary: fixture.ssh,
    keyscanBinary: "/usr/bin/ssh-keyscan",
    host: fixture.loopback,
    port: fixture.port,
    user: fixture.user,
    identityFile: fixture.identity,
    knownHostsFile: fixture.knownHosts,
  };
}

export async function rejectStartup(
  attempt: Promise<PickerProofOwner>,
  code: PickerProofOwnerErrorCode,
) {
  await expect(
    attempt.then(async (unexpectedOwner) => {
      await unexpectedOwner.close();
      throw new Error("Unexpected proof owner startup");
    }),
  ).rejects.toMatchObject({ code });
}
