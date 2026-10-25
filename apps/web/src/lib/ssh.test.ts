import { describe, expect, it } from "vitest";

import {
  getPassphraseProtectedSshKeyPath,
  getPasswordProtectedSshTargetLabel,
  getSshAuthFailureToastTitle,
  getSshAuthPrompt,
  getSshHostTrustChallenge,
} from "./ssh";

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

  it("recognizes incorrect password failures as retryable authentication", () => {
    expect(
      getPasswordProtectedSshTargetLabel("Incorrect password for root@46.225.127.53:22."),
    ).toBe("root@46.225.127.53:22");
  });

  it("returns auth-specific toast titles", () => {
    expect(getSshAuthFailureToastTitle("password")).toBe("SSH login failed");
    expect(getSshAuthFailureToastTitle("ssh-key-passphrase")).toBe("SSH key unlock failed");
    expect(getSshAuthFailureToastTitle("host-trust")).toBe("SSH server verification failed");
  });

  it("recognizes validated host-trust challenges without interpreting them as passwords", () => {
    const challenge = {
      challengeId: "approval-1",
      host: "box:2222",
      keyType: "ED25519",
      fingerprint: "SHA256:abc123",
    };
    const message = `SSH host trust is required: ${JSON.stringify(challenge)}`;
    expect(getSshHostTrustChallenge(message)).toEqual(challenge);
    expect(getSshAuthPrompt(message)).toEqual({ mode: "host-trust", label: message });
    expect(getPasswordProtectedSshTargetLabel(message)).toBeNull();
    expect(getSshHostTrustChallenge("SSH host trust is required: invalid")).toBeNull();
    expect(getSshHostTrustChallenge('SSH host trust is required: {"challengeId":"a"}')).toBeNull();
  });
});
