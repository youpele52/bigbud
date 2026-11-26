import { afterEach, describe, expect, it } from "vitest";

import { startSelectedV2OwnerProcess } from "./ServerManager.ownerV2.selected.ts";
import {
  cleanupFixtures,
  config,
  noTarget,
  refusal,
  targetWithBinding,
} from "./sshOwner.opencodeV2Composition.fixture.ts";

afterEach(cleanupFixtures);

describe("selected OpenCode v2 SSH owner typed refusals", () => {
  it.each([
    {
      name: "no binding",
      source: targetWithBinding(undefined),
      config: config(),
      platform: "linux" as const,
      reason: "no-binding",
    },
    {
      name: "non-absolute binding",
      source: targetWithBinding("opencode"),
      config: config(),
      platform: "linux" as const,
      reason: "non-absolute-path",
    },
    {
      name: "platform without the owner lane",
      source: { target: noTarget },
      config: config(),
      platform: "darwin" as const,
      reason: "platform",
    },
    {
      name: "missing workspace root",
      source: { target: noTarget },
      config: (() => {
        const { workspaceRoot: _root, ...withoutWorkspace } = config();
        return withoutWorkspace;
      })(),
      platform: "linux" as const,
      reason: "workspace",
    },
    {
      name: "owner unavailable",
      source: { target: noTarget },
      config: config(),
      platform: "linux" as const,
      reason: "owner-unavailable",
    },
  ])("refuses $name with its typed reason", async ({ source, config: input, platform, reason }) => {
    await expect(refusal(startSelectedV2OwnerProcess(input, source, { platform }))).resolves.toBe(
      reason,
    );
  });

  it("refuses without any selected owner source", async () => {
    await expect(
      refusal(startSelectedV2OwnerProcess(config(), undefined, { platform: "linux" })),
    ).resolves.toBe("owner-unavailable");
  });
});
