import "../../../index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useVoiceTranscribe } from "../../../hooks/useVoiceTranscribe";
import { useSttStore } from "../../../stores/stt/stt.store";

type WsEventType = "open" | "message" | "close" | "error";
type WsEvent = { code?: number; data?: unknown; reason?: string; type?: string };
type WsListener = (event?: WsEvent) => void;

const {
  addModuleSpy,
  closeAudioContextSpy,
  connectSourceSpy,
  getUserMediaSpy,
  sockets,
  stopTrackSpy,
} = vi.hoisted(() => ({
  addModuleSpy: vi.fn(() => Promise.resolve()),
  closeAudioContextSpy: vi.fn(() => Promise.resolve()),
  connectSourceSpy: vi.fn(),
  getUserMediaSpy: vi.fn(),
  sockets: [] as MockWebSocket[],
  stopTrackSpy: vi.fn(),
}));

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  readonly protocols: string[];
  readonly sent: string[] = [];
  readonly url: string;
  private readonly listeners = new Map<WsEventType, Set<WsListener>>();

  constructor(url: string, protocols: string | string[] = []) {
    this.url = url;
    this.protocols = Array.isArray(protocols) ? protocols : [protocols];
    sockets.push(this);
  }

  addEventListener(type: WsEventType, listener: WsListener) {
    const listeners = this.listeners.get(type) ?? new Set<WsListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: WsEventType, listener: WsListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", { code, reason, type: "close" });
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.emit("open", { type: "open" });
  }

  serverMessage(data: unknown) {
    this.emit("message", { data, type: "message" });
  }

  private emit(type: WsEventType, event?: WsEvent) {
    const listeners = this.listeners.get(type);
    if (!listeners) return;
    for (const listener of listeners) {
      listener(event);
    }
  }
}

class MockAudioContext {
  readonly audioWorklet = {
    addModule: addModuleSpy,
  };
  readonly sampleRate: number;
  state = "running";

  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 0;
  }

  close() {
    this.state = "closed";
    return closeAudioContextSpy();
  }

  createMediaStreamSource(_stream: MediaStream) {
    return {
      connect: connectSourceSpy,
    };
  }
}

class MockAudioWorkletNode {
  readonly port = {
    addEventListener: vi.fn(),
    start: vi.fn(),
  };

  disconnect() {}
}

function VoiceTranscribeHarness() {
  const { status, error, startRecording } = useVoiceTranscribe({
    onFinal: vi.fn(),
    onPartial: vi.fn(),
  });

  return (
    <div>
      <button type="button" onClick={() => void startRecording()}>
        Start
      </button>
      <div data-testid="status">{status}</div>
      <div data-testid="error">{error ?? ""}</div>
    </div>
  );
}

function getSocket(): MockWebSocket {
  const socket = sockets.at(-1);
  if (!socket) {
    throw new Error("Expected a websocket instance");
  }
  return socket;
}

const originalAudioContext = globalThis.AudioContext;
const originalAudioWorkletNode = globalThis.AudioWorkletNode;
const originalWebSocket = globalThis.WebSocket;
const originalMediaDevices = navigator.mediaDevices;

describe("useVoiceTranscribe realtime session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sockets.length = 0;
    stopTrackSpy.mockReset();
    getUserMediaSpy.mockResolvedValue({
      getTracks: () => [{ stop: stopTrackSpy }],
    } as unknown as MediaStream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: getUserMediaSpy,
      },
    });
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    globalThis.AudioContext = MockAudioContext as unknown as typeof AudioContext;
    globalThis.AudioWorkletNode = MockAudioWorkletNode as unknown as typeof AudioWorkletNode;
    useSttStore.setState({
      apiKey: "sk-test",
      keyVerified: true,
      selectedModel: "gpt-realtime-whisper",
    });
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    globalThis.AudioContext = originalAudioContext;
    globalThis.AudioWorkletNode = originalAudioWorkletNode;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices,
    });
    useSttStore.setState({
      apiKey: "",
      keyVerified: null,
      selectedModel: "gpt-realtime-whisper",
    });
    document.body.innerHTML = "";
  });

  it("opens the realtime transcription websocket, sends the GA session payload, and surfaces transcription failures", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<VoiceTranscribeHarness />, { container: host });

    try {
      const startButton = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent === "Start",
      );
      if (!(startButton instanceof HTMLButtonElement)) {
        throw new Error("Unable to find the start button.");
      }

      startButton.click();

      await vi.waitFor(() => {
        expect(getUserMediaSpy).toHaveBeenCalledWith({ audio: true, video: false });
        expect(sockets).toHaveLength(1);
      });

      const socket = getSocket();
      expect(socket.url).toBe("wss://api.openai.com/v1/realtime?intent=transcription");
      expect(socket.protocols).toEqual(["realtime", "openai-insecure-api-key.sk-test"]);

      socket.open();

      await vi.waitFor(() => {
        expect(socket.sent).toHaveLength(1);
      });

      expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: {
                type: "audio/pcm",
                rate: 24000,
              },
              transcription: {
                model: "gpt-realtime-whisper",
              },
              turn_detection: null,
            },
          },
        },
      });

      socket.serverMessage(
        JSON.stringify({
          type: "conversation.item.input_audio_transcription.failed",
          error: { message: "Unsupported model." },
        }),
      );

      await vi.waitFor(() => {
        expect(document.querySelector('[data-testid="status"]')?.textContent).toBe("error");
        expect(document.querySelector('[data-testid="error"]')?.textContent).toBe(
          "Unsupported model.",
        );
      });
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
