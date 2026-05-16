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

  const match = /^SSH password is required for (.+)\. Re-enter it before using this target\./.exec(
    errorMessage.trim(),
  );
  return match?.[1] ?? null;
}
