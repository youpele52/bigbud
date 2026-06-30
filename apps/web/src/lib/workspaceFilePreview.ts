import { stripPathPositionSuffix } from "~/models/editor";
import { resolveWsHttpOrigin } from "~/rpc/wsHttpOrigin";

const WORKSPACE_FILE_PREVIEW_ROUTE = "/api/workspace-file-preview";
const WORKSPACE_PDF_VIEWER_ROUTE = "/api/workspace-pdf-viewer";

function normalizePreviewPath(pathValue: string): string {
  return stripPathPositionSuffix(pathValue).split(/[?#]/, 1)[0] ?? "";
}

const IMAGE_FILE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);

export function isImageFilePath(pathValue: string): boolean {
  const normalized = normalizePreviewPath(pathValue).toLowerCase();
  const extensionStart = normalized.lastIndexOf(".");
  if (extensionStart <= 0) {
    return false;
  }
  return IMAGE_FILE_EXTENSIONS.has(normalized.slice(extensionStart));
}

const HTML_FILE_EXTENSIONS = new Set([".htm", ".html"]);

export function isHtmlFilePath(pathValue: string): boolean {
  const normalized = normalizePreviewPath(pathValue).toLowerCase();
  const extensionStart = normalized.lastIndexOf(".");
  if (extensionStart <= 0) {
    return false;
  }
  return HTML_FILE_EXTENSIONS.has(normalized.slice(extensionStart));
}

export function isPdfFilePath(pathValue: string): boolean {
  return normalizePreviewPath(pathValue).toLowerCase().endsWith(".pdf");
}

const VIDEO_FILE_EXTENSIONS = new Set([".avi", ".mov", ".mp4", ".webm"]);

export function isVideoFilePath(pathValue: string): boolean {
  const normalized = normalizePreviewPath(pathValue).toLowerCase();
  const extensionStart = normalized.lastIndexOf(".");
  if (extensionStart <= 0) {
    return false;
  }
  return VIDEO_FILE_EXTENSIONS.has(normalized.slice(extensionStart));
}

export function isVideoMimeType(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith("video/");
}

export function isPdfPreviewUrl(pathValue: string): boolean {
  try {
    const url = new URL(pathValue);
    return (
      url.pathname.toLowerCase().endsWith(".pdf") ||
      url.searchParams.get("relativePath")?.toLowerCase().endsWith(".pdf") === true
    );
  } catch {
    return isPdfFilePath(pathValue);
  }
}

function shouldUseRawPdfPreview(): boolean {
  return typeof window !== "undefined" && window.desktopBridge !== undefined;
}

export function buildWorkspaceFilePreviewUrl(input: { cwd: string; relativePath: string }): string {
  const origin = resolveWsHttpOrigin();
  const url = new URL(
    isPdfFilePath(input.relativePath) && !shouldUseRawPdfPreview()
      ? WORKSPACE_PDF_VIEWER_ROUTE
      : WORKSPACE_FILE_PREVIEW_ROUTE,
    origin.length > 0 ? origin : "http://localhost",
  );
  url.searchParams.set("cwd", input.cwd);
  url.searchParams.set("relativePath", input.relativePath);
  return origin.length > 0 ? url.href : `${url.pathname}${url.search}`;
}
