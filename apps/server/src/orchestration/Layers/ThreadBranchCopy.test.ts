import { CommandId, MessageId, ThreadId } from "@bigbud/contracts";
import { afterEach, assert, it } from "vitest";

import { BRANCH_COPY_FAILED_TITLE_SUFFIX } from "../ThreadBranchCopy.logic.ts";
import {
  at,
  makeBranchCopyRuntime,
  SOURCE,
  sourceMessageId,
} from "./ThreadBranchCopy.test.helpers.ts";

let harness: ReturnType<typeof makeBranchCopyRuntime> | null = null;
const open = () => (harness = makeBranchCopyRuntime());
afterEach(async () => {
  await harness?.dispose();
  harness = null;
});

const range = (count: number) => Array.from({ length: count }, (_, index) => index);
const attachmentId = `${SOURCE}-00000000-0000-4000-8000-000000000001`;

it("copies every message of a thread with more than 200 messages, in order", async () => {
  const h = open();
  await h.seedSource([
    ...range(230).map((index) => ({ index })),
    // Still streaming when the branch is requested: not part of the branch.
    { index: 230, streaming: true, text: "partial" },
  ]);
  const copy = await h.copyOf();

  const started = await h.run(copy.start(h.branchInput("branch-large", null)));
  assert.equal(started.totalMessages, 230);
  const done = await h.waitForCopy("branch-large");

  assert.deepEqual(done, {
    branchThreadId: ThreadId.makeUnsafe("branch-large"),
    state: "completed",
    copiedMessages: 230,
    totalMessages: 230,
    error: null,
  });
  const copied = await h.branchMessages("branch-large");
  assert.deepEqual(
    copied.map((message) => message.text),
    range(230).map((index) => `message ${index}`),
  );
  assert.equal(new Set(copied.map((message) => message.messageId)).size, 230);
});

it("branches from a middle message with a message over 256 KB copied in full", async () => {
  const h = open();
  const large = "x".repeat(300 * 1024);
  await h.seedSource([
    ...range(10).map((index) =>
      index === 4
        ? { index, text: large }
        : index === 2
          ? {
              index,
              attachments: [
                {
                  type: "image" as const,
                  id: attachmentId,
                  name: "image.png",
                  mimeType: "image/png",
                  sizeBytes: 4,
                },
              ],
            }
          : { index },
    ),
    // Same timestamp as message 5: the tie keeps its order in the branch.
    { index: 50, id: MessageId.makeUnsafe("source-00005-b"), createdAt: at(6) },
  ]);
  const copy = await h.copyOf();

  await h.run(copy.start(h.branchInput("branch-middle", sourceMessageId(6))));
  const done = await h.waitForCopy("branch-middle");

  assert.equal(done.state, "completed");
  const copied = await h.branchMessages("branch-middle");
  assert.deepEqual(
    copied.map((message) => (message.text.length === large.length ? "large" : message.text)),
    [
      "message 0",
      "message 1",
      "message 2",
      "message 3",
      "large",
      "message 5",
      "message 50",
      "message 6",
    ],
  );
  assert.equal(copied[4]?.text, large);
  // The copied message references the image, so the file belongs to the branch as well.
  const refs = await h.sql(
    (db) => db<{ readonly threadId: string }>`
      SELECT thread_id AS "threadId" FROM projection_thread_attachment_refs
      WHERE attachment_id = ${attachmentId} ORDER BY thread_id
    `,
  );
  assert.deepEqual(
    refs.map((ref) => ref.threadId),
    ["branch-copy-source", "branch-middle"],
  );
});

