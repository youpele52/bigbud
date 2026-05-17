import { useCallback, useEffect, useRef, useState } from "react";
// Vite resolves `?worker&url` to the bundled worklet script URL at build time.
// @ts-ignore – Vite virtual module; no type declaration needed
import pcm16WorkletUrl from "./pcm16-processor.worklet.ts?worker&url";
import {
  buildRealtimeTranscriptionSessionUpdate,
  getRealtimeTranscriptionErrorMessage,
  REALTIME_TRANSCRIPTION_WEBSOCKET_URL,
  VOICE_TRANSCRIBE_SAMPLE_RATE,
} from "./useVoiceTranscribe.session";
import { useSttStore } from "../stores/stt/stt.store";

export type VoiceTranscribeStatus = "idle" | "requesting" | "recording" | "stopping" | "error";

export interface UseVoiceTranscribeOptions {
  /**
   * Called continuously with the full accumulated transcript text as it streams
   * in. The caller should replace the composer content with this value
   * (prepending any pre-existing prompt prefix is handled by the caller).
   */
  onPartial: (text: string) => void;
  /** Called once when the session ends cleanly with the final transcript. */
  onFinal: (text: string) => void;
}

export interface UseVoiceTranscribeResult {
  status: VoiceTranscribeStatus;
  error: string | null;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
}

/** Convert a raw PCM16 ArrayBuffer to a base64-encoded string. */
function pcm16BufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/**
 * Streams microphone audio to the OpenAI Realtime transcription API via
 * WebSocket. Calls `onPartial` with each incremental transcript delta and
 * `onFinal` when the transcription item is complete.
 *
 * Audio is captured as PCM16 at 24 kHz via an AudioWorkletNode — avoids the
 * deprecated ScriptProcessorNode and works correctly in Electron's sandboxed
 * renderer.
 *
 * Stop flow:
 *   stopRecording() → sends input_audio_buffer.commit → mic/worklet stop
 *   → server replies with conversation.item.input_audio_transcription.completed
 *   → onFinal() fires → WS closes → cleanup runs → status returns to idle.
 */
export function useVoiceTranscribe({
  onPartial,
  onFinal,
}: UseVoiceTranscribeOptions): UseVoiceTranscribeResult {
  const [status, setStatus] = useState<VoiceTranscribeStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const accumulatedRef = useRef<string>("");
  const startRequestIdRef = useRef(0);

  const { apiKey, selectedModel } = useSttStore();

  /** Stop mic capture and close AudioContext. Does NOT close the WebSocket. */
  const stopAudio = useCallback(() => {
    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;
    audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  /** Full teardown — stop audio and close WS. */
  const cleanup = useCallback(() => {
    stopAudio();
    wsRef.current?.close();
    wsRef.current = null;
  }, [stopAudio]);

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  const stopRecording = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Signal end of audio so the server flushes and returns the final transcript.
      ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    }
    // Stop the mic immediately so no more audio is captured, but keep the WS
    // open so the server can still deliver the completed transcript event.
    stopAudio();
    setStatus("stopping");
  }, [stopAudio]);

  const startRecording = useCallback(async () => {
    const requestId = startRequestIdRef.current + 1;
    startRequestIdRef.current = requestId;

    if (!apiKey) {
      setError("No OpenAI API key configured.");
      setStatus("error");
      return;
    }

    setError(null);
    accumulatedRef.current = "";
    setStatus("requesting");

    // --- 1. Request microphone access ---
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch {
      setError("Microphone access denied.");
      setStatus("error");
      return;
    }
    streamRef.current = stream;

    // --- 2. Open WebSocket to OpenAI realtime transcription endpoint ---
    const ws = new WebSocket(REALTIME_TRANSCRIPTION_WEBSOCKET_URL, [
      "realtime",
      `openai-insecure-api-key.${apiKey}`,
    ]);
    wsRef.current = ws;

    ws.addEventListener("open", async () => {
      if (startRequestIdRef.current !== requestId || wsRef.current !== ws) return;

      // Configure the transcription session using the current Realtime session shape.
      ws.send(JSON.stringify(buildRealtimeTranscriptionSessionUpdate(selectedModel)));

      // --- 3. Set up AudioWorklet to capture PCM16 and stream it ---
      try {
        const audioCtx = new AudioContext({ sampleRate: VOICE_TRANSCRIBE_SAMPLE_RATE });
        audioCtxRef.current = audioCtx;

        await audioCtx.audioWorklet.addModule(pcm16WorkletUrl as string);
        if (
          startRequestIdRef.current !== requestId ||
          wsRef.current !== ws ||
          audioCtx.state === "closed"
        ) {
          return;
        }

        const source = audioCtx.createMediaStreamSource(stream);
        const workletNode = new AudioWorkletNode(audioCtx, "pcm16-processor");
        workletNodeRef.current = workletNode;

        workletNode.port.addEventListener("message", (event: MessageEvent<ArrayBuffer>) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const b64 = pcm16BufferToBase64(event.data);
          ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
        });
        workletNode.port.start();

        source.connect(workletNode);
        setStatus("recording");
      } catch (workletError) {
        const msg =
          workletError instanceof Error ? workletError.message : "AudioWorklet failed to load.";
        setError(msg);
        setStatus("error");
        cleanup();
      }
    });

    ws.addEventListener("message", (event) => {
      let msg: { type: string; delta?: string; transcript?: string };
      try {
        msg = JSON.parse(event.data as string) as typeof msg;
      } catch {
        return;
      }

      if (msg.type === "conversation.item.input_audio_transcription.delta" && msg.delta) {
        accumulatedRef.current += msg.delta;
        onPartial(accumulatedRef.current);
      } else if (
        msg.type === "conversation.item.input_audio_transcription.completed" &&
        msg.transcript != null
      ) {
        accumulatedRef.current = msg.transcript;
        onFinal(msg.transcript);
        // Now we have the final text — close the WS cleanly.
        ws.close();
      } else if (
        msg.type === "error" ||
        msg.type === "conversation.item.input_audio_transcription.failed"
      ) {
        setError(getRealtimeTranscriptionErrorMessage(msg) ?? "Transcription error.");
        setStatus("error");
        cleanup();
      }
    });

    ws.addEventListener("error", () => {
      setError("WebSocket connection failed.");
      setStatus("error");
      cleanup();
    });

    ws.addEventListener("close", () => {
      // WS closed (either after completed event or externally) — full cleanup.
      startRequestIdRef.current += 1;
      stopAudio();
      wsRef.current = null;
      setStatus((prev) => (prev === "error" ? "error" : "idle"));
    });
  }, [apiKey, selectedModel, onPartial, onFinal, stopAudio, cleanup]);

  return { status, error, startRecording, stopRecording };
}
