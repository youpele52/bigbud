import { expect } from "vitest";

export interface TextPoint {
  readonly node: Text;
  readonly offset: number;
}

export function previewTextPoint(root: Element, text: string, occurrence = 0): TextPoint {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const offset = node.textContent?.indexOf(text) ?? -1;
    if (offset !== -1 && occurrence-- === 0) return { node: node as Text, offset };
  }
  throw new Error(`Missing rendered text: ${text}`);
}

export function selectPreviewText(start: TextPoint, end: TextPoint, backward = false): Selection {
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.setBaseAndExtent(
    backward ? end.node : start.node,
    backward ? end.offset : start.offset,
    backward ? start.node : end.node,
    backward ? start.offset : end.offset,
  );
  expect(selection.isCollapsed).toBe(false);
  return selection;
}

export function afterPreviewText(point: TextPoint, text: string): TextPoint {
  return { ...point, offset: point.offset + text.length };
}
