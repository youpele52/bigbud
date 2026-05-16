import { describe, expect, it } from "vitest";

import { formatSshPasswordRequiredMessage } from "./sshSession.ts";

describe("formatSshPasswordRequiredMessage", () => {
  it("describes the target that needs password auth", () => {
    expect(
      formatSshPasswordRequiredMessage("ssh:host=46.225.127.53&user=root&port=22&auth=password"),
    ).toBe(
      "SSH password is required for root@46.225.127.53:22. Re-enter it before using this target.",
    );
  });
});
