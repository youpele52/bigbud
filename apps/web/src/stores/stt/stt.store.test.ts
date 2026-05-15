import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useSttStore, type SttModel } from "./stt.store";

describe("sttStore", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    vi.mocked(localStorage.getItem).mockReturnValue(null);
    vi.mocked(localStorage.setItem).mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useSttStore.getState().setApiKey("");
    useSttStore.getState().setKeyVerified(null);
    useSttStore.getState().setSelectedModel("gpt-realtime-whisper");
  });

  it("setApiKey updates the key and resets keyVerified to null", () => {
    useSttStore.getState().setApiKey("sk-initial");
    useSttStore.getState().setKeyVerified(true);
    expect(useSttStore.getState().keyVerified).toBe(true);

    useSttStore.getState().setApiKey("sk-new");
    expect(useSttStore.getState().apiKey).toBe("sk-new");
    expect(useSttStore.getState().keyVerified).toBe(null);
  });

  it("setKeyVerified updates verification status", () => {
    useSttStore.getState().setKeyVerified(true);
    expect(useSttStore.getState().keyVerified).toBe(true);

    useSttStore.getState().setKeyVerified(false);
    expect(useSttStore.getState().keyVerified).toBe(false);

    useSttStore.getState().setKeyVerified(null);
    expect(useSttStore.getState().keyVerified).toBe(null);
  });

  it("setSelectedModel updates the model", () => {
    useSttStore.getState().setSelectedModel("gpt-realtime-whisper");
    expect(useSttStore.getState().selectedModel).toBe("gpt-realtime-whisper");
  });

  it("handles localStorage quota errors gracefully", () => {
    vi.mocked(localStorage.setItem).mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });

    expect(() => useSttStore.getState().setApiKey("sk-test")).not.toThrow();
  });
});

describe("SttModel type", () => {
  it("accepts gpt-realtime-whisper", () => {
    const model: SttModel = "gpt-realtime-whisper";
    expect(model).toBe("gpt-realtime-whisper");
  });

  it("rejects invalid model values at compile time", () => {
    // @ts-expect-error — invalid model value should not compile
    const invalid: SttModel = "gpt-4o-transcribe";
    expect(invalid).toBe("gpt-4o-transcribe");
  });
});
