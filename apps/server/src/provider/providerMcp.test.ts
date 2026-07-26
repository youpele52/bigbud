import { describe, expect, it } from "vitest";

import {
  hasUnreadyRequiredMcpStatuses,
  mcpReadinessPolicy,
  normalizeMcpServerStatuses,
  redactMcpText,
  shouldPollRequiredMcpStatuses,
  validateMcpAction,
} from "./providerMcp.ts";

describe("provider MCP normalization", () => {
  it("normalizes aliases, bounds metadata, and drops malformed entries", () => {
    const statuses = normalizeMcpServerStatuses([
      {
        name: " docs ",
        status: "needs_authentication",
        error: "https://example.test/login token=secret",
        version: " 1.2.3 ",
      },
      { name: "", status: "connected" },
      null,
    ]);

    expect(statuses).toEqual([
      {
        name: "docs",
        status: "needs-auth",
        message: "[redacted-url] token=[redacted]",
        version: "1.2.3",
      },
    ]);
  });

  it("redacts URLs, bearer credentials, and submitted secrets", () => {
    expect(
      redactMcpText("POST https://example.test/x Bearer abc123 api_key=hidden password:pw"),
    ).toBe("POST [redacted-url] Bearer [redacted] api_key=[redacted] password=[redacted]");
  });

  it("protects the required orchestration bridge", () => {
    expect(
      validateMcpAction({ type: "toggle", serverName: "bigbud_orchestration", enabled: false }),
    ).toEqual({
      ok: false,
      issue: "MCP server 'bigbud_orchestration' is required by bigbud and cannot be changed.",
    });
    expect(validateMcpAction({ type: "replace", servers: { docs: { type: "http" } } })).toEqual({
      ok: false,
      issue: "MCP replacement must retain required server 'bigbud_orchestration'.",
    });
    expect(
      validateMcpAction({
        type: "replace",
        servers: { bigbud_orchestration: { type: "stdio" }, docs: { type: "http" } },
      }),
    ).toEqual({ ok: true });
  });

  it("polls only for missing or unready required bridges", () => {
    expect(hasUnreadyRequiredMcpStatuses([{ name: "docs", status: "pending" }])).toBe(true);
    expect(
      hasUnreadyRequiredMcpStatuses([
        { name: "bigbud_orchestration", status: "connected" },
        { name: "docs", status: "pending" },
      ]),
    ).toBe(false);
    expect(
      shouldPollRequiredMcpStatuses([{ name: "bigbud_orchestration", status: "failed" }]),
    ).toBe(false);
    expect(shouldPollRequiredMcpStatuses([{ name: "docs", status: "connected" }])).toBe(true);
  });

  it("blocks only on required bridge readiness", () => {
    expect(mcpReadinessPolicy([{ name: "docs", status: "connected" }])).toEqual({
      requiredReady: false,
      optionalPending: false,
    });
    expect(
      mcpReadinessPolicy([
        { name: "bigbud_orchestration", status: "pending" },
        { name: "docs", status: "pending" },
      ]),
    ).toEqual({ requiredReady: false, optionalPending: true });
    expect(
      mcpReadinessPolicy([
        { name: "bigbud_orchestration", status: "connected" },
        { name: "docs", status: "pending" },
      ]),
    ).toEqual({ requiredReady: true, optionalPending: true });
  });
});
