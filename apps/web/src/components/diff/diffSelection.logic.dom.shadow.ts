/**
 * Chromium retargets a mouse drag-selection inside an open shadow root to nodes
 * outside that root, so `Selection.getRangeAt()` exposes a collapsed boundary at
 * the host's ancestor while `Selection.toString()` still returns the text. These
 * helpers recover the selected diff rows from the shadow root that owns them.
 */

function asElement(node: EventTarget | Node | null): HTMLElement | null {
  if (typeof node !== "object" || node === null) return null;
  if (!("hasAttribute" in node) || typeof node.hasAttribute !== "function") return null;
  return node as HTMLElement;
}

/** Finds the Pierre diff shadow root that produced the event from a composed path. */
export function resolveDiffShadowRootFromPath(path: readonly EventTarget[]): ShadowRoot | null {
  for (const node of path) {
    const element = asElement(node as Node);
    if (!element) continue;

    if (element.shadowRoot) return element.shadowRoot;

    // A path that stops at the file container still exposes its diff host.
    if (element.dataset.diffFilePath?.trim() && typeof element.querySelector === "function") {
      const host = element.querySelector("diffs-container");
      if (host?.shadowRoot) return host.shadowRoot;
    }
  }

  return null;
}

/**
 * Resolves the rows a retargeted selection covers inside a diff shadow root.
 * `containsNode` keeps working on shadow-internal nodes even when the public
 * Range boundaries were retargeted outside the root.
 */
export function resolveShadowSelectionLines(
  selection: Selection,
  shadowRoot: ShadowRoot,
): HTMLElement[] {
  const lines = shadowRoot.querySelectorAll<HTMLElement>("[data-content] [data-line]");
  return Array.from(lines).filter((line) => selectionContainsNode(selection, line));
}

function selectionContainsNode(selection: Selection, line: HTMLElement): boolean {
  try {
    return selection.containsNode(line, true);
  } catch {
    return false;
  }
}
