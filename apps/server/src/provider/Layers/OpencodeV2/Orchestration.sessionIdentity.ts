export const V2_SCOPED_NATIVE_SESSION_PREFIX = "ses_bigbud_v2_";
export const V2_COMPACT_NATIVE_SESSION_PREFIX = "ses_bb3_";
export const V2_NATIVE_SESSION_PATH_LIMIT = 100;

/** A permanent fail-closed namespace, never enrollment authority or a replacement for native proof. */
export function v2ScopedNativeSessionPrefix(issuer: string): string {
  if (!/^[a-f0-9]{64}$/.test(issuer)) throw new Error("V2 native session issuer rejected.");
  return `${V2_SCOPED_NATIVE_SESSION_PREFIX}${issuer}_`;
}

/** Lossless 256-bit issuer encoding; v3 IDs fit the native router's 100-character segment bound. */
export function v2CompactNativeSessionPrefix(issuer: string): string {
  v2ScopedNativeSessionPrefix(issuer);
  return `${V2_COMPACT_NATIVE_SESSION_PREFIX}${Buffer.from(issuer, "hex").toString("base64url")}_`;
}

/** Both complete hashes remain authoritative; only their wire representation changes. */
export function v2CompactNativeSessionId(issuer: string, digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("V2 native session digest rejected.");
  return `${v2CompactNativeSessionPrefix(issuer)}${Buffer.from(digest, "hex").toString("base64url")}`;
}

/** Check the encoded full issuer and canonical lossless digest, never a shortened authority. */
export function isV2CompactNativeSessionId(id: string, issuer: string): boolean {
  const prefix = v2CompactNativeSessionPrefix(issuer),
    suffix = id.slice(prefix.length);
  return (
    id.startsWith(prefix) &&
    /^[A-Za-z0-9_-]{43}$/.test(suffix) &&
    Buffer.from(suffix, "base64url").toString("base64url") === suffix
  );
}
