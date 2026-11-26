import { Schema } from "effect";
import { SshHostTrustChallenge } from "@bigbud/contracts/server/server.sshHostTrust";

export type SshAuthMode = "password" | "ssh-key-passphrase" | "host-trust";

export function getPassphraseProtectedSshKeyPath(
  errorMessage: string | null | undefined,
): string | null {
  if (!errorMessage) {
    return null;
  }

  const match = /^SSH key '(.+)' requires a passphrase\./.exec(errorMessage.trim());
  return match?.[1] ?? null;
}

export function getPasswordProtectedSshTargetLabel(
  errorMessage: string | null | undefined,
): string | null {
  if (!errorMessage) {
    return null;
  }

  const normalized = errorMessage.trim();
  const requiredMatch =
    /^SSH password is required for (.+)\. Re-enter it before using this target\./.exec(normalized);
  if (requiredMatch?.[1]) return requiredMatch[1];

  const incorrectMatch = /^Incorrect password for (.+)\.$/.exec(normalized);
  return incorrectMatch?.[1] ?? null;
}

export function getSshAuthFailureToastTitle(authMode: SshAuthMode): string {
  if (authMode === "host-trust") return "SSH server verification failed";
  return authMode === "password" ? "SSH login failed" : "SSH key unlock failed";
}

/** U3: Windows ships key-only, so this is guidance, never a credential prompt. */
export const SSH_WINDOWS_PASSWORD_UNSUPPORTED_COPY = "Use an SSH key for this host.";

/** W1.3/S1: the previous owner's process could not be verified. */
export const SSH_OWNER_RETIREMENT_UNVERIFIED_COPY =
  "The previous SSH owner's process could not be verified. Stop bigbud and run `bigbud-ssh-owner --retirement-recover --lock <stateDir>/backend.lock --record <name>` only when the recorded process is provably gone or its PID is provably reused.";

/** W3.6: Build A was not drained, so Build B fences SSH while local work continues. */
export const SSH_LEGACY_ENTRY_FENCED_COPY =
  "This backend cannot use SSH yet because the previous version did not record a completed drain. Local work continues; drain the identified SSH panes to continue.";

/** Typed ownership refusals that are not credential prompts. */
export function getSshOwnershipMessage(code: unknown): string | null {
  switch (code) {
    case "sshOwnerRetirementUnverified":
      return SSH_OWNER_RETIREMENT_UNVERIFIED_COPY;
    case "legacyEntryFenced":
      return SSH_LEGACY_ENTRY_FENCED_COPY;
    default:
      return null;
  }
}

/** Typed credential-capability refusals, which must never open a prompt. */
export function getSshUnsupportedCredentialMessage(code: unknown): string | null {
  switch (code) {
    case "sshWindowsPasswordUnsupported":
      return SSH_WINDOWS_PASSWORD_UNSUPPORTED_COPY;
    case "sshKeyboardInteractiveUnsupported":
      return "This host only offers keyboard-interactive login, which is not supported. Use SSH key authentication.";
    case "sshSessionQuota":
      return "The SSH server reached its session limit. Close another SSH session for this host and retry.";
    default:
      return null;
  }
}

/** Host confirmation travels through the existing SSH setup-error flow, never as a credential. */
export function getSshHostTrustChallenge(
  message: string | null | undefined,
): SshHostTrustChallenge | null {
  const prefix = "SSH host trust is required: ";
  if (!message?.startsWith(prefix)) return null;
  try {
    return Schema.decodeUnknownSync(SshHostTrustChallenge)(
      JSON.parse(message.slice(prefix.length)),
    );
  } catch {
    return null;
  }
}

export function getSshAuthPrompt(message: string): { mode: SshAuthMode; label: string } | null {
  if (getSshHostTrustChallenge(message)) return { mode: "host-trust", label: message };
  const key = getPassphraseProtectedSshKeyPath(message);
  if (key) return { mode: "ssh-key-passphrase", label: key };
  const target = getPasswordProtectedSshTargetLabel(message);
  return target ? { mode: "password", label: target } : null;
}
