import { describe, expect, it } from "vitest";

import { validateClaudeResumeBoundary } from "./Adapter.utils.ts";

const ASSISTANT_UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("Claude resume boundary validation", () => {
  it("requires a UUID and a known assistant checkpoint", () => {
    expect(validateClaudeResumeBoundary({ resumeSessionAt: "assistant-99" })).toEqual({
      ok: false,
      issue: "invalid",
    });
    expect(
      validateClaudeResumeBoundary({
        resumeSessionAt: ASSISTANT_UUID,
        knownAssistantUuids: new Set(["550e8400-e29b-41d4-a716-446655440001"]),
      }),
    ).toEqual({ ok: false, issue: "unknown" });
  });

  it("rejects rewind while a turn or callback is pending", () => {
    expect(
      validateClaudeResumeBoundary({
        resumeSessionAt: ASSISTANT_UUID,
        sessionIdle: false,
      }),
    ).toEqual({ ok: false, issue: "busy" });
    expect(
      validateClaudeResumeBoundary({
        resumeSessionAt: ASSISTANT_UUID,
        pendingRequestCount: 1,
      }),
    ).toEqual({ ok: false, issue: "busy" });
  });

  it("accepts an idle known boundary", () => {
    expect(
      validateClaudeResumeBoundary({
        resumeSessionAt: ASSISTANT_UUID,
        knownAssistantUuids: new Set([ASSISTANT_UUID]),
        sessionIdle: true,
      }),
    ).toEqual({ ok: true });
  });
});
