import { describe, expect, it } from "vitest";

import { isUpdateVersionAllowed, resolveDesktopUpdaterChannelPolicy } from "./updaterChannelPolicy";

describe("desktop updater channel policy", () => {
  it.each([
    ["1.2.3", "stable", "latest", false],
    ["1.2.3-beta.1", "beta", "beta", true],
    ["1.2.3-preview.1", "preview", "preview", true],
    ["1.2.3-nightly.1", "nightly", "nightly", true],
  ] as const)(
    "configures %s for the isolated updater channel",
    (version, releaseChannel, updateChannel, allowPrerelease) => {
      expect(resolveDesktopUpdaterChannelPolicy(version)).toEqual({
        allowPrerelease,
        releaseChannel,
        updateChannel,
      });
    },
  );

  it.each([
    ["1.2.3", ["1.2.4", "v2.0.0"]],
    ["1.2.3-beta.1", ["1.2.3-beta.2", "2.0.0-beta-1"]],
    ["1.2.3-preview.1", ["1.2.3-preview.2", "2.0.0-preview-1"]],
    ["1.2.3-nightly.1", ["1.2.3-nightly.2", "2.0.0-nightly-20260824"]],
  ] as const)("allows same-channel offers for %s", (installed, offeredVersions) => {
    const policy = resolveDesktopUpdaterChannelPolicy(installed);
    for (const offered of offeredVersions) {
      expect(isUpdateVersionAllowed(policy, offered)).toBe(true);
    }
  });

  it.each([
    ["1.2.3", ["1.2.4-beta.1", "1.2.4-preview.1", "1.2.4-nightly.1"]],
    ["1.2.3-beta.1", ["1.2.4", "1.2.4-preview.1", "1.2.4-nightly.1"]],
    ["1.2.3-preview.1", ["1.2.4", "1.2.4-beta.1", "1.2.4-nightly.1"]],
    ["1.2.3-nightly.1", ["1.2.4", "1.2.4-beta.1", "1.2.4-preview.1"]],
  ] as const)("rejects cross-channel offers for %s", (installed, offeredVersions) => {
    const policy = resolveDesktopUpdaterChannelPolicy(installed);
    for (const offered of [...offeredVersions, "1.2.4-rc.1", "1.2.4.foo"]) {
      expect(isUpdateVersionAllowed(policy, offered)).toBe(false);
    }
  });
});
