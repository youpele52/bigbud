import { randomBytes } from "node:crypto";

/** Images the remote clipboard step understands, by magic bytes. */
const IMAGE_SIGNATURES: ReadonlyArray<{
  readonly extension: string;
  readonly mimeType: string;
  readonly matches: (head: Uint8Array) => boolean;
}> = [
  {
    extension: "png",
    mimeType: "image/png",
    matches: (h) => h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47,
  },
  {
    extension: "jpg",
    mimeType: "image/jpeg",
    matches: (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff,
  },
  {
    extension: "gif",
    mimeType: "image/gif",
    matches: (h) => h[0] === 0x47 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x38,
  },
  {
    extension: "webp",
    mimeType: "image/webp",
    matches: (h) =>
      h[0] === 0x52 &&
      h[1] === 0x49 &&
      h[2] === 0x46 &&
      h[3] === 0x46 &&
      h[8] === 0x57 &&
      h[9] === 0x45 &&
      h[10] === 0x42 &&
      h[11] === 0x50,
  },
];

export interface PasteFileKind {
  /** Lowercase `[a-z0-9]{1,10}`, safe in a path without quoting. */
  readonly extension: string;
  /** Set only for recognised images (from content, never from the client's claim). */
  readonly imageMimeType: string | null;
}

/** Content decides images; otherwise a sanitized extension from the display name, else `bin`. */
export function classifyPasteFile(head: Uint8Array, fileName: string): PasteFileKind {
  const image = IMAGE_SIGNATURES.find((signature) => signature.matches(head));
  if (image) return { extension: image.extension, imageMimeType: image.mimeType };
  const dot = fileName.lastIndexOf(".");
  const candidate = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  return {
    extension: /^[a-z0-9]{1,10}$/.test(candidate) ? candidate : "bin",
    imageMimeType: null,
  };
}

/** Random, space-free and shell-safe: never needs quoting when pasted. */
export function randomPasteBaseName(): string {
  return `paste-${randomBytes(12).toString("hex")}`;
}

export function randomPasteUploadId(): string {
  return randomBytes(16).toString("hex");
}

/** Absolute on POSIX or Windows (drive or UNC); never relative and never `~`-prefixed. */
export function isAbsolutePastePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}
