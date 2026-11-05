/** Accepts only durable web icons, never executable, local-file, or credential-bearing URLs. */
export function normalizeBrowserFaviconUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password)
      return null;
    return url.href;
  } catch {
    return null;
  }
}
