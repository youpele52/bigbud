import { afterEach, describe, expect, it, vi } from "vitest";

import { describeTerminalLimitPrompt } from "./TerminalLimitDialog.logic";
import {
  MAX_PENDING_TERMINAL_LIMIT_PROMPTS,
  promptTerminalLimit,
  registerTerminalLimitPromptHost,
  resolveTerminalLimitPrompt,
  useTerminalLimitPromptStore,
  type TerminalLimitPromptInput,
} from "./terminalLimitPrompt";

const candidate = {
  threadId: "thread-old",
  terminalId: "term-old",
  lastUsedAt: "2026-11-21T09:55:00.000Z",
  busy: false,
};
const refused: TerminalLimitPromptInput = { limit: 24, liveCount: 24, candidate };
const head = () => useTerminalLimitPromptStore.getState().queue[0]!;

let unregister: (() => void) | null = null;
afterEach(() => {
  unregister?.();
  unregister = null;
  vi.useRealTimers();
});

describe("promptTerminalLimit", () => {
  it("cancels at once when no dialog host is mounted", async () => {
    await expect(promptTerminalLimit(refused)).resolves.toBe("cancel");
    expect(useTerminalLimitPromptStore.getState().queue).toHaveLength(0);
  });

  it("queues prompts in order and resolves each with the dialog's decision", async () => {
    unregister = registerTerminalLimitPromptHost();
    const first = promptTerminalLimit(refused);
    const second = promptTerminalLimit({ ...refused, liveCount: 25 });
    expect(
      useTerminalLimitPromptStore.getState().queue.map((entry) => entry.input.liveCount),
    ).toEqual([24, 25]);
    resolveTerminalLimitPrompt(head().id, "evict");
    await expect(first).resolves.toBe("evict");
    resolveTerminalLimitPrompt(head().id, "cancel");
    await expect(second).resolves.toBe("cancel");
    expect(useTerminalLimitPromptStore.getState().queue).toHaveLength(0);
  });

  it("never evicts without a candidate and ignores repeated settles", async () => {
    unregister = registerTerminalLimitPromptHost();
    const pending = promptTerminalLimit({ ...refused, candidate: null });
    const { id } = head();
    resolveTerminalLimitPrompt(id, "evict");
    resolveTerminalLimitPrompt(id, "evict");
    await expect(pending).resolves.toBe("cancel");
  });

  it("cancels overflow at once and everything still waiting when the last host unmounts", async () => {
    unregister = registerTerminalLimitPromptHost();
    const waiting = Array.from({ length: MAX_PENDING_TERMINAL_LIMIT_PROMPTS }, () =>
      promptTerminalLimit(refused),
    );
    await expect(promptTerminalLimit(refused)).resolves.toBe("cancel");
    unregister();
    unregister = null;
    await expect(Promise.all(waiting)).resolves.toEqual(
      Array.from({ length: MAX_PENDING_TERMINAL_LIMIT_PROMPTS }, () => "cancel"),
    );
    expect(useTerminalLimitPromptStore.getState().queue).toHaveLength(0);
  });
});

describe("describeTerminalLimitPrompt", () => {
  it("names the oldest terminal with its last use and busy state", () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-21T10:00:00.000Z") });
    expect(
      describeTerminalLimitPrompt(
        { ...refused, candidate: { ...candidate, busy: true } },
        { label: "Terminal 2", thread: "Fix login" },
      ),
    ).toEqual({
      body: "You have 24 terminals running, the most bigbud allows. Opening another one requires closing one first.",
      candidateLine: "Oldest: “Terminal 2” in “Fix login”, last used 5m ago, busy.",
    });
  });

  it("explains why nothing can be closed when every live terminal is visible", () => {
    const copy = describeTerminalLimitPrompt({ ...refused, candidate: null }, null);
    expect(copy.candidateLine).toBeNull();
    expect(copy.body).toContain("none can be closed for you");
  });
});
