import { backendGraphManifestDigest, decodeBackendGraphManifest } from "./backendGraph.manifest.ts";

declare const runtimeArchiveKeyBrand: unique symbol;
/** `<manifest version>@<sha256 of the canonical signed manifest payload>`. */
export type RuntimeArchiveKey = string & { readonly [runtimeArchiveKeyBrand]: true };

// Same version shape as the manifest decoder; the digest is the verifier's manifestDigest.
const KEY = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}@[a-f0-9]{64}$/;

export function isRuntimeArchiveKey(value: unknown): value is RuntimeArchiveKey {
  return typeof value === "string" && KEY.test(value);
}
export function runtimeArchiveKey(version: string, manifestSha256: string): RuntimeArchiveKey {
  const key = `${version}@${manifestSha256}`;
  if (!isRuntimeArchiveKey(key)) throw new Error("Runtime archive version or digest is invalid.");
  return key;
}
/** Key for a signed manifest before its graph is extracted (signature is checked on record). */
export function runtimeArchiveKeyForManifest(manifest: unknown): RuntimeArchiveKey {
  const decoded = decodeBackendGraphManifest(manifest);
  return runtimeArchiveKey(decoded.version, backendGraphManifestDigest(decoded));
}
