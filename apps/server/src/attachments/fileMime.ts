/** MIME type → file extension mapping for non-image file attachments. */
export const FILE_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  // Documents
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  // Text
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "text/html": ".html",
  "text/css": ".css",
  "text/javascript": ".js",
  "application/json": ".json",
  "application/xml": ".xml",
  "text/xml": ".xml",
  "application/yaml": ".yaml",
  "text/yaml": ".yaml",
  // Code
  "application/typescript": ".ts",
  "text/typescript": ".ts",
  "application/x-python-code": ".py",
  "text/x-python": ".py",
  "text/x-rust": ".rs",
  "text/x-go": ".go",
  // Archives
  "application/zip": ".zip",
  "application/x-tar": ".tar",
  "application/gzip": ".gz",
  "application/x-gzip": ".gz",
  // Video
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/x-msvideo": ".avi",
  // Audio
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/webm": ".weba",
};

export const SAFE_FILE_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".txt",
  ".md",
  ".csv",
  ".html",
  ".css",
  ".js",
  ".ts",
  ".json",
  ".xml",
  ".yaml",
  ".yml",
  ".py",
  ".rs",
  ".go",
  ".zip",
  ".tar",
  ".gz",
  ".mp4",
  ".webm",
  ".mov",
  ".avi",
  ".mp3",
  ".wav",
  ".ogg",
  ".weba",
]);

/**
 * MIME types that are human-readable text and can be embedded inline in a
 * provider prompt. Binary types (PDF, Office docs, video, audio, archives)
 * are excluded.
 */
const TEXT_READABLE_MIME_PREFIXES = ["text/"];
const TEXT_READABLE_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/typescript",
  "application/x-python-code",
  "application/javascript",
]);

/**
 * Returns true when the given MIME type represents text that can be read and
 * embedded inline in a prompt (e.g. `text/csv`, `application/json`, source code).
 */
export function isTextReadable(mimeType: string): boolean {
  const lower = mimeType.toLowerCase();
  if (TEXT_READABLE_MIME_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  return TEXT_READABLE_MIME_TYPES.has(lower);
}

/** Infer a file extension for a non-image file attachment. Falls back to `.bin`. */
export function inferFileExtension(input: { mimeType: string; fileName?: string }): string {
  const key = input.mimeType.toLowerCase();
  const fromMime = Object.hasOwn(FILE_EXTENSION_BY_MIME_TYPE, key)
    ? FILE_EXTENSION_BY_MIME_TYPE[key]
    : undefined;
  if (fromMime) return fromMime;

  const fileName = input.fileName?.trim() ?? "";
  const extensionMatch = /\.([a-z0-9]{1,8})$/i.exec(fileName);
  const fileNameExtension = extensionMatch ? `.${extensionMatch[1]!.toLowerCase()}` : "";
  if (SAFE_FILE_EXTENSIONS.has(fileNameExtension)) return fileNameExtension;

  return ".bin";
}
