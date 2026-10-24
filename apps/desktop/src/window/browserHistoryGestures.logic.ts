export interface HistorySwipeSample {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly time: number;
  readonly blocked: boolean;
}

/** Recognizes one deliberate horizontal gesture; momentum cannot rearm it. */
export function createHistorySwipeRecognizer() {
  let active = false;
  let started = 0;
  let last = 0;
  let direction = 0;
  let horizontal = 0;
  let vertical = 0;
  let reversal = 0;
  let samples = 0;
  let rejection: string | null = null;
  return {
    begin() {
      active = true;
      started = last = 0;
      direction = horizontal = vertical = reversal = samples = 0;
      rejection = null;
    },
    cancel() {
      active = false;
      rejection = "cancelled";
    },
    isActive() {
      return active;
    },
    snapshot() {
      return {
        active,
        started,
        last,
        direction,
        horizontal,
        vertical,
        reversal,
        samples,
        rejection,
      };
    },
    push(sample: HistorySwipeSample) {
      if (!active) return;
      const { deltaX, deltaY, time, blocked } = sample;
      if (blocked || ![deltaX, deltaY, time].every(Number.isFinite)) {
        rejection = blocked ? "blocked-surface" : "non-finite-sample";
        active = false;
        return;
      }
      if (deltaX === 0 && deltaY === 0) return;
      if (!samples) started = time;
      if ((samples > 0 && time - last > 160) || time < last || time - started > 900) {
        rejection = "sample-timing";
        active = false;
        return;
      }
      last = time;
      samples += 1;
      vertical += Math.abs(deltaY);
      if (!direction && Math.abs(deltaX) >= 1) direction = Math.sign(deltaX);
      if (direction && deltaX * direction < 0) reversal += Math.abs(deltaX);
      horizontal += deltaX * direction;
      if (reversal >= 24 || (vertical >= 16 && vertical * 2.5 > Math.abs(horizontal))) {
        rejection = reversal >= 24 ? "reversal" : "vertical-movement";
        active = false;
      }
    },
    end(time: number): "back" | "forward" | null {
      const recognized =
        active &&
        samples >= 3 &&
        horizontal >= 160 &&
        horizontal >= vertical * 3 &&
        time - started <= 900 &&
        time - last <= 160;
      active = false;
      return recognized ? (direction < 0 ? "back" : "forward") : null;
    },
  };
}
