// A macrotask between parser writes keeps synchronous callbacks from monopolizing JS.
const ready = new Set<() => void>();
// Lanes of the focused terminal: served first in every turn, never exclusively (Orca-style).
const priority = new WeakSet<() => void>();
let scheduled = false;
let channel: MessageChannel | undefined;

function scheduleTurn(run: () => void): void {
  // Nested setTimeouts are clamped to >=4ms in Chromium. Two such turns per
  // 8KiB replay chunk made history restoration fall behind ordinary TUI redraws.
  if (typeof window !== "undefined" && typeof MessageChannel !== "undefined") {
    if (!channel) {
      channel = new MessageChannel();
      channel.port1.start();
    }
    channel.port1.addEventListener("message", run, { once: true });
    channel.port2.postMessage(null);
  } else {
    setTimeout(run, 0);
  }
}

function turnOrder(): Array<() => void> {
  const lanes = Array.from(ready);
  const first = lanes.filter((lane) => priority.has(lane));
  return first.length === 0 ? lanes : [...first, ...lanes.filter((lane) => !priority.has(lane))];
}

export function scheduleTerminalOutput(run: () => void): void {
  ready.add(run);
  if (scheduled) return;
  scheduled = true;
  scheduleTurn(() => {
    scheduled = false;
    const deadline = performance.now() + 4;
    // A synchronous callback may requeue itself. Give each ready lane at most
    // one turn in this macrotask, rather than revisiting additions to the Set.
    for (const next of turnOrder()) {
      if (!ready.delete(next)) continue;
      next();
      if (performance.now() >= deadline) break;
    }
    if (ready.size > 0) scheduleTerminalOutput(ready.values().next().value!);
  });
}

/** Marks a lane as belonging to the focused terminal; priority affects order, not exclusivity. */
export function setTerminalOutputPriority(run: () => void, focused: boolean): void {
  if (focused) priority.add(run);
  else priority.delete(run);
}

export function cancelTerminalOutput(run: () => void): void {
  ready.delete(run);
  priority.delete(run);
}
