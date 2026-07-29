import { describe, expect, it } from "vitest";

import { providerSwitchTargetLabel } from "./chat-view-provider-switch.hooks";

describe("providerSwitchTargetLabel", () => {
  it("keeps CLIProxyAPI distinct from Codex", () => {
    expect(providerSwitchTargetLabel("cliProxy")).toBe("CLIProxyAPI");
  });
});
