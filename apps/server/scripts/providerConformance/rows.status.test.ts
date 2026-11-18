import { describe, expect, it } from "vitest";

import type { ConformanceBackend } from "./client.ts";
import { authStateRow, versionRejectionRow, type ProvisioningEntry } from "./rows.status.ts";
import { judgeCompletedTurn } from "./rows.turns.ts";
import { reduceThread, type ReplayedEvent } from "./session.ts";

const stubBackend = (rejection: string | null, revision = 1): ConformanceBackend => ({
  kind: "mock",
  handshake: async () => ({ clientRpcRevision: revision, backendVersion: "x" }),
  connect: async () => {
    if (rejection) throw new Error(rejection);
    return { call: async () => ({}), close: () => undefined };
  },
});

describe("version rejection row", () => {
  it("passes only a 426 refusal with the advertised revision", async () => {
    expect((await versionRejectionRow(stubBackend("Unexpected server response: 426"))).status).toBe(
      "pass",
    );
  });

  it.each([
    ["Unexpected server response: 401", 1, "expected 426, got 401"],
    ["socket hang up", 1, "no status"],
    [null, 1, "was accepted"],
    ["Unexpected server response: 426", 2, "advertises revision 2"],
  ])("fails for %s (revision %i)", async (rejection, revision, reason) => {
    const row = await versionRejectionRow(stubBackend(rejection, revision));
    expect(row.status).toBe("fail");
    expect(row.reason).toContain(reason);
  });
});

const entry = (state: string, authStep = "codex login"): ProvisioningEntry => ({
  provider: "codex",
  state,
  executableSource: "discovered",
  authCheck: "mock#codex",
  authStep,
});

describe("auth state row", () => {
  it("separates needs-auth, expected needs-auth and unobservable auth", () => {
    expect(authStateRow("codex", entry("needs-auth"), false).status).toBe("pass");
    expect(authStateRow("codex", entry("needs-auth", " "), false).status).toBe("fail");
    expect(authStateRow("codex", entry("ready"), true).status).toBe("fail");
    expect(authStateRow("codex", entry("ready"), false).status).toBe("not-run");
  });
});

describe("completed turn judgement", () => {
  const THREAD = "t";
  const events = (text: string, outcome = "completed"): ReplayedEvent[] => [
    {
      sequence: 1,
      eventId: "1",
      type: "thread.message-sent",
      aggregateId: THREAD,
      commandId: null,
      payload: { messageId: "a", role: "assistant", text, streaming: false },
    },
    {
      sequence: 2,
      eventId: "2",
      type: "thread.turn-settled",
      aggregateId: THREAD,
      commandId: null,
      payload: { turnId: "x", outcome },
    },
  ];
  const judge = (text: string, outcome?: string, met = true) =>
    judgeCompletedTurn(reduceThread(events(text, outcome), THREAD), met, "BBCONF-0000ABCD");

  it("needs the deadline met, a completed outcome and the token in the reply", () => {
    expect(judge("ok BBCONF-0000ABCD").status).toBe("pass");
    expect(judge("no token here").reason).toContain("expected token");
    expect(judge("BBCONF-0000ABCD", "failed").reason).toContain("settled failed");
    expect(judge("BBCONF-0000ABCD", "completed", false).reason).toContain("deadline");
  });
});
