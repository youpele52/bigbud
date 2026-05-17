import "../../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useSttStore } from "../../../stores/stt/stt.store";

const { mockHookStateRef, startRecordingSpy, stopRecordingSpy, toastAddSpy } = vi.hoisted(() => ({
  mockHookStateRef: {
    current: {
      status: "error" as const,
      error: "Microphone access denied.",
      startRecording: vi.fn(() => Promise.resolve()),
      stopRecording: vi.fn(),
    },
  },
  startRecordingSpy: vi.fn(() => Promise.resolve()),
  stopRecordingSpy: vi.fn(),
  toastAddSpy: vi.fn(),
}));

mockHookStateRef.current.startRecording = startRecordingSpy;
mockHookStateRef.current.stopRecording = stopRecordingSpy;

vi.mock("../../../hooks/useVoiceTranscribe", () => ({
  useVoiceTranscribe: vi.fn(() => mockHookStateRef.current),
}));

vi.mock("../../ui/toast", () => ({
  toastManager: {
    add: toastAddSpy,
  },
}));

import { ComposerMicButton } from "./ComposerMicButton";

describe("ComposerMicButton STT errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSttStore.setState({
      apiKey: "sk-test",
      keyVerified: true,
      selectedModel: "gpt-realtime-whisper",
    });
    mockHookStateRef.current = {
      status: "error",
      error: "Microphone access denied.",
      startRecording: startRecordingSpy,
      stopRecording: stopRecordingSpy,
    };
  });

  afterEach(() => {
    useSttStore.setState({
      apiKey: "",
      keyVerified: null,
      selectedModel: "gpt-realtime-whisper",
    });
    document.body.innerHTML = "";
  });

  it("shows a toast when voice transcription fails and does not duplicate the same error", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <ComposerMicButton prompt="" onTranscript={vi.fn()} onRecordingChange={vi.fn()} />,
      { container: host },
    );

    try {
      await vi.waitFor(() => {
        expect(toastAddSpy).toHaveBeenCalledWith({
          type: "error",
          title: "Voice input failed",
          description: "Microphone access denied.",
        });
      });

      expect(toastAddSpy).toHaveBeenCalledTimes(1);

      await screen.rerender(
        <ComposerMicButton prompt="" onTranscript={vi.fn()} onRecordingChange={vi.fn()} />,
      );

      await vi.waitFor(() => {
        expect(toastAddSpy).toHaveBeenCalledTimes(1);
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
