import { create } from "zustand";

export type SttModel = "gpt-4o-mini-transcribe" | "gpt-4o-transcribe";

export interface SttState {
  apiKey: string;
  /** null = not yet verified, true = verified ok, false = verification failed */
  keyVerified: boolean | null;
  selectedModel: SttModel;
  setApiKey: (key: string) => void;
  setKeyVerified: (verified: boolean | null) => void;
  setSelectedModel: (model: SttModel) => void;
}

const STORAGE_KEY = "bigbud:stt:v1";

function readPersistedSttState(): Pick<SttState, "apiKey" | "keyVerified" | "selectedModel"> {
  if (typeof window === "undefined") {
    return { apiKey: "", keyVerified: null, selectedModel: "gpt-4o-mini-transcribe" };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { apiKey: "", keyVerified: null, selectedModel: "gpt-4o-mini-transcribe" };
    }
    const parsed = JSON.parse(raw) as Partial<
      Pick<SttState, "apiKey" | "keyVerified" | "selectedModel">
    >;
    return {
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      keyVerified: typeof parsed.keyVerified === "boolean" ? parsed.keyVerified : null,
      selectedModel: isValidSttModel(parsed.selectedModel)
        ? parsed.selectedModel
        : "gpt-4o-mini-transcribe",
    };
  } catch {
    return { apiKey: "", keyVerified: null, selectedModel: "gpt-4o-mini-transcribe" };
  }
}

function isValidSttModel(value: unknown): value is SttModel {
  return value === "gpt-4o-mini-transcribe" || value === "gpt-4o-transcribe";
}

function persistSttState(state: Pick<SttState, "apiKey" | "keyVerified" | "selectedModel">): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        apiKey: state.apiKey,
        keyVerified: state.keyVerified,
        selectedModel: state.selectedModel,
      }),
    );
  } catch {
    // Ignore quota/storage errors.
  }
}

export const useSttStore = create<SttState>((set) => ({
  ...readPersistedSttState(),
  setApiKey: (key) =>
    set((state) => {
      const next = { ...state, apiKey: key, keyVerified: null };
      persistSttState(next);
      return next;
    }),
  setKeyVerified: (verified) =>
    set((state) => {
      const next = { ...state, keyVerified: verified };
      persistSttState(next);
      return next;
    }),
  setSelectedModel: (model) =>
    set((state) => {
      const next = { ...state, selectedModel: model };
      persistSttState(next);
      return next;
    }),
}));
