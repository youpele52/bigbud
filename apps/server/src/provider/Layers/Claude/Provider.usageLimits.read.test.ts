import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ query: vi.fn(), usage: vi.fn(), close: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }));
import { readClaudeSubscriptionUsage } from "./Provider.usageLimits.read.ts";

afterEach(() => vi.clearAllMocks());

describe("Claude quota-only reads", () => {
  it("skips transcript behaviors and closes its isolated runtime without starting a conversation", async () => {
    sdk.query.mockReturnValue({
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: sdk.usage,
      close: sdk.close,
    });
    sdk.usage.mockResolvedValue({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 30 } },
    });
    const result = await Effect.runPromise(readClaudeSubscriptionUsage("custom-claude"));
    expect(result.windows[0]?.utilization).toBe(30);
    expect(result.manualResets).toBeUndefined();
    expect(sdk.usage).toHaveBeenCalledWith({ skipBehaviors: true });
    expect(sdk.query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          pathToClaudeCodeExecutable: "custom-claude",
          allowedTools: [],
        }),
      }),
    );
    expect(sdk.close).toHaveBeenCalledOnce();
  });

  it("isolates failures from provider health and closes the runtime", async () => {
    sdk.query.mockReturnValue({
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: sdk.usage,
      close: sdk.close,
    });
    sdk.usage.mockRejectedValue(new Error("private credential error"));
    const result = await Effect.runPromise(readClaudeSubscriptionUsage("claude"));
    expect(result).toMatchObject({ status: "error", windows: [] });
    expect(JSON.stringify(result)).not.toContain("private credential error");
    expect(sdk.close).toHaveBeenCalledOnce();
  });
});
