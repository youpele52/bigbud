import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { WsOrchestrationGetMobileThreadRpc } from "@bigbud/contracts/server/rpc.stream.ts";
import { assert } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { projectionSnapshotLayer } from "../orchestration/Layers/ProjectionSnapshotQuery.test.helpers.ts";
import {
  insertProject,
  insertThread,
  insertMessages,
  insertActivities,
  insertPendingApproval,
  insertPendingUserInput,
  publishProjectionState,
} from "../orchestration/Layers/ProjectionSnapshotQuery.mobile.bounds.fixtures.ts";
import { readBoundedMobileThread } from "./ws.mobile.bounded.ts";
import type { WsRpcContext } from "./wsRpcContext.ts";

const encode = Schema.encodeUnknownSync(
  Schema.toCodecJson(Rpc.exitSchema(WsOrchestrationGetMobileThreadRpc)),
);
projectionSnapshotLayer("legacy mobile bounds", (it) => {
  it.effect(
    "preserves large pending decisions and streaming text within an encoded 4 MiB response",
    () =>
      Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery;
        const id = ThreadId.makeUnsafe("legacy-preserved");
        const text = "s".repeat(300 * 1024);
        const approval = { requestId: "legacy-a", diff: text };
        const question = { requestId: "legacy-q", questions: [], context: text };
        yield* insertProject("legacy-project");
        yield* insertThread("legacy-project", id);
        yield* insertMessages(id, ["x".repeat(5 * 1024 * 1024), { text, streaming: true }]);
        yield* insertPendingApproval(id, approval.requestId);
        yield* insertPendingUserInput(id, question.requestId);
        yield* insertActivities(id, [
          {
            id: "legacy-a",
            kind: "approval.requested",
            sequence: 1,
            payload: JSON.stringify(approval),
          },
          {
            id: "legacy-q",
            kind: "user-input.requested",
            sequence: 2,
            payload: JSON.stringify(question),
          },
        ]);
        yield* publishProjectionState(5);
        const thread = yield* readBoundedMobileThread(
          { projectionSnapshotQuery: query } as WsRpcContext,
          id,
        );
        assert.equal(thread.messages.at(-1)?.text, text);
        assert.isTrue(thread.messages.at(-1)?.streaming);
        assert.include(thread.messages[0]!.text, "too large for mobile");
        assert.deepEqual(thread.activities.find((a) => a.id === "legacy-a")?.payload, approval);
        assert.deepEqual(thread.activities.find((a) => a.id === "legacy-q")?.payload, question);
        const encoded = JSON.stringify({
          _tag: "Exit",
          requestId: "9007199254740991",
          exit: encode(Exit.succeed(thread)),
        });
        assert.isAtMost(Buffer.byteLength(encoded), 4 * 1024 * 1024);
      }),
  );

  it.effect("returns a typed error when essential data cannot fit instead of truncating it", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const id = ThreadId.makeUnsafe("legacy-over-budget");
      yield* insertProject("legacy-over-project");
      yield* insertThread("legacy-over-project", id);
      yield* insertPendingApproval(id, "large-approval");
      yield* insertActivities(id, [
        {
          id: "large-approval",
          kind: "approval.requested",
          sequence: 1,
          payload: JSON.stringify({
            requestId: "large-approval",
            diff: "d".repeat(5 * 1024 * 1024),
          }),
        },
      ]);
      yield* publishProjectionState(5);
      const exit = yield* Effect.exit(
        readBoundedMobileThread({ projectionSnapshotQuery: query } as WsRpcContext, id),
      );
      assert.isTrue(Exit.isFailure(exit));
      assert.include(JSON.stringify(exit), "OrchestrationGetMobileThreadError");
      assert.include(JSON.stringify(exit), "Too much recent activity");
    }),
  );
});
