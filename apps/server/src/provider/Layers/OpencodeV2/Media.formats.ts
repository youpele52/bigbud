/** Pinned 2.0.19 accepts UTF-8 text and PNG/JPEG/GIF/WebP; never silently admit unsupported binary media. */
export function assertV2MediaFormat(bytes: Buffer, mime: string) {
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime)) throw new Error("V2 attachment MIME rejected.");
  const header = bytes.subarray(0, 12);
  if (
    header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    header.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
    ["GIF87a", "GIF89a"].includes(header.subarray(0, 6).toString("ascii")) ||
    (header.subarray(0, 4).toString("ascii") === "RIFF" &&
      header.subarray(8, 12).toString("ascii") === "WEBP")
  )
    return;
  if (
    mime === "application/pdf" ||
    mime.startsWith("audio/") ||
    mime.startsWith("video/") ||
    (mime.startsWith("image/") && mime !== "image/svg+xml") ||
    header.subarray(0, 5).toString("ascii") === "%PDF-" ||
    bytes.includes(0)
  )
    throw new Error(
      "V2 unsupported attachment format: convert binary media to UTF-8 text or PNG/JPEG/GIF/WebP before admission.",
    );
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      "V2 unsupported attachment format: invalid UTF-8 text; no silent binary omission.",
    );
  }
}
