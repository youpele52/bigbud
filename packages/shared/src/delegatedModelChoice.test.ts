import { describe, expect, it } from "vitest";

import {
  deriveDelegatedModelChoiceRecord,
  derivePendingDelegatedModelChoice,
  modelSelectionKey,
} from "./delegatedModelChoice";

const fallback = { provider: "codex", model: "gpt-5" };
const requestedPayload = (choiceId: string) => ({
  choiceId,
  delegationId: "delegation-1",
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
});
const requested = (choiceId: string, createdAt = "2026-10-15T10:00:00.000Z") => ({
  id: `${choiceId}:requested`,
  kind: "delegation.model-choice-requested",
  payload: requestedPayload(choiceId),
  createdAt,
});
const resolved = (choiceId: string, createdAt = "2026-10-15T10:00:05.000Z") => ({
  id: `${choiceId}:resolved`,
  kind: "delegation.model-choice-resolved",
  payload: {
    choiceId,
    requested: { provider: "claudeAgent", model: "claude-opus" },
    fallback,
    reason: "provider-hidden",
    used: fallback,
    outcome: "fallback",
    resolvedBy: "timeout",
  },
  createdAt,
});

describe("derivePendingDelegatedModelChoice", () => {
  it("is pending until a resolution with the same choice id", () => {
    expect(derivePendingDelegatedModelChoice([requested("c-1")])?.choiceId).toBe("c-1");
    expect(derivePendingDelegatedModelChoice([requested("c-1"), resolved("c-2")])?.choiceId).toBe(
      "c-1",
    );
    expect(derivePendingDelegatedModelChoice([requested("c-1"), resolved("c-1")])).toBeNull();
  });

  it("ignores malformed payloads and unrelated activities", () => {
    expect(
      derivePendingDelegatedModelChoice([
        { kind: "delegation.model-choice-requested", payload: { choiceId: 1 } },
        { kind: "approval.requested", payload: { requestId: "r" } },
      ]),
    ).toBeNull();
  });
});

describe("deriveDelegatedModelChoiceRecord", () => {
  it("reports pending, then the resolution", () => {
    expect(deriveDelegatedModelChoiceRecord([])).toBeNull();
    expect(deriveDelegatedModelChoiceRecord([requested("c-1")])).toMatchObject({
      status: "pending",
      choiceId: "c-1",
      reason: "provider-hidden",
    });
    expect(deriveDelegatedModelChoiceRecord([requested("c-1"), resolved("c-1")])).toMatchObject({
      status: "resolved",
      used: fallback,
      outcome: "fallback",
      resolvedBy: "timeout",
      cancelled: false,
    });
  });

  it("reports an immediate resolution without a request", () => {
    expect(deriveDelegatedModelChoiceRecord([resolved("c-1")])).toMatchObject({
      status: "resolved",
      choiceId: "c-1",
    });
  });
});

describe("modelSelectionKey", () => {
  it("compares provider, model and sub-provider only", () => {
    expect(modelSelectionKey({ provider: "pi", model: "m", subProviderID: "openai" })).not.toBe(
      modelSelectionKey({ provider: "pi", model: "m" }),
    );
    expect(modelSelectionKey({ provider: "codex", model: "gpt-5" })).toBe(
      modelSelectionKey({
        provider: "codex",
        model: "gpt-5",
        options: { fastMode: true },
      } as never),
    );
  });
});
