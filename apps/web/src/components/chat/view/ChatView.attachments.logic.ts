/** Clipboard/browser Files may have no path. Never substitute a browser fakepath. */
export function desktopAttachmentPath(file: File): string {
  try {
    const path = window.desktopBridge?.getFilePath(file) ?? "";
    return isRealAttachmentPath(path) ? path : "";
  } catch {
    return "";
  }
}

/** Renderer file input fakepaths are not usable filesystem locators. */
export function isRealAttachmentPath(path: string): boolean {
  return /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path) && !/^[a-z]:[\\/]fakepath[\\/]/i.test(path);
}
