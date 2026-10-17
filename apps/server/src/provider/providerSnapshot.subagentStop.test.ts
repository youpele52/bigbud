import type { ProviderKind } from "@bigbud/contracts";
import { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import { Schema } from "effect";
import { expect, it } from "vitest";

import { buildServerProvider } from "./providerSnapshot.ts";

const snapshot = (provider: ProviderKind) =>
  buildServerProvider({
    provider,
    enabled: true,
    checkedAt: "2026-10-16T10:00:00.000Z",
    models: [],
    probe: { installed: true, version: "1.0.0", status: "ready", auth: { status: "unknown" } },
  });

it("advertises per-subagent Stop from the capability declaration only", () => {
  expect(snapshot("claudeAgent").subagentStop).toBe(true);
  for (const provider of ["cliProxy", "codex", "copilot", "pi", "opencodeV2"] as const) {
    expect(snapshot(provider).subagentStop).toBeUndefined();
  }
  expect(Schema.encodeSync(ServerProvider)(snapshot("claudeAgent"))).toMatchObject({
    subagentStop: true,
  });
});
