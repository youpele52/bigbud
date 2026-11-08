import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ProjectCreateCommand } from "./orchestration.commands.client";
import { ProjectReconfigureCommand } from "./orchestration.commands.client.projectReconfigure";

const create = {
  type: "project.create",
  commandId: "create",
  projectId: "project",
  title: "Name",
  createdAt: "2026-11-05T00:00:00.000Z",
};
describe("project workspace command boundaries", () => {
  it("allows an omitted or null directory while requiring a nonblank name", () => {
    const decode = Schema.decodeUnknownSync(ProjectCreateCommand);
    expect(decode(create).workspaceRoot).toBeNull();
    expect(decode({ ...create, workspaceRoot: null }).workspaceRoot).toBeNull();
    expect(decode({ ...create, workspaceRoot: "/explicit" }).workspaceRoot).toBe("/explicit");
    expect(() => decode({ ...create, title: " " })).toThrow();
  });
  it("accepts only explicit safe transfer choices", () => {
    const decode = Schema.decodeUnknownSync(ProjectReconfigureCommand);
    const command = {
      type: "project.reconfigure",
      commandId: "edit",
      projectId: "project",
      title: "Name",
      providerRuntimeExecutionTargetId: "local",
      workspaceExecutionTargetId: "local",
      executionTargetId: "local",
      workspaceRoot: "/selected",
      expectedUpdatedAt: create.createdAt,
      verifiedWorktreePaths: [],
    };
    expect(decode(command).workspaceAction).toBeUndefined();
    for (const workspaceAction of ["switch", "transfer"])
      expect(decode({ ...command, workspaceAction }).workspaceAction).toBe(workspaceAction);
    expect(() => decode({ ...command, workspaceAction: "move" })).toThrow();
    expect(decode(command).nativeContextReset).toBeUndefined();
    expect(
      decode({ ...command, nativeContextReset: "archive-and-reset-muse" }).nativeContextReset,
    ).toBe("archive-and-reset-muse");
    for (const nativeContextReset of [true, "reset", "preserve-context", "archive-and-reset-all"])
      expect(() => decode({ ...command, nativeContextReset })).toThrow();
  });
});
