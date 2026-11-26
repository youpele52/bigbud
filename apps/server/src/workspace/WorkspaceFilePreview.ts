export const WORKSPACE_FILE_PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

const INVALID_TEXT = "File is not valid UTF-8 text and cannot be previewed.";

/** File previews are text only; binary reads use the separate range operation. */
export function decodeWorkspaceFilePreview(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new Error(INVALID_TEXT);
  try {
    // Keep a leading BOM so an edited file is saved back with the same bytes.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(INVALID_TEXT);
  }
}
