/** Pinned schema contracts only; this is not destructive-operation/runtime qualification. */
export function hasQualifiedCodexModernProtocol(version: string | undefined): boolean {
  return version === "0.164.0" || version === "0.166.0";
}
