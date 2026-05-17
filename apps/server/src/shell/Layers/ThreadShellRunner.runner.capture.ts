import { MAX_RETURNED_OUTPUT_BYTES, trimOutputTailToBytes } from "./ThreadShellRunner.capture";
import {
  type ActiveCommandCapture,
  type ActiveReadyCapture,
} from "./ThreadShellRunner.runner.types";

export function consumeReadyCapture(capture: ActiveReadyCapture, visibleText: string): void {
  capture.buffer += visibleText;
  if (!capture.buffer.includes(capture.marker)) {
    const maxRetained = Math.max(capture.marker.length * 2, 256);
    if (capture.buffer.length > maxRetained) {
      capture.buffer = capture.buffer.slice(-maxRetained);
    }
    return;
  }
  capture.resolve();
}

export function emitCommandOutput(capture: ActiveCommandCapture, flushEndExclusive: number): void {
  if (flushEndExclusive <= 0) {
    return;
  }

  const chunk = capture.buffer.slice(0, flushEndExclusive);
  capture.buffer = capture.buffer.slice(flushEndExclusive);
  if (chunk.length === 0) {
    return;
  }

  capture.output = trimOutputTailToBytes(`${capture.output}${chunk}`, MAX_RETURNED_OUTPUT_BYTES);
  if (capture.onOutputChunk) {
    capture.onOutputChunk(chunk);
  }
}
