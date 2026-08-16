import type { Rectangle } from "electron";

export const MASCOT_SIZE = 160;
export const COMPACT_CHAT_SIZE = { width: 480, height: 620 } as const;
export const COMPACT_CHAT_MIN_SIZE = { width: 360, height: 440 } as const;

export function clampBounds(bounds: Rectangle, workArea: Rectangle): Rectangle {
  const width = Math.min(Math.max(1, bounds.width), workArea.width);
  const height = Math.min(Math.max(1, bounds.height), workArea.height);
  return {
    width,
    height,
    x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height),
  };
}

export function compactChatBounds(mascot: Rectangle, workArea: Rectangle): Rectangle {
  const width = Math.min(COMPACT_CHAT_SIZE.width, workArea.width);
  const height = Math.min(COMPACT_CHAT_SIZE.height, workArea.height);
  return clampBounds(
    {
      width,
      height,
      x: mascot.x + MASCOT_SIZE - width,
      y: mascot.y + MASCOT_SIZE + 8,
    },
    workArea,
  );
}
