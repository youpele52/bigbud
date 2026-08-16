import { EventId, ThreadId, TurnId, type ProviderRuntimeEvent } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { isMeaningfulProviderProgress, isTerminalProviderEvent } from "./providerTurnLiveness.ts";

const base = {
  eventId: EventId.makeUnsafe("liveness-event"),
  provider: "codex" as const,
  threadId: ThreadId.makeUnsafe("liveness-thread"),
  turnId: TurnId.makeUnsafe("liveness-turn"),
  createdAt: "2026-08-13T00:00:00.000Z",
};

describe("provider turn meaningful progress", () => {
  it.each([
    ["content.delta", { streamKind: "assistant_text", delta: "hello" }],
    ["turn.plan.updated", { plan: [] }],
    ["request.opened", { requestId: "request", requestKind: "tool" }],
    ["tool.progress", { itemType: "command_execution", detail: "working" }],
  ] as const)("counts %s", (type, payload) => {
    expect(isMeaningfulProviderProgress({ ...base, type, payload } as ProviderRuntimeEvent)).toBe(
      true,
    );
  });

  it.each([
    ["thread.token-usage.updated", { usage: {} }],
    ["account.rate-limits.updated", { rateLimits: {} }],
    ["item.updated", { itemType: "unknown", status: "inProgress" }],
  ] as const)("does not count bookkeeping %s", (type, payload) => {
    expect(isMeaningfulProviderProgress({ ...base, type, payload } as ProviderRuntimeEvent)).toBe(
      false,
    );
  });

  it("classifies only terminal lifecycle events as terminal", () => {
    expect(
      isTerminalProviderEvent({
        ...base,
        type: "turn.completed",
        payload: { state: "completed" },
      }),
    ).toBe(true);
    expect(isTerminalProviderEvent({ ...base, type: "turn.started", payload: {} })).toBe(false);
  });
});
