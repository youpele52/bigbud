import type { SessionMessageAssistant } from "@opencode/client";
import { ThreadId, MessageId, TurnId } from "@bigbud/contracts/core/baseSchemas";
import type { ProviderTurnAdmission } from "@bigbud/contracts/orchestration/providerTurnAdmission.ts";
import { describe, expect, it } from "vitest";

import { authoritativeAssistantRepair } from "./Projection.ts";

const admission: ProviderTurnAdmission = {
  namespace: "foreground",
  ownerThreadId: ThreadId.makeUnsafe("owner"),
  requestMessageId: MessageId.makeUnsafe("request"),
  nativeAdmissionId: "msg_request",
  turnId: TurnId.makeUnsafe("turn"),
  fingerprint: "fixture",
  state: "accepted",
  revision: 2,
  createdAt: "fixture",
  updatedAt: "fixture",
  finalText: null,
  binding: {
    provider: "opencodeV2",
    threadId: ThreadId.makeUnsafe("owner"),
    nativeSessionId: "ses_fixture",
    location: "/synthetic",
    runtimeTargetId: "local",
    workspaceTargetId: "local",
    storageIdentity: "fixture",
  },
};
const message: SessionMessageAssistant = {
  id: "msg_assistant",
  type: "assistant",
  agent: "fixture",
  model: { providerID: "fixture", id: "fixture" },
  time: { created: 1, completed: 2 },
  finish: "stop",
  content: [
    { type: "text", text: "first\n" },
    { type: "reasoning", text: "private reasoning" },
    { type: "text", text: "last\n" },
  ],
};
const input = {
  admission,
  message,
  nativeSessionId: "ses_fixture",
  location: "/synthetic",
  sessionEpoch: 3,
  isCurrent: true,
  correlationProven: true,
};

describe("authoritative V2 assistant projection repair", () => {
  it("preserves exact full text/stable item identity without leaking reasoning or claiming terminal", () => {
    const repaired = authoritativeAssistantRepair(input);
    expect(repaired).toMatchObject({
      type: "item.completed",
      provider: "opencodeV2",
      itemId: "msg_assistant",
      sessionEpoch: 3,
      turnId: "turn",
      payload: { itemType: "assistant_message", detail: "first\nlast\n" },
    });
    expect(authoritativeAssistantRepair(input)).toEqual(repaired);
  });
  it("rejects uncorrelated/stale/unfinished/empty or wrong-binding observations", () => {
    for (const patch of [
      { isCurrent: false },
      { correlationProven: false },
      { location: "/hostile" },
      { nativeSessionId: "ses_other" },
      { sessionEpoch: -1 },
      { message: { ...message, time: { created: 1 } } },
      { message: { ...message, content: [] } },
      { admission: { ...admission, state: "dispatch-intent" as const } },
    ]) {
      expect(authoritativeAssistantRepair({ ...input, ...patch })).toBeUndefined();
    }
  });
});
