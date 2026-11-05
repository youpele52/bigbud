/**
 * Versioned Muse resume cursor. Distinguishes no cursor from a malformed
 * or version-mismatched one; opaque fields are never parsed beyond shape.
 */
export interface MuseCursor {
  readonly version: 1;
  readonly provider: "muse";
  readonly nativeSessionId: string;
  readonly workspace: string;
  readonly storageIdentity: string;
  readonly model: string;
  readonly subProviderID: string;
}

export function encodeMuseCursor(cursor: MuseCursor): Record<string, unknown> {
  return { ...cursor };
}

/** Distinguishes no cursor from a malformed/version-mismatched one; never guesses. */
export function decodeMuseCursor(raw: unknown): MuseCursor | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  if (
    value.version !== 1 ||
    value.provider !== "muse" ||
    typeof value.nativeSessionId !== "string" ||
    typeof value.workspace !== "string" ||
    typeof value.storageIdentity !== "string" ||
    typeof value.model !== "string" ||
    typeof value.subProviderID !== "string"
  ) {
    return undefined;
  }
  return {
    version: 1,
    provider: "muse",
    nativeSessionId: value.nativeSessionId,
    workspace: value.workspace,
    storageIdentity: value.storageIdentity,
    model: value.model,
    subProviderID: value.subProviderID,
  };
}
