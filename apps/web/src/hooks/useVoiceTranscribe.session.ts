import type { SttModel } from "../stores/stt/stt.store";

export const VOICE_TRANSCRIBE_SAMPLE_RATE = 24_000;
export const REALTIME_TRANSCRIPTION_WEBSOCKET_URL =
  "wss://api.openai.com/v1/realtime?intent=transcription";

export interface RealtimeTranscriptionSessionUpdateEvent {
  type: "session.update";
  session: {
    type: "transcription";
    audio: {
      input: {
        format: {
          type: "audio/pcm";
          rate: number;
        };
        transcription: {
          model: SttModel;
        };
        turn_detection: null;
      };
    };
  };
}

export function buildRealtimeTranscriptionSessionUpdate(
  model: SttModel,
): RealtimeTranscriptionSessionUpdateEvent {
  return {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: {
            type: "audio/pcm",
            rate: VOICE_TRANSCRIBE_SAMPLE_RATE,
          },
          transcription: {
            model,
          },
          turn_detection: null,
        },
      },
    },
  };
}

export function getRealtimeTranscriptionErrorMessage(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;

  const event = message as {
    error?: { message?: unknown };
    type?: unknown;
  };

  if (
    event.type === "conversation.item.input_audio_transcription.failed" &&
    typeof event.error?.message === "string"
  ) {
    return event.error.message;
  }

  if (typeof event.error?.message === "string") {
    return event.error.message;
  }

  return null;
}
