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
    useSttStore.getState().setSelectedModel("gpt-4o-mini-transcribe");
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
    useSttStore.getState().setSelectedModel("gpt-4o-transcribe");
    expect(useSttStore.getState().selectedModel).toBe("gpt-4o-transcribe");
  });

  it("handles localStorage quota errors gracefully", () => {
    vi.mocked(localStorage.setItem).mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });

    expect(() => useSttStore.getState().setApiKey("sk-test")).not.toThrow();
  });
});

describe("SttModel type", () => {
  it("accepts gpt-4o-mini-transcribe", () => {
    const model: SttModel = "gpt-4o-mini-transcribe";
    expect(model).toBe("gpt-4o-mini-transcribe");
  });

  it("accepts gpt-4o-transcribe", () => {
    const model: SttModel = "gpt-4o-transcribe";
    expect(model).toBe("gpt-4o-transcribe");
  });

  it("rejects invalid model values at compile time", () => {
    // @ts-expect-error — invalid model value should not compile
    const invalid: SttModel = "whisper-1";
    expect(invalid).toBe("whisper-1");
  });
});
