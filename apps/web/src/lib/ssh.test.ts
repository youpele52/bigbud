import { describe, expect, it } from "vitest";

import { getPassphraseProtectedSshKeyPath, getPasswordProtectedSshTargetLabel } from "./ssh";

describe("ssh error parsing", () => {
  it("extracts passphrase-protected key paths", () => {
    expect(
      getPassphraseProtectedSshKeyPath(
        "SSH key '~/.ssh/open_stack' requires a passphrase. Load it into ssh-agent with 'ssh-add ~/.ssh/open_stack' before using this target.",
      ),
    ).toBe("~/.ssh/open_stack");
  });

  it("extracts password-protected target labels", () => {
    expect(
      getPasswordProtectedSshTargetLabel(
        "SSH password is required for root@46.225.127.53:22. Re-enter it before using this target.",
      ),
    ).toBe("root@46.225.127.53:22");
  });
});
