export function getPassphraseProtectedSshKeyPath(
  errorMessage: string | null | undefined,
): string | null {
  if (!errorMessage) {
    return null;
  }

  const match = /^SSH key '(.+)' requires a passphrase\./.exec(errorMessage.trim());
  return match?.[1] ?? null;
}
