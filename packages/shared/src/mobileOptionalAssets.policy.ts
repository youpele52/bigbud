export const MOBILE_ASSET_MAX_CONTENT_BYTES = 128 * 1024 * 1024;
export const MOBILE_ASSET_MAX_EXPANDED_BYTES = 160 * 1024 * 1024;
export const MOBILE_ASSET_MAX_ENTRIES = 16_384;
export const MOBILE_ASSET_MAX_PAX_BYTES = 16 * 1024;
export const MOBILE_ASSET_MAX_DIRECTORY_DEPTH = 32;

/** Shared build/runtime static-only policy; unknown files fail closed. */
export function validateMobileAssetPath(path: string, directory: boolean): string {
  const normalized = directory && path.endsWith("/") ? path.slice(0, -1) : path;
  const parts = normalized.split("/");
  if (
    parts.length > MOBILE_ASSET_MAX_DIRECTORY_DEPTH + (directory ? 0 : 1) ||
    normalized.length > 16 * 1024 ||
    parts.some(
      (part) =>
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) ||
        /^(?:credentials?|secrets?|tokens?|private[-_]?key|id_rsa|id_ed25519)(?:\.|$)/i.test(part),
    )
  ) {
    throw new Error("Unsafe or private mobile asset path.");
  }
  if (
    !directory &&
    !/\.(?:html|js|mjs|css|json|svg|png|webp|jpg|jpeg|ico|woff|woff2|ttf|txt|webmanifest|wasm)$/i.test(
      parts.at(-1)!,
    )
  ) {
    throw new Error("Unsupported mobile static asset extension.");
  }
  return normalized;
}

export function claimMobileAssetPath(
  path: string,
  directory: boolean,
  foldedPaths: Set<string>,
): string {
  const canonical = validateMobileAssetPath(path, directory);
  const folded = canonical.toLowerCase();
  if (foldedPaths.has(folded)) throw new Error("Duplicate or case-colliding mobile asset path.");
  foldedPaths.add(folded);
  return canonical;
}
