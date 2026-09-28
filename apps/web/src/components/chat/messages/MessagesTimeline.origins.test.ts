import type { MessageOriginSegment } from "@bigbud/contracts/orchestration/orchestration.messageOrigin.ts";
import { describe, expect, it } from "vitest";

import { isOriginSourceAvailable, visibleOriginSegments } from "./MessagesTimeline.origins";

function segment(verified: boolean): MessageOriginSegment {
  return {
    kind: "handoff",
    actor: "agent",
    text: "Continue",
    sourceThreads: [{ threadId: "source" as never, title: "Source" }],
    verified,
  };
}

describe("visibleOriginSegments", () => {
  it("only exposes verified sources as attribution", () => {
    expect(visibleOriginSegments([segment(false), segment(true)])).toEqual([segment(true)]);
  });

  it("requires authoritative loaded or catalog state before linking a source", () => {
    expect(isOriginSourceAvailable(undefined, undefined)).toBe(false);
    expect(isOriginSourceAvailable({}, undefined)).toBe(true);
    expect(isOriginSourceAvailable(undefined, {})).toBe(true);
  });
});
