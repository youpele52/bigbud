import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import { describe, expect, it } from "vitest";
import {
  forgetTerminalLaunch,
  readTerminalLaunch,
  recordTerminalLaunch,
} from "./terminalLaunchBinding";

const host = { kind: "ssh", hostId: "remote" } as const;
const requestedProfile = { host, profileId: "remote:zsh", kind: "zsh" } as const;
const identity = {
  ...requestedProfile,
  selection: { kind: "profile", profileId: "remote:zsh" },
  integration: { status: "disabled" },
} as const;
function snapshot(overrides: Partial<TerminalSessionSnapshot> = {}): TerminalSessionSnapshot {
  return {
    threadId: "profile-evidence",
    terminalId: "pane",
    executionTargetId: "ssh:remote",
    cwd: "/home/remote",
    worktreePath: null,
    status: "running",
    pid: 1,
    dropPathMode: "posix",
    history: "",
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-11-11T12:00:01Z",
    runtimeGeneration: "one",
    ...overrides,
  };
}
function withBinding(run: () => void) {
  try {
    run();
  } finally {
    forgetTerminalLaunch("profile-evidence", "pane");
  }
}
const read = () => readTerminalLaunch("profile-evidence", "pane");

describe("per-pane shell evidence", () => {
  it("retains an unconfirmed request separately without inventing actual identity", () => {
    withBinding(() => {
      recordTerminalLaunch(
        snapshot({
          shellUnconfirmedLaunch: { status: "unconfirmed", requestedProfile },
        }),
      );
      expect(read()?.shellLaunchIdentity).toBeUndefined();
      expect(read()?.shellUnconfirmedLaunch).toEqual({ status: "unconfirmed", requestedProfile });
    });
  });
  it("records authoritative identity and clears earlier unconfirmed evidence", () => {
    withBinding(() => {
      recordTerminalLaunch(
        snapshot({
          shellUnconfirmedLaunch: { status: "unconfirmed", requestedProfile },
        }),
      );
      recordTerminalLaunch(
        snapshot({
          updatedAt: "2026-11-11T12:00:02Z",
          shellLaunchIdentity: identity,
        }),
      );
      expect(read()?.shellLaunchIdentity).toEqual(identity);
      expect(read()?.shellUnconfirmedLaunch).toBeUndefined();
    });
  });
  it("does not carry old profile evidence into an unknown replacement", () => {
    withBinding(() => {
      recordTerminalLaunch(snapshot({ shellLaunchIdentity: identity }));
      recordTerminalLaunch(
        snapshot({
          updatedAt: "2026-11-11T12:00:03Z",
          runtimeGeneration: "replacement",
        }),
      );
      expect(read()?.shellLaunchIdentity).toBeUndefined();
      expect(read()?.shellUnconfirmedLaunch).toBeUndefined();
      expect(recordTerminalLaunch(snapshot({ shellLaunchIdentity: identity }))).toBe(false);
      expect(read()?.shellLaunchIdentity).toBeUndefined();
    });
  });
});
