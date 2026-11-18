/** Owns a delayed focus return without retaining a target from a retired menu. */
export function createMobileHostFocusReturn(input: {
  requestFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
  canRestore: () => boolean;
  restore: () => void;
}) {
  let generation = 0;
  let frame: number | null = null;
  function cancel() {
    generation += 1;
    if (frame !== null) input.cancelFrame(frame);
    frame = null;
  }
  return {
    cancel,
    schedule() {
      cancel();
      const owner = generation;
      frame = input.requestFrame(() => {
        // Cancellation may happen after the browser has already dequeued a frame.
        if (owner !== generation) return;
        frame = null;
        if (input.canRestore()) input.restore();
      });
    },
  };
}
