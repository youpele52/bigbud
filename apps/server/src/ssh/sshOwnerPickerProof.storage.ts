import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { rotateSshOwnerWriterAndHydrate } from "../persistence/Layers/SshOwnerTransitions.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.ts";

export async function hydratePickerProofTarget(sql: SqlClient.SqlClient, targetId: string) {
  const [previous] = await Effect.runPromise(sql<{ writerEpoch: string }>`
    SELECT writer_epoch AS writerEpoch FROM ssh_owner_writer WHERE singleton = 1
  `);
  const hydrated = await Effect.runPromise(
    rotateSshOwnerWriterAndHydrate(sql, previous?.writerEpoch ?? null),
  );
  if (hydrated.kind !== "hydrated") throw new PickerProofOwnerError("storageUnavailable");
  return {
    writerEpoch: hydrated.writerEpoch,
    seq: hydrated.sequences.find((entry) => entry.targetId === targetId)?.seq ?? 0,
    disconnected: hydrated.disconnectedTargets.some((entry) => entry.targetId === targetId),
  };
}
