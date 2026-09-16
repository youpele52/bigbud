import { createHash } from "node:crypto";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

function positions(key: string) {
  const digest = createHash("sha256").update(key).digest();
  return [0, 4, 8].map((offset) => {
    const position = digest.readUInt32BE(offset) % (65536 * 8);
    return { slot: position >>> 3, bit: 1 << (position & 7) };
  });
}

/** Fixed-size, monotonic replay evidence: false positives reject, never redispatch expired work. */
export function remoteAgentReplayFence(sql: SqlClient.SqlClient) {
  return {
    remember: (key: string) =>
      Effect.gen(function* () {
        for (const { slot, bit } of positions(key))
          yield* sql`INSERT INTO remote_agent_replay_fence (slot, bits) VALUES (${slot}, ${bit})
          ON CONFLICT(slot) DO UPDATE SET bits = bits | excluded.bits`;
      }),
    assertNew: (key: string) =>
      Effect.gen(function* () {
        for (const { slot, bit } of positions(key)) {
          const rows = yield* sql<{
            bits: number;
          }>`SELECT bits FROM remote_agent_replay_fence WHERE slot = ${slot}`;
          if (((rows[0]?.bits ?? 0) & bit) === 0) return;
        }
        return yield* Effect.die(
          new Error("Remote invocation identity expired; dispatch is forbidden."),
        );
      }),
  };
}
