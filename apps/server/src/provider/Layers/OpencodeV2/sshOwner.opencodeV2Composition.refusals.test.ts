import { afterEach, describe, expect, it } from "vitest";

import {
  makeProductionV2OwnerSource,
  startSelectedV2OwnerProcess,
} from "./ServerManager.ownerV2.selected.ts";
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
      platform: "win32" as const,
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

  it.each(["non-absolute-path", "settings-unreadable"] as const)(
    "production reports a settings refusal (%s) instead of no-binding",
    async (reason) => {
      const handle = {
        ownerEpoch: new Uint8Array(32),
        opencodeV2Refusal: reason,
        target: () => {
          throw new Error("an unbound owner must not bind a target");
        },
      } as unknown as Parameters<typeof makeProductionV2OwnerSource>[0];
      const source = makeProductionV2OwnerSource(handle, async (targetId) => ({
        targetId,
        kind: "structured",
        host: "127.0.0.1",
        port: 22,
        user: "tester",
        identityFile: "/srv/id",
        knownHostsFile: "/srv/known_hosts",
      }));
      await expect(
        refusal(startSelectedV2OwnerProcess(config(), source, { platform: "linux" })),
      ).resolves.toBe(reason);
    },
  );
});
