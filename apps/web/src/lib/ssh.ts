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

export function getSshAuthFailureToastTitle(authMode: "password" | "ssh-key-passphrase"): string {
  return authMode === "password" ? "SSH login failed" : "SSH key unlock failed";
}
