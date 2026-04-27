/**
 * AudioWorklet processor that converts Float32 audio samples to PCM16
 * and posts them to the main thread as ArrayBuffer messages.
 *
 * Loaded via Vite `?worker&url` — runs inside the AudioWorklet global scope,
 * not the normal browser context. Must not import anything from the app.
 */

// AudioWorklet globals are not in standard lib.dom.d.ts — declare them here
// so this file type-checks cleanly when excluded from the main tsconfig.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class Pcm16Processor extends AudioWorkletProcessor {
  override process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    const pcm = new Int16Array(channel.length);
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]!));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    // Transfer the underlying ArrayBuffer to avoid a copy on the main thread.
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    return true;
  }
}

registerProcessor("pcm16-processor", Pcm16Processor);
