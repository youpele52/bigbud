export function isConfirmedMissingWorkspacePathError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /\b(?:ENOENT|ENOTDIR)\b|no such file or directory/i.test(message) ||
    /\bNOT_FOUND:\s*workspace path was not found\b/i.test(message)
  );
}
