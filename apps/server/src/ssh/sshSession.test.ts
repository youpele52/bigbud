import { describe, expect, it } from "vitest";

import { buildPasswordSessionControlPath, formatSshPasswordRequiredMessage } from "./sshSession.ts";

describe("formatSshPasswordRequiredMessage", () => {
  it("describes the target that needs password auth", () => {
    expect(
      formatSshPasswordRequiredMessage("ssh:host=46.225.127.53&user=root&port=22&auth=password"),
    ).toBe(
      "SSH password is required for root@46.225.127.53:22. Re-enter it before using this target.",
    );
  });
});

describe("buildPasswordSessionControlPath", () => {
  it("keeps the control socket path short for long execution target ids", () => {
    const controlPath = buildPasswordSessionControlPath(
      "ssh:host=134.94.130.176&user=debian&auth=password&keyPath=%2FUsers%2Fyoupele%2F.ssh%2Fsome-very-long-key-name-with-extra-segments",
    );

    expect(controlPath.length).toBeLessThan(60);
    expect(controlPath).toMatch(/\/s-[0-9a-f]{20}$/);
  });
});
