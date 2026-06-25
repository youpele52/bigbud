export async function copyTextToClipboard(text: string): Promise<void> {
  if (!text) {
    return;
  }

  if (typeof window !== "undefined" && window.desktopBridge?.copyToClipboard) {
    await window.desktopBridge.copyToClipboard(text);
    return;
  }

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to execCommand fallback on permission denial or other errors.
    }
  }

  // Fallback for contexts where the Clipboard API is blocked (e.g. insecure
  // origins, denied permissions, or certain Electron builds).
  if (typeof document === "undefined") {
    throw new Error("Clipboard API unavailable.");
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "absolute";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);

  const selection = document.getSelection();
  const previouslySelected = selection?.rangeCount ? selection.getRangeAt(0) : null;

  textarea.select();
  textarea.setSelectionRange(0, text.length);

  const success = document.execCommand("copy");

  document.body.removeChild(textarea);

  if (previouslySelected && selection) {
    selection.removeAllRanges();
    selection.addRange(previouslySelected);
  }

  if (!success) {
    throw new Error("Clipboard API unavailable.");
  }
}
