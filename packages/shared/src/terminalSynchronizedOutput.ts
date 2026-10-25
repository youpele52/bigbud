// DEC 2026 synchronized-output framing shared by terminal delivery (server) and view writers (web).
export const BEGIN_SYNCHRONIZED_UPDATE = "\x1b[?2026h";
export const END_SYNCHRONIZED_UPDATE = "\x1b[?2026l";

/**
 * Index of the begin marker of a frame still open at the end of `data`, or -1.
 *
 * xterm suppresses rendering while a frame is open and only paints when the end marker is parsed
 * or its 1000 ms safety timeout fires. Holding an open tail until the end marker arrives keeps a
 * slow lane from stranding the parser inside a frame.
 */
export function openSynchronizedFrameStart(data: string): number {
  const begin = data.lastIndexOf(BEGIN_SYNCHRONIZED_UPDATE);
  if (begin === -1) return -1;
  return data.indexOf(END_SYNCHRONIZED_UPDATE, begin) === -1 ? begin : -1;
}

function avoidSurrogateSplit(data: string, index: number): number {
  const previous = data.charCodeAt(index - 1);
  return index < data.length && previous >= 0xd800 && previous <= 0xdbff ? index - 1 : index;
}

/**
 * Length of the first chunk when splitting `data` near `limit` without cutting a synchronized
 * frame. Splits before a frame left open at `limit`; keeps a leading frame whole up to `hardLimit`;
 * otherwise splits at `limit` (an oversized frame cannot be kept whole within bounds).
 */
export function synchronizedOutputSafeSplit(
  data: string,
  limit: number,
  hardLimit = limit,
): number {
  if (data.length <= limit) return data.length;
  const straddling = data.lastIndexOf(BEGIN_SYNCHRONIZED_UPDATE, limit - 1);
  // A begin marker cut by the limit opens a frame just like one inside it.
  const openFrame =
    straddling !== -1 && straddling + BEGIN_SYNCHRONIZED_UPDATE.length > limit
      ? straddling
      : openSynchronizedFrameStart(data.slice(0, limit));
  if (openFrame === -1) return avoidSurrogateSplit(data, limit);
  // Everything before an open frame (including earlier complete frames) is safe to send now.
  if (openFrame > 0) return openFrame;
  const frameEnd = data.indexOf(END_SYNCHRONIZED_UPDATE, limit);
  if (frameEnd !== -1 && frameEnd + END_SYNCHRONIZED_UPDATE.length <= hardLimit)
    return frameEnd + END_SYNCHRONIZED_UPDATE.length;
  return avoidSurrogateSplit(data, limit);
}
