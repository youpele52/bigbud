import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  TerminalCloseInput,
  TerminalError,
  TerminalEvent,
  TerminalOpenInput,
  TerminalRestartInput,
  TerminalWriteInput,
} from "./terminal";
import {
  TerminalKeepOpenInput,
  TerminalLifecycleNotice,
  TerminalRetrySetupInput,
  TerminalRetrySetupResult,
} from "./terminal.lifecycle";
import { TerminalEndedReason, TerminalLimitError, TerminalScreenSource } from "./terminal.limit";
import { TerminalEventsStreamItem, TerminalEventsSubscriptionInput } from "./terminal.stream";

describe("terminal lifecycle request identity", () => {
  it("retains the no-running-process guard for identityless panes", () => {
    expect(
      Schema.decodeUnknownSync(TerminalCloseInput)({
        threadId: "thread",
        terminalId: "terminal",
        onlyIfNotRunning: true,
      }).onlyIfNotRunning,
    ).toBe(true);
  });
  it("retains optional generation fences on close and write", () => {
    expect(
      Schema.decodeUnknownSync(TerminalCloseInput)({
        threadId: "thread",
        terminalId: "terminal",
        expectedGeneration: "run-1",
      }).expectedGeneration,
    ).toBe("run-1");
    expect(
      Schema.decodeUnknownSync(TerminalWriteInput)({
        threadId: "thread",
        data: "input",
        expectedGeneration: "run-1",
      }).expectedGeneration,
    ).toBe("run-1");
  });

  it("retains restart identity while accepting legacy requests", () => {
    const parse = Schema.decodeUnknownSync(TerminalRestartInput);
    const decode = (input: Record<string, unknown>) => parse({ cols: 80, rows: 24, ...input });
    expect(decode({ threadId: "thread", cwd: "/project" }).operationId).toBeUndefined();
    expect(
      decode({
        threadId: "thread",
        cwd: "/project",
        operationId: "retry-1",
        expectedGeneration: "run-1",
      }),
    ).toMatchObject({ operationId: "retry-1", expectedGeneration: "run-1" });
  });

  it("rejects empty identities and oversized restart operation IDs", () => {
    const parse = Schema.decodeUnknownSync(TerminalRestartInput);
    const decode = (input: Record<string, unknown>) => parse({ cols: 80, rows: 24, ...input });
    for (const operationId of ["", " ", "x".repeat(129)]) {
      expect(() => decode({ threadId: "thread", cwd: "/project", operationId })).toThrow();
    }
    expect(() =>
      Schema.decodeUnknownSync(TerminalCloseInput)({
        threadId: "thread",
        expectedGeneration: " ",
      }),
    ).toThrow();
  });
});

describe("terminal lifecycle notices and controls", () => {
  const candidate = {
    threadId: "thread-a",
    terminalId: "pane-1",
    lastUsedAt: "2026-11-21T10:00:00.000Z",
    busy: true,
  };
  const notice = {
    type: "lifecycleNotice",
    noticeId: "notice-1",
    kind: "setupBlockedByLimit",
    threadId: "thread-b",
    candidate,
    limit: 24,
    createdAt: "2026-11-21T10:05:00.000Z",
  };

  it("decodes a setup refusal notice and rejects unknown kinds", () => {
    expect(Schema.decodeUnknownSync(TerminalLifecycleNotice)(notice)).toEqual(notice);
    expect(() =>
      Schema.decodeUnknownSync(TerminalLifecycleNotice)({ ...notice, kind: "exploded" }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(TerminalLifecycleNotice)({ ...notice, noticeId: "" }),
    ).toThrow();
  });

  it("delivers notices only as global events stream items behind an opt-in", () => {
    expect(Schema.decodeUnknownSync(TerminalEventsStreamItem)(notice)).toEqual(notice);
    expect(() => Schema.decodeUnknownSync(TerminalEvent)(notice)).toThrow();
    expect(
      Schema.decodeUnknownSync(TerminalEventsSubscriptionInput)({ includeLifecycle: true }),
    ).toEqual({ includeLifecycle: true });
  });

  it("requires a full pane identity for keep open and an evict target for setup retry", () => {
    const keepOpen = { threadId: "thread", terminalId: "pane" };
    expect(Schema.decodeUnknownSync(TerminalKeepOpenInput)(keepOpen)).toEqual(keepOpen);
    expect(() =>
      Schema.decodeUnknownSync(TerminalKeepOpenInput)({ threadId: "thread", terminalId: " " }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(TerminalRetrySetupInput)({ threadId: "thread" }),
    ).toThrow();
    const retry = { threadId: "thread", evict: { threadId: "old", terminalId: "pane" } };
    expect(Schema.decodeUnknownSync(TerminalRetrySetupInput)(retry)).toEqual(retry);
  });

  it("mirrors the setup runner's result shapes", () => {
    const decode = Schema.decodeUnknownSync(TerminalRetrySetupResult);
    expect(decode({ status: "no-script" })).toEqual({ status: "no-script" });
    const started = {
      status: "started",
      scriptId: "setup",
      scriptName: "Setup",
      terminalId: "setup-pane",
      cwd: "/repo",
    };
    expect(decode(started)).toEqual(started);
    expect(() => decode({ status: "started" })).toThrow();
  });

  it("round-trips the limit error through the terminal error union", () => {
    const codec = Schema.toCodecJson(TerminalError);
    const error = new TerminalLimitError({ limit: 24, liveCount: 24, candidate });
    const decoded = Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(error));
    expect(decoded).toBeInstanceOf(TerminalLimitError);
    expect(decoded).toMatchObject({ limit: 24, liveCount: 24, candidate });
    expect(error.message).toBe("Terminal limit reached: 24 of 24 terminals are running");
    const noCandidate = new TerminalLimitError({ limit: 24, liveCount: 24, candidate: null });
    expect(
      Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(noCandidate)),
    ).toMatchObject({ candidate: null });
  });

  it("accepts open eviction targets and the snapshot's ended reasons", () => {
    const open = Schema.decodeUnknownSync(TerminalOpenInput)({
      threadId: "thread",
      cwd: "/repo",
      attachOnly: true,
      evict: { threadId: "old", terminalId: "pane" },
    });
    expect(open).toMatchObject({
      attachOnly: true,
      evict: { threadId: "old", terminalId: "pane" },
    });
    expect(() =>
      Schema.decodeUnknownSync(TerminalOpenInput)({
        threadId: "thread",
        cwd: "/repo",
        evict: { threadId: "old" },
      }),
    ).toThrow();
    expect(TerminalEndedReason.literals).toEqual([
      "user",
      "idle",
      "memory",
      "limit",
      "quit",
      "orphan",
      "host-lost",
      "exited",
    ]);
    expect(TerminalScreenSource.literals).toEqual(["host", "history"]);
  });
});
