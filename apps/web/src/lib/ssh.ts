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
