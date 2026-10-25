import { describe, expect, it } from "vitest";
import { EventId, type OrchestrationThreadActivity } from "@bigbud/contracts";
import { deriveWorkLogEntries } from "./workLog";

describe("internal text-generation activity", () => {
  it("keeps metadata provenance and failure statuses out of the conversation work log", () => {
    const activities: OrchestrationThreadActivity[] = [
      "model-succeeded",
      "failed",
      "completed",
      "retry-requested",
      "user-turn-bound",
      "title-stage",
    ].map((kind) => ({
      id: EventId.makeUnsafe(`fixture:${kind}`),
      kind: `text-generation.${kind}`,
      tone: "info",
      summary: "Internal generation metadata",
      payload: {},
      turnId: null,
      createdAt: "2026-10-16T00:00:00.000Z",
    }));
    expect(deriveWorkLogEntries(activities, undefined)).toEqual([]);
  });
});
