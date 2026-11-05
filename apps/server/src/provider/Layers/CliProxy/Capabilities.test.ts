import { describe, expect, it } from "vitest";

import { resolveClaudeRuntimeTraits } from "../Claude/Adapter.session.options.ts";
import {
  cliProxyModelEnvironment,
  decodeCliProxyCapabilities,
  UNKNOWN_CLIPROXY_CAPABILITIES,
} from "./Capabilities.ts";

describe("CLIProxy harness capabilities", () => {
  it("uses the live default rather than forwarding an unadvertised effort", () => {
    const capabilities = decodeCliProxyCapabilities([{ effort: "high" }], "high");
    for (const effort of [undefined, "max", "ultrathink", "future-depth"]) {
      expect(
        resolveClaudeRuntimeTraits(
          {
            provider: "claudeAgent",
            model: "proxy-model",
            options: { effort },
          },
          capabilities,
        ).effectiveEffort,
      ).toBe("high");
    }
  });

  it("does not inherit Claude capabilities for a proxy model without metadata", () => {
    expect(
      resolveClaudeRuntimeTraits(
        {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: { effort: "max" },
        },
        UNKNOWN_CLIPROXY_CAPABILITIES,
      ).effectiveEffort,
    ).toBeNull();
    expect(cliProxyModelEnvironment("claude-opus-4-6", UNKNOWN_CLIPROXY_CAPABILITIES)).toEqual({
      ANTHROPIC_CUSTOM_MODEL_OPTION: "claude-opus-4-6",
      ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: "",
    });
  });

  it("enables max only when advertised, without assuming thinking features", () => {
    const capabilities = decodeCliProxyCapabilities([{ effort: "max" }], "max")!;
    expect(cliProxyModelEnvironment("proxy-model", capabilities)).toEqual({
      ANTHROPIC_CUSTOM_MODEL_OPTION: "proxy-model",
      ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: "effort,max_effort",
    });
  });
});
