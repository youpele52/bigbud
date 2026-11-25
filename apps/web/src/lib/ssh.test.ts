import { describe, expect, it } from "vitest";

import {
  getPassphraseProtectedSshKeyPath,
  getPasswordProtectedSshTargetLabel,
  getSshAuthFailureToastTitle,
  getSshAuthPrompt,
  getSshHostTrustChallenge,
  getSshOwnershipMessage,
  getSshUnsupportedCredentialMessage,
  SSH_OWNER_RETIREMENT_UNVERIFIED_COPY,
  SSH_WINDOWS_PASSWORD_UNSUPPORTED_COPY,
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

  it("never treats a typed keyboard-interactive or quota refusal as a credential prompt", () => {
    expect(
      getSshAuthPrompt(getSshUnsupportedCredentialMessage("sshKeyboardInteractiveUnsupported")!),
    ).toBeNull();
    expect(getSshAuthPrompt(getSshUnsupportedCredentialMessage("sshSessionQuota")!)).toBeNull();
  });

  it("uses the key-only Windows copy without opening a password prompt", () => {
    expect(SSH_WINDOWS_PASSWORD_UNSUPPORTED_COPY).toBe("Use an SSH key for this host.");
    expect(getSshUnsupportedCredentialMessage("sshWindowsPasswordUnsupported")).toBe(
      SSH_WINDOWS_PASSWORD_UNSUPPORTED_COPY,
    );
    expect(getSshAuthPrompt(SSH_WINDOWS_PASSWORD_UNSUPPORTED_COPY)).toBeNull();
    expect(getSshUnsupportedCredentialMessage("sshAuthenticationRejected")).toBeNull();
  });

  it("names the retirement recovery remedy without opening a prompt", () => {
    expect(getSshOwnershipMessage("sshOwnerRetirementUnverified")).toBe(
      SSH_OWNER_RETIREMENT_UNVERIFIED_COPY,
    );
    expect(SSH_OWNER_RETIREMENT_UNVERIFIED_COPY).toContain("--retirement-recover");
    expect(getSshAuthPrompt(SSH_OWNER_RETIREMENT_UNVERIFIED_COPY)).toBeNull();
    expect(getSshOwnershipMessage("legacyEntryFenced")).toContain("drain the identified SSH panes");
    expect(getSshOwnershipMessage("sshOwnerUnavailable")).toBeNull();
    expect(getSshOwnershipMessage("sshAuthenticationRejected")).toBeNull();
  });
});
