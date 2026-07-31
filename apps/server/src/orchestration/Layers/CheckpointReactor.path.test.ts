import fs from "node:fs";
import path from "node:path";

import { CommandId, ThreadId } from "@bigbud/contracts";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { pathCheckpointRefForThreadPath } from "../../checkpointing/Utils.ts";
import {
  createHarness,
  registerCheckpointReactorTestCleanup,
} from "./CheckpointReactor.test.helpers.ts";

describe("CheckpointReactor path checkpoints", () => {
  registerCheckpointReactorTestCleanup();

  it("captures and restores a path without a provider session or thread revert", async () => {
    const harness = await createHarness({ hasSession: false, seedFilesystemCheckpoints: false });
    fs.writeFileSync(path.join(harness.cwd, "target.txt"), "captured\n");
    fs.writeFileSync(path.join(harness.cwd, "sibling.txt"), "sibling\n");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.path-checkpoint.capture",
        commandId: CommandId.makeUnsafe("path-capture"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        path: "target.txt",
        createdAt,
      }),
    );
    await harness.drain();
    const captureEvents = await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(0)));
    expect(Array.from(captureEvents)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "thread.path-checkpoint-capture-requested" }),
      ]),
    );
    fs.writeFileSync(path.join(harness.cwd, "target.txt"), "changed\n");
    fs.writeFileSync(path.join(harness.cwd, "sibling.txt"), "changed sibling\n");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.path-checkpoint.restore",
        commandId: CommandId.makeUnsafe("path-restore"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        path: "target.txt",
        createdAt: new Date().toISOString(),
      }),
    );
    await harness.drain();

    expect(fs.readFileSync(path.join(harness.cwd, "target.txt"), "utf8")).toBe("captured\n");
    expect(fs.readFileSync(path.join(harness.cwd, "sibling.txt"), "utf8")).toBe(
      "changed sibling\n",
    );
    const events = await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(0)));
    expect(Array.from(events)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "thread.reverted" })]),
    );
    expect(pathCheckpointRefForThreadPath(ThreadId.makeUnsafe("thread-1"), "target.txt")).toMatch(
      /^refs\/bigbud\/path-checkpoints\//,
    );
  });
});
