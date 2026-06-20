export async function copyTextToClipboard(text: string): Promise<void> {
  if (!text) {
    return;
  }

  if (typeof window !== "undefined" && window.desktopBridge?.copyToClipboard) {
    await window.desktopBridge.copyToClipboard(text);
    return;
  }

  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    throw new Error("Clipboard API unavailable.");
  }

  await navigator.clipboard.writeText(text);
}
