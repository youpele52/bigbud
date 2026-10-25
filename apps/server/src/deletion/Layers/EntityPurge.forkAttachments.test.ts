import { ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { decideOrchestrationCommand } from "../../orchestration/decider.ts";
import {
  forkCommand,
  message,
  PROJECT,
  readModel,
  SOURCE,
  sourceThread,
} from "../../orchestration/deciderThreads.fork.test.helpers.ts";
import { ServerConfig } from "../../startup/config.ts";
import { EntityPurge } from "../Services/EntityPurge.ts";
import {
  attachmentJson,
  NOW,
  seedMarker,
  seedThread,
  testLayer,
} from "./EntityPurge.security.test.helpers.ts";

const ATTACHMENT_ID = "fork-shared-00000000-0000-4000-8000-000000000001";
const IMAGE = JSON.parse(attachmentJson(ATTACHMENT_ID))[0];

it.layer(testLayer)("EntityPurge with server-side forks", (it) => {
  it.effect("deleting the source keeps the fork's copied attachments", () =>
    Effect.gen(function* () {
      const purge = yield* EntityPurge;
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const attachmentPath = `${config.attachmentsDir}/${ATTACHMENT_ID}.png`;
      yield* fs.writeFileString(attachmentPath, "keep-me");
      const forkId = ThreadId.makeUnsafe("fork-thread");
      yield* seedThread({ projectId: PROJECT, threadId: SOURCE });
      yield* seedThread({ projectId: PROJECT, threadId: forkId });
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at, attachments_json
        ) VALUES ('source-image', ${SOURCE}, 'user', 'see image', 0, ${NOW}, ${NOW}, ${attachmentJson(ATTACHMENT_ID)})
      `;
      // The fork's copy comes from the real decider, so this checks what a fork persists.
      const source = sourceThread({
        pairs: 1,
        extraMessages: [
          message("source-image", "user", 10, { attachments: [IMAGE] }),
          message("source-answer", "assistant", 11),
        ],
      });
      const decided = yield* decideOrchestrationCommand({
        command: forkCommand({}) as never,
        readModel: readModel(source),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      const copied = events.find(
        (event) =>
          event.type === "thread.message-sent" &&
          event.aggregateId === forkId &&
          (event.payload as { attachments?: unknown[] }).attachments?.length,
      );
      assert.isDefined(copied);
      const payload = copied!.payload as { messageId: string; attachments: unknown[] };
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, role, text, is_streaming, created_at, updated_at, attachments_json
        ) VALUES (${payload.messageId}, ${forkId}, 'user', 'see image', 0, ${NOW}, ${NOW}, ${JSON.stringify(payload.attachments)})
      `;

      yield* seedMarker(SOURCE);
      yield* purge.run(yield* purge.requestThread(SOURCE));
      assert.isTrue(yield* fs.exists(attachmentPath));

      yield* seedMarker(forkId);
      yield* purge.run(yield* purge.requestThread(forkId));
      assert.isFalse(yield* fs.exists(attachmentPath));
    }),
  );
});
