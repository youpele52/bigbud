interface MoveBeforeParent {
  moveBefore?: (node: Node, child: Node | null) => void;
}

/**
 * Moves a view's host element without rebuilding xterm. `moveBefore` (Chromium 133+, so every
 * supported Electron) keeps focus, selection and the WebGL canvas; `appendChild` keeps the buffer
 * and the WebGL context but blurs, so focus is restored by hand when the target can take it.
 */
export function moveTerminalViewHost(target: Element, host: HTMLElement): void {
  if (host.parentElement === target) return;
  const active = typeof document === "undefined" ? null : document.activeElement;
  const focused = active instanceof HTMLElement && host.contains(active) ? active : null;
  const moveBefore = (target as unknown as MoveBeforeParent).moveBefore;
  if (typeof moveBefore === "function" && target.isConnected && host.isConnected) {
    try {
      moveBefore.call(target, host, null);
      return;
    } catch {
      // Cross-document or disconnected edge cases: fall back to a plain insert.
    }
  }
  target.appendChild(host);
  if (focused && !isTerminalViewSlotInert(target)) focused.focus({ preventScroll: true });
}

/** A borrower inside an inert subtree (W0's hidden gate) must never show or focus a view. */
export function isTerminalViewSlotInert(slot: Element): boolean {
  return slot.closest("[inert]") !== null;
}

/**
 * On screen means connected, outside inert or hidden subtrees and rendered. `checkVisibility`
 * covers `display: none` ancestors and `visibility: hidden`; it is absent only in old engines.
 */
export function isTerminalViewSlotOnScreen(slot: Element): boolean {
  if (!slot.isConnected || isTerminalViewSlotInert(slot)) return false;
  if (slot.closest("[hidden]") !== null) return false;
  const check = (slot as Element & { checkVisibility?: (options?: object) => boolean })
    .checkVisibility;
  return typeof check === "function"
    ? check.call(slot, { checkVisibilityCSS: true, visibilityProperty: true })
    : true;
}

export function createTerminalViewHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.className = "h-full w-full";
  host.dataset.terminalViewHost = "";
  return host;
}

/** Freeze a released host at its last on-screen size so xterm never measures a zero box. */
export function freezeTerminalViewHostSize(host: HTMLElement): void {
  const { width, height } = host.getBoundingClientRect();
  if (width >= 1 && height >= 1) {
    host.style.width = `${Math.round(width)}px`;
    host.style.height = `${Math.round(height)}px`;
  }
}

export function releaseTerminalViewHostSize(host: HTMLElement): void {
  host.style.removeProperty("width");
  host.style.removeProperty("height");
}
