import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  TerminalEvent,
  TerminalOpenInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
} from "./terminal";

const snapshot = {
  threadId: "thread-1",
  terminalId: "terminal-1",
  dropPathMode: "posix",
  cwd: "/workspace",
  worktreePath: null,
  status: "running",
  pid: 42,
  history: "",
  exitCode: null,
  exitSignal: null,
  updatedAt: "2026-11-11T12:00:00.000Z",
} as const;

const identity = {
  host: { kind: "local", hostId: "local" },
  selection: { kind: "profile", profileId: "shell:v1:example" },
  profileId: "shell:v1:example",
  kind: "zsh",
  integration: { status: "unavailable", reason: "not-qualified" },
} as const;

const open = { threadId: "thread-1", cwd: "/workspace" };
const restart = { ...open, cols: 80, rows: 24 };

describe("terminal shell launch compatibility", () => {
  it("keeps old open/restart requests valid without creating an explicit choice", () => {
    expect(Schema.decodeUnknownSync(TerminalOpenInput)(open).shellSelection).toBeUndefined();
    expect(Schema.decodeUnknownSync(TerminalRestartInput)(restart).shellSelection).toBeUndefined();
  });

  it("carries only a bounded selection, not a client-supplied launch command", () => {
    for (const [schema, input] of [
      [TerminalOpenInput, open],
      [TerminalRestartInput, restart],
    ] as const) {
      const decode = Schema.decodeUnknownSync(schema);
      expect(decode({ ...input, shellSelection: identity.selection }).shellSelection).toEqual(
        identity.selection,
      );
      expect(decode({ ...input, shellSelection: { kind: "legacy-auto" } }).shellSelection).toEqual({
        kind: "legacy-auto",
      });
      expect(() =>
        decode({ ...input, shellSelection: { kind: "profile", executable: "/bin/zsh" } }),
      ).toThrow();
      expect(() =>
        decode({ ...input, shellSelection: { kind: "profile", profileId: "bad\nvalue" } }),
      ).toThrow();
    }
  });

  it("does not invent a historical identity when decoding old snapshots", () => {
    const decoded = Schema.decodeUnknownSync(TerminalSessionSnapshot)(snapshot);
    expect(decoded.shellLaunchIdentity).toBeUndefined();
    expect(Object.hasOwn(decoded, "shellLaunchIdentity")).toBe(false);
    expect(Object.hasOwn(decoded, "shellUnconfirmedLaunch")).toBe(false);
  });

  it("preserves unconfirmed intent without promoting it to actual identity", () => {
    const shellUnconfirmedLaunch = {
      status: "unconfirmed",
      requestedProfile: {
        host: { kind: "ssh", hostId: "ssh:example" },
        profileId: "shell:v1:example",
        kind: "zsh",
      },
    } as const;
    const current = { ...snapshot, shellUnconfirmedLaunch };
    const decoded = Schema.decodeUnknownSync(TerminalSessionSnapshot)(current);
    expect(decoded.shellUnconfirmedLaunch).toEqual(shellUnconfirmedLaunch);
    expect(Object.hasOwn(decoded, "shellLaunchIdentity")).toBe(false);
    for (const type of ["started", "restarted"] as const) {
      const event = Schema.decodeUnknownSync(TerminalEvent)({
        type,
        threadId: snapshot.threadId,
        terminalId: snapshot.terminalId,
        createdAt: snapshot.updatedAt,
        snapshot: current,
      });
      expect(event.type === type && event.snapshot.shellUnconfirmedLaunch).toEqual(
        shellUnconfirmedLaunch,
      );
      expect(event.type === type && event.snapshot.shellLaunchIdentity).toBeUndefined();
    }
  });

  it("preserves actual launch identity in snapshots and start/restart events", () => {
    const current = { ...snapshot, shellLaunchIdentity: identity };
    expect(Schema.decodeUnknownSync(TerminalSessionSnapshot)(current).shellLaunchIdentity).toEqual(
      identity,
    );
    for (const type of ["started", "restarted"] as const) {
      const event = Schema.decodeUnknownSync(TerminalEvent)({
        type,
        threadId: snapshot.threadId,
        terminalId: snapshot.terminalId,
        createdAt: snapshot.updatedAt,
        snapshot: current,
      });
      expect(event.type === type && event.snapshot.shellLaunchIdentity).toEqual(identity);
    }
  });
});
