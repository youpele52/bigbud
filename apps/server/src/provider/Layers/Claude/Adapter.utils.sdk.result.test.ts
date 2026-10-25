import type { SDKResultMessage, TerminalReason } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { turnStatusFromResult } from "./Adapter.utils.sdk.ts";

function terminalResult(
  subtype: "success" | "error_max_turns",
  terminalReason: TerminalReason,
): SDKResultMessage {
  const common = {
    type: "result" as const,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: subtype !== "success",
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: "standard" as const,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      inference_geo: "not_available",
      iterations: [],
      speed: "standard" as const,
      fallback_credit: null,
      output_tokens_details: { thinking_tokens: 0 },
    },
    modelUsage: {},
    permission_denials: [],
    uuid: "00000000-0000-4000-8000-000000000001" as const,
    session_id: "result-status-test",
    terminal_reason: terminalReason,
  };
  return subtype === "success"
    ? { ...common, subtype, result: "partial response" }
    : { ...common, subtype, errors: ["Reached max turns"] };
}

describe("Claude SDK terminal result status", () => {
  it.each(["aborted_streaming", "aborted_tools"] as const)(
    "maps native %s interruption without relying on error wording",
    (reason) => {
      expect(turnStatusFromResult(terminalResult("error_max_turns", reason))).toBe("interrupted");
      expect(turnStatusFromResult(terminalResult("success", reason))).toBe("interrupted");
    },
  );
  it("preserves ordinary completion and genuine turn-limit failures", () => {
    expect(turnStatusFromResult(terminalResult("success", "completed"))).toBe("completed");
    expect(turnStatusFromResult(terminalResult("error_max_turns", "max_turns"))).toBe("failed");
  });
});
