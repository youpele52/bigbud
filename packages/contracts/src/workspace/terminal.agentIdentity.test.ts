import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { TerminalAgentIdentity } from "./terminal.agentIdentity";
import { TerminalEvent, TerminalSessionSnapshot } from "./terminal";

const identity = { id: "nebula-worker", names: ["Nebula Worker"] };
const base = { threadId: "thread", terminalId: "side", createdAt: "2026-10-17T00:00:00.000Z" };

describe("generic terminal identity compatibility", () => {
  it("accepts terminal-only identity without adding a native provider kind", () => {
    expect(
      Schema.decodeUnknownSync(TerminalEvent)({
        ...base,
        type: "agentIdentity",
        provider: null,
        agent: identity,
      }),
    ).toMatchObject({ agent: identity, provider: null });
    expect(
      Schema.decodeUnknownSync(TerminalSessionSnapshot)({
        ...base,
        status: "running",
        cwd: "/workspace",
        worktreePath: null,
        pid: 123,
        dropPathMode: "posix",
        activeAgentProvider: null,
        activeAgent: identity,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: base.createdAt,
      }),
    ).toMatchObject({ activeAgent: identity, activeAgentProvider: null });
  });

  it("still accepts old provider-only frames and explicit generic clears", () => {
    expect(
      Schema.decodeUnknownSync(TerminalEvent)({
        ...base,
        type: "agentIdentity",
        provider: "codex",
      }),
    ).toMatchObject({ provider: "codex" });
    expect(
      Schema.decodeUnknownSync(TerminalEvent)({
        ...base,
        type: "agentIdentity",
        provider: null,
        agent: null,
      }),
    ).toMatchObject({ provider: null, agent: null });
  });

  it.each([
    { id: "", names: ["Agent"] },
    { id: "x".repeat(129), names: ["Agent"] },
    { id: "agent", names: [] },
    { id: "agent", names: [""] },
    { id: "agent", names: ["x".repeat(129)] },
    { id: "agent", names: Array(17).fill("Agent") },
  ])("bounds the generic wire identity", (value) => {
    expect(() => Schema.decodeUnknownSync(TerminalAgentIdentity)(value)).toThrow();
  });
});
