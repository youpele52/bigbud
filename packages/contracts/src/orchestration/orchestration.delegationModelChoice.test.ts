import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ClientOrchestrationCommand, OrchestrationCommand } from "./orchestration.commands";
import {
  DELEGATED_MODEL_CHOICE_HOLD_MS,
  DelegationModelChoiceRequested,
  DelegationModelChoiceResolved,
  RequestedModelSelection,
} from "./orchestration.delegationModelChoice";

const fallback = { provider: "codex", model: "gpt-5" } as const;
const requested = {
  choiceId: "model-choice:1",
  delegationId: "delegation:1",
  requested: { provider: "claudeAgent", model: "claude-opus" },
  fallback,
  reason: "provider-hidden",
  options: [
    {
      selection: fallback,
      label: "GPT-5",
      providerLabel: "Codex",
      lastUsedAt: null,
      isFallback: true,
    },
  ],
  deadlineAt: "2026-10-15T10:00:10.000Z",
  heldMessageId: "message-1",
};

describe("delegated model choice contracts", () => {
  it("holds the first turn for ten seconds", () => {
    expect(DELEGATED_MODEL_CHOICE_HOLD_MS).toBe(10_000);
  });

  it("trims a requested selection and bounds its fields", () => {
    const decode = Schema.decodeUnknownSync(RequestedModelSelection);
    expect(decode({ provider: " codex ", model: " gpt-5 " })).toEqual({
      provider: "codex",
      model: "gpt-5",
    });
    expect(() => decode({ provider: "x".repeat(65) })).toThrow();
    expect(() => decode({ provider: "codex", model: "m".repeat(257) })).toThrow();
    expect(() => decode({ provider: "pi", subProviderID: "s".repeat(129) })).toThrow();
    // Any provider string is accepted here; usability is decided by the server, never by decoding.
    expect(decode({ provider: "not-a-provider" })).toEqual({ provider: "not-a-provider" });
  });

  it("decodes requested and resolved activity payloads", () => {
    expect(Schema.decodeUnknownSync(DelegationModelChoiceRequested)(requested)).toMatchObject({
      choiceId: "model-choice:1",
      reason: "provider-hidden",
    });
    const resolved = Schema.decodeUnknownSync(DelegationModelChoiceResolved)({
      choiceId: "model-choice:1",
      requested: requested.requested,
      fallback,
      reason: "provider-hidden",
      used: fallback,
      outcome: "fallback",
      resolvedBy: "timeout",
    });
    expect(resolved.cancelled).toBeUndefined();
    expect(() =>
      Schema.decodeUnknownSync(DelegationModelChoiceRequested)({
        ...requested,
        options: Array.from({ length: 101 }, () => requested.options[0]),
      }),
    ).toThrow();
  });

  it("routes the hold and expire commands as internal and pick as a client command", () => {
    const hold = Schema.decodeUnknownSync(OrchestrationCommand)({
      type: "thread.delegation.model-choice.hold",
      commandId: "cmd-hold",
      threadId: "child-1",
      prompt: { messageId: "message-1", text: "Do the task" },
      runtimeMode: "full-access",
      interactionMode: "default",
      requestedActivity: { id: "activity-1", summary: "Choose a model", payload: requested },
      createdAt: "2026-10-15T10:00:00.000Z",
    });
    expect(hold.type).toBe("thread.delegation.model-choice.hold");
    const expire = Schema.decodeUnknownSync(OrchestrationCommand)({
      type: "thread.delegation.model-choice.expire",
      commandId: "cmd-expire",
      threadId: "child-1",
      choiceId: "model-choice:1",
      resolvedBy: "timeout",
      createdAt: "2026-10-15T10:00:10.000Z",
    });
    expect(expire.type).toBe("thread.delegation.model-choice.expire");
    const pick = Schema.decodeUnknownSync(ClientOrchestrationCommand)({
      type: "thread.delegation.model-choice.pick",
      commandId: "cmd-pick",
      threadId: "child-1",
      choiceId: "model-choice:1",
      modelSelection: fallback,
      createdAt: "2026-10-15T10:00:05.000Z",
    });
    expect(pick.type).toBe("thread.delegation.model-choice.pick");
    expect(() =>
      Schema.decodeUnknownSync(ClientOrchestrationCommand)({
        type: "thread.delegation.model-choice.expire",
        commandId: "cmd-expire",
        threadId: "child-1",
        choiceId: "model-choice:1",
        resolvedBy: "timeout",
        createdAt: "2026-10-15T10:00:10.000Z",
      }),
    ).toThrow();
  });
});
