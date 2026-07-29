import { describe, expect, it } from "vitest";

import { EventId, ThreadId, type ProviderRuntimeEvent } from "@bigbud/contracts";

import { claudeModernizationMetricAttributes, claudeRuntimeMetricAttributes } from "./Metrics.ts";

describe("Claude modernization metrics", () => {
  it("keeps only bounded low-cardinality dimensions", () => {
    expect(
      claudeModernizationMetricAttributes({
        event: "approval_replay",
        provider: "claudeAgent",
        outcome: "success",
        source: "https://secret.example/path?token=hidden",
        mode: "accept",
      }),
    ).toEqual({
      event: "approval_replay",
      provider: "claudeAgent",
      outcome: "success",
      mode: "accept",
    });
  });

  it("maps unknown event names to a safe bucket", () => {
    expect(claudeModernizationMetricAttributes({ event: "raw-sdk-payload" })).toEqual({
      event: "unknown",
    });
  });

  it("rejects descoped events and non-allowlisted sensitive dimensions", () => {
    expect(
      claudeModernizationMetricAttributes({
        event: "rewind",
        provider: "claudeAgent",
        outcome: "sk-secret",
        source: "/Users/private/project",
        mode: "native-message-id",
      }),
    ).toEqual({ event: "unknown", provider: "claudeAgent" });
  });

  it("maps retained runtime events without native payload dimensions", () => {
    const event = {
      type: "mcp.status.updated",
      eventId: EventId.makeUnsafe("event-1"),
      provider: "claudeAgent",
      createdAt: "2026-07-26T00:00:00.000Z",
      threadId: ThreadId.makeUnsafe("thread-1"),
      payload: { status: [{ name: "docs", status: "connected" }] },
      raw: {
        source: "claude.sdk.message",
        method: "mcp/status",
        payload: { token: "secret" },
      },
    } as Extract<ProviderRuntimeEvent, { type: "mcp.status.updated" }>;
    expect(claudeRuntimeMetricAttributes(event)).toEqual({
      event: "mcp",
      provider: "claudeAgent",
      source: "runtime",
    });
  });
});
