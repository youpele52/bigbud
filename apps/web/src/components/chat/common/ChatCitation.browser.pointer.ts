import { cdp } from "vitest/browser";

export function chatPointerCoordinates(x: number, y: number) {
  const frame = window.frameElement?.getBoundingClientRect();
  // Vitest scales its iframe; trusted CDP input uses top-level viewport coordinates.
  const scale = frame ? frame.width / window.innerWidth : 1;
  return { x: x * scale + (frame?.left ?? 0), y: y * scale + (frame?.top ?? 0) };
}

export async function nativeDragChatRange(
  range: Range,
  backward: boolean,
  whileSelecting?: () => Promise<void>,
) {
  const first = range.cloneRange();
  first.collapse(!backward);
  const last = range.cloneRange();
  last.collapse(backward);
  const startRect = first.getBoundingClientRect();
  const endRect = last.getBoundingClientRect();
  const start = chatPointerCoordinates(startRect.left, startRect.top + startRect.height / 2);
  const end = chatPointerCoordinates(endRect.left, endRect.top + endRect.height / 2);
  window.getSelection()?.removeAllRanges();
  const input = cdp();
  await input.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...start });
  await input.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...start,
    button: "left",
    clickCount: 1,
  });
  try {
    for (let step = 1; step <= 12; step++) {
      await input.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: start.x + ((end.x - start.x) * step) / 12,
        y: start.y + ((end.y - start.y) * step) / 12,
        buttons: 1,
        button: "left",
      });
    }
    await whileSelecting?.();
  } finally {
    await input.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...end,
      button: "left",
      clickCount: 1,
    });
  }
}