it("resumes an interrupted copy without duplicating messages", async () => {
  const h = open();
  await h.seedSource(range(60).map((index) => ({ index })));
  const copy = await h.copyOf();
  await h.run(copy.start(h.branchInput("branch-resume", null)));
  await h.waitForCopy("branch-resume");

  // A crash after the batches were committed but before progress was recorded, with the
  // command receipts already pruned: every batch replays from the start.
  await h.sql(
    (db) => db`
      UPDATE thread_branch_copies
      SET state = 'copying', next_batch = 0, copied_messages = 0,
        cursor_created_at = NULL, cursor_message_id = NULL
      WHERE branch_thread_id = 'branch-resume'
    `,
  );
  await h.sql((db) => db`DELETE FROM orchestration_command_receipts`);
  await h.run(copy.runJob(ThreadId.makeUnsafe("branch-resume")));

  const status = await h.run(copy.status(ThreadId.makeUnsafe("branch-resume")));
  assert.equal(status?.state, "completed", status?.error ?? "");
  const copied = await h.branchMessages("branch-resume");
  assert.equal(copied.length, 60);
  assert.equal(new Set(copied.map((message) => message.messageId)).size, 60);
});

it("keeps a completed branch when its source is deleted", async () => {
  const h = open();
  await h.seedSource(range(5).map((index) => ({ index })));
  const copy = await h.copyOf();
  await h.run(copy.start(h.branchInput("branch-independent", null)));
  await h.waitForCopy("branch-independent");

  const engine = await h.engineOf();
  await h.run(
    engine.dispatch({
      type: "thread.delete",
      commandId: CommandId.makeUnsafe("delete-source"),
      threadId: SOURCE,
    }),
  );
  await h.run(
    engine.dispatch({
      type: "thread.delete.finalize",
      commandId: CommandId.makeUnsafe("finalize-source"),
      threadId: SOURCE,
      mode: "single",
      createdAt: at(200_000),
    }),
  );

  const branch = await h.sql(
    (db) => db<{
      readonly parentThreadId: string | null;
      readonly deletedAt: string | null;
    }>`
      SELECT parent_thread_id AS "parentThreadId", deleted_at AS "deletedAt"
      FROM projection_threads WHERE thread_id = 'branch-independent'
    `,
  );
  assert.deepEqual(branch, [{ parentThreadId: null, deletedAt: null }]);
  const copied = await h.branchMessages("branch-independent");
  assert.deepEqual(
    copied.map((message) => message.text),
    range(5).map((index) => `message ${index}`),
  );
});

it("fails visibly when the source is deleted before the copy finishes", async () => {
  const h = open();
  await h.seedSource(range(30).map((index) => ({ index })));
  const copy = await h.copyOf();
  await h.run(copy.start(h.branchInput("branch-orphaned", null)));
  await h.waitForCopy("branch-orphaned");
  await h.sql(
    (db) => db`
      UPDATE thread_branch_copies
      SET state = 'copying', next_batch = 1, copied_messages = 25
      WHERE branch_thread_id = 'branch-orphaned'
    `,
  );
  await h.sql(
    (db) => db`UPDATE projection_threads SET deleting_at = ${at(1)} WHERE thread_id = ${SOURCE}`,
  );
  await h.run(copy.runJob(ThreadId.makeUnsafe("branch-orphaned")));

  const status = await h.run(copy.status(ThreadId.makeUnsafe("branch-orphaned")));
  assert.equal(status?.state, "failed");
  assert.match(status?.error ?? "", /deleted before the copy finished/);
  const titles = await h.sql(
    (db) => db<{ readonly title: string }>`
      SELECT title FROM projection_threads WHERE thread_id = 'branch-orphaned'
    `,
  );
  assert.equal(titles[0]?.title, `Source (A)${BRANCH_COPY_FAILED_TITLE_SUFFIX}`);
});

it("rejects a branch point that is still streaming or unknown", async () => {
  const h = open();
  await h.seedSource([{ index: 0 }, { index: 1, streaming: true }]);
  const copy = await h.copyOf();

  const streaming = await h
    .run(copy.start(h.branchInput("branch-streaming", sourceMessageId(1))))
    .then(
      () => null,
      (error: { readonly message: string }) => error.message,
    );
  assert.match(streaming ?? "", /Wait for the message to finish/);
  const unknown = await h
    .run(copy.start(h.branchInput("branch-unknown", MessageId.makeUnsafe("missing"))))
    .then(
      () => null,
      (error: { readonly message: string }) => error.message,
    );
  assert.match(unknown ?? "", /Branch point message not found/);
});
