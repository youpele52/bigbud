import { describe, expect, it } from "vitest";
import {
  buildRealtimeTranscriptionSessionUpdate,
  getRealtimeTranscriptionErrorMessage,
  REALTIME_TRANSCRIPTION_WEBSOCKET_URL,
  VOICE_TRANSCRIBE_SAMPLE_RATE,
} from "./useVoiceTranscribe.session";

describe("useVoiceTranscribe.session", () => {
  it("uses a transcription-intent realtime websocket endpoint", () => {
    expect(REALTIME_TRANSCRIPTION_WEBSOCKET_URL).toBe(
      "wss://api.openai.com/v1/realtime?intent=transcription",
    );
  });

  it("builds a GA realtime transcription session update payload", () => {
    expect(buildRealtimeTranscriptionSessionUpdate("gpt-realtime-whisper")).toEqual({
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
              model: "gpt-realtime-whisper",
            },
            turn_detection: null,
          },
        },
      },
    });
  });

  it("extracts a transcription failure message from realtime events", () => {
    expect(
      getRealtimeTranscriptionErrorMessage({
        type: "conversation.item.input_audio_transcription.failed",
        error: { message: "Unsupported model." },
      }),
    ).toBe("Unsupported model.");
  });
});
