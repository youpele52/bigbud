import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { WorktreeBinding } from "./worktreeBinding";
import { ThreadTurnStartBootstrap } from "../orchestration/orchestration.commands.client.bootstrap";
import { ThreadCreateCommand } from "../orchestration/orchestration.commands.client.threadCreate";

const proof = {
  path: "/trees/physical",
  identity: "1:2",
  executionTargetId: "local",
  repository: "/repo/.git",
  revision: 42,
};
const thread = {
  projectId: "project",
  title: "New",
  modelSelection: { provider: "codex", model: "test" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "different-branch",
  worktreePath: proof.path,
  worktreeBinding: proof,
  createdAt: "2026-10-16T00:00:00.000Z",
};

describe("worktree draft identity contracts", () => {
  it("carries the same proof through deferred first-send bootstrap and ordinary owner creation", () => {
    expect(
      Schema.decodeUnknownSync(ThreadTurnStartBootstrap)({ createThread: thread }).createThread
        ?.worktreeBinding,
    ).toEqual(proof);
    expect(
      Schema.decodeUnknownSync(ThreadCreateCommand)({
        ...thread,
        type: "thread.create",
        commandId: "create",
        threadId: "thread",
      }).worktreeBinding,
    ).toEqual(proof);
  });
  it("rejects malformed or negative revision proof", () => {
    expect(() => Schema.decodeUnknownSync(WorktreeBinding)({ ...proof, revision: -1 })).toThrow();
    expect(() => Schema.decodeUnknownSync(WorktreeBinding)({ ...proof, identity: "" })).toThrow();
  });
});
