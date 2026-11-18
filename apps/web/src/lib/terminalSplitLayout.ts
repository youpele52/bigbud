export type TerminalSplitDirection = "right" | "down";
export type TerminalSplitLayout =
  | { terminalId: string }
  | {
      direction: TerminalSplitDirection;
      ratio?: number;
      first: TerminalSplitLayout;
      second: TerminalSplitLayout;
    };

/** Validate persisted trees, prune closed panes, and retain row layouts from older versions. */
export function normalizeTerminalSplitLayout(
  layout: unknown,
  terminalIds: readonly string[],
): TerminalSplitLayout {
  const remaining = new Set(terminalIds);
  function visit(value: unknown, depth: number): TerminalSplitLayout | undefined {
    if (!value || typeof value !== "object" || depth > 8) return;
    if ("terminalId" in value && typeof value.terminalId === "string") {
      if (!remaining.delete(value.terminalId)) return;
      return { terminalId: value.terminalId };
    }
    if (!("direction" in value) || (value.direction !== "right" && value.direction !== "down"))
      return;
    const first = visit("first" in value ? value.first : undefined, depth + 1);
    const second = visit("second" in value ? value.second : undefined, depth + 1);
    if (!first) return second;
    if (!second) return first;
    const ratio =
      "ratio" in value && typeof value.ratio === "number" && value.ratio > 0 && value.ratio < 1
        ? value.ratio
        : undefined;
    return { direction: value.direction, ...(ratio ? { ratio } : {}), first, second };
  }
  let result = visit(layout, 0);
  let count = terminalIds.length - remaining.size;
  for (const terminalId of remaining) {
    const leaf = { terminalId };
    result = result
      ? { direction: "right", ratio: count / (count + 1), first: result, second: leaf }
      : leaf;
    count += 1;
  }
  return result ?? { terminalId: terminalIds[0] ?? "" };
}

export function splitTerminalLayout(
  layout: TerminalSplitLayout,
  sourceId: string,
  terminalId: string,
  direction: TerminalSplitDirection,
): TerminalSplitLayout {
  if ("terminalId" in layout) {
    return layout.terminalId === sourceId
      ? { direction, first: layout, second: { terminalId } }
      : layout;
  }
  return {
    ...layout,
    first: splitTerminalLayout(layout.first, sourceId, terminalId, direction),
    second: splitTerminalLayout(layout.second, sourceId, terminalId, direction),
  };
}

export interface TerminalPaneBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Flat keyed panes keep their renderer mounted when their split-tree ancestry changes. */
export function terminalSplitBounds(layout: TerminalSplitLayout): Map<string, TerminalPaneBounds> {
  const bounds = new Map<string, TerminalPaneBounds>();
  function visit(node: TerminalSplitLayout, rect: TerminalPaneBounds) {
    if ("terminalId" in node) {
      bounds.set(node.terminalId, rect);
      return;
    }
    const axis = node.direction === "right" ? "width" : "height";
    const offset = node.direction === "right" ? "left" : "top";
    const half = { ...rect, [axis]: rect[axis] * (node.ratio ?? 0.5) };
    visit(node.first, half);
    visit(node.second, {
      ...half,
      [axis]: rect[axis] - half[axis],
      [offset]: rect[offset] + half[axis],
    });
  }
  visit(layout, { left: 0, top: 0, width: 100, height: 100 });
  return bounds;
}
