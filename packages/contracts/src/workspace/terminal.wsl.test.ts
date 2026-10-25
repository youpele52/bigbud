import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { TerminalSessionSnapshot, TerminalOpenInput } from "./terminal";
import { TerminalWslIdentity } from "./terminal.wsl";

describe("optional WSL terminal metadata", () => {
  const snapshot = {
    threadId: "thread",
    terminalId: "terminal",
    executionTargetId: "local",
    dropPathMode: "cmd",
    cwd: "C:\\project",
    worktreePath: null,
    status: "running",
    pid: 1,
    history: "",
    exitCode: null,
    exitSignal: null,
    updatedAt: "now",
  };
  it("preserves legacy snapshots and optional string targets", () => {
    expect(Schema.decodeUnknownSync(TerminalSessionSnapshot)(snapshot).wslIdentity).toBeUndefined();
    expect(
      Schema.decodeUnknownSync(TerminalOpenInput)({
        threadId: "thread",
        cwd: "/project",
        executionTargetId: "wsl:Ubuntu",
      }).executionTargetId,
    ).toBe("wsl:Ubuntu");
  });
  it("round trips explicit distro/user metadata without environment inheritance", () => {
    const identity = { distribution: "Ubuntu", username: "root", uid: 0 };
    expect(
      Schema.decodeUnknownSync(TerminalSessionSnapshot)({
        ...snapshot,
        executionTargetId: "wsl:Ubuntu",
        wslIdentity: identity,
      }).wslIdentity,
    ).toEqual(identity);
    expect(Schema.is(TerminalWslIdentity)({ ...identity, uid: -1 })).toBe(false);
  });
});
