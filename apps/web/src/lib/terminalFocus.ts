export function isTerminalFocused(): boolean {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;
  if (!activeElement.isConnected) return false;
  if (activeElement.classList.contains("xterm-helper-textarea")) return true;
  return activeElement.closest(".thread-terminal-drawer .xterm") !== null;
}

export function canTerminalAutoFocus(): boolean {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) {
    return true;
  }
  if (!activeElement.isConnected) {
    return true;
  }
  if (activeElement.classList.contains("xterm-helper-textarea")) {
    return true;
  }
  if (activeElement.closest(".thread-terminal-drawer .xterm") !== null) {
    return true;
  }
  return activeElement === document.body;
}
