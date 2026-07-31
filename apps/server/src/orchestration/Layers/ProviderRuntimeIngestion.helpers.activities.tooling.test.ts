import { EventId, type ProviderRuntimeEvent, ThreadId, TurnId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { toolingRuntimeEventToActivities } from "./ProviderRuntimeIngestion.helpers.activities.tooling.ts";
import {
  toApprovalRequestId,
  toTurnId,
  truncateDetail,
} from "./ProviderRuntimeIngestion.helpers.ts";

const threadId = ThreadId.makeUnsafe("thread-1");
const turnId = TurnId.makeUnsafe("turn-1");
const createdAt = "2026-07-26T00:00:00.000Z";

const helpers = {
  toTurnId,
  toApprovalRequestId,
  truncateDetail,
  requestKindFromCanonicalRequestType: () => undefined,
  buildContextWindowActivityPayload: () => undefined,
};

describe("toolingRuntimeEventToActivities", () => {
  it("bounds and redacts tool data before projecting it", () => {
    const activities = toolingRuntimeEventToActivities(
      {
        type: "item.updated",
        eventId: EventId.makeUnsafe("event-1"),
        provider: "claudeAgent",
        createdAt,
        threadId,
        turnId,
        payload: {
          itemType: "command_execution",
          title: "Run command",
          data: {
            token: "sk_topsecretvalue",
            endpoint: "https://example.com/private?token=secret",
            nested: { password: "not-for-display" },
          },
        },
      } as Extract<ProviderRuntimeEvent, { type: "item.updated" }>,
      helpers,
      {},
    );

    expect(activities[0]?.payload).toEqual({
      itemType: "command_execution",
      data: {
        token: "[redacted]",
        endpoint: "[redacted-url]",
        nested: { password: "[redacted]" },
      },
    });
  });

  it("uses the correlated tool use as the stable summary identity", () => {
    const activities = toolingRuntimeEventToActivities(
      {
        type: "tool.summary",
        eventId: EventId.makeUnsafe("summary-event-1"),
        provider: "claudeAgent",
        createdAt,
        threadId,
        turnId,
        payload: {
          summary: "Completed https://example.com/private with bearer top-secret",
          precedingToolUseIds: ["tool-1", "tool-2"],
        },
      } as Extract<ProviderRuntimeEvent, { type: "tool.summary" }>,
      helpers,
      {},
    );

    expect(activities[0]).toMatchObject({
      id: "tool-summary:tool-2",
      payload: {
        detail: "Completed [redacted-url] with [redacted]",
        precedingToolUseIds: ["tool-1", "tool-2"],
      },
    });
  });

  it("defensively redacts MCP status activity metadata", () => {
    const activities = toolingRuntimeEventToActivities(
      {
        type: "mcp.status.updated",
        eventId: EventId.makeUnsafe("mcp-event-1"),
        provider: "claudeAgent",
        createdAt,
        threadId,
        payload: {
          status: [
            {
              name: "docs",
              status: "needs-auth",
              message: "Open https://example.test/login?token=secret token=hidden",
            },
          ],
        },
        raw: {
          source: "claude.sdk.message",
          method: "mcp/status",
          payload: { token: "native-secret" },
        },
      } as Extract<ProviderRuntimeEvent, { type: "mcp.status.updated" }>,
      helpers,
      {},
    );

    expect(activities[0]?.payload).toEqual({
      status: [
        {
          name: "docs",
          status: "needs-auth",
          message: "Open [redacted-url] [redacted]",
        },
      ],
    });
    expect(JSON.stringify(activities)).not.toContain("native-secret");
  });
});
