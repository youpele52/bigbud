import { ThreadId, type ModelSelection, type ProviderModelOptions } from "@bigbud/contracts";
import { vi } from "vitest";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import type { ComposerAnnotationAttachment, ComposerImageAttachment } from "./types.store";
import { useComposerDraftStore } from "./composer.store";

export function makeImage(input: {
  id: string;
  previewUrl: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  lastModified?: number;
}): ComposerImageAttachment {
  const name = input.name ?? "image.png";
  const mimeType = input.mimeType ?? "image/png";
  const sizeBytes = input.sizeBytes ?? 4;
  const lastModified = input.lastModified ?? 1_700_000_000_000;
  const file = new File([new Uint8Array(sizeBytes).fill(1)], name, {
    type: mimeType,
    lastModified,
  });
  return {
    type: "image",
    id: input.id,
    name,
    mimeType,
    sizeBytes: file.size,
    previewUrl: input.previewUrl,
    file,
  };
}

export function makeTerminalContext(input: {
  id: string;
  text?: string;
  terminalId?: string;
  terminalLabel?: string;
  lineStart?: number;
  lineEnd?: number;
}): TerminalContextDraft {
  return {
    id: input.id,
    threadId: ThreadId.makeUnsafe("thread-dedupe"),
    terminalId: input.terminalId ?? "default",
    terminalLabel: input.terminalLabel ?? "Terminal 1",
    lineStart: input.lineStart ?? 4,
    lineEnd: input.lineEnd ?? 5,
    text: input.text ?? "git status\nOn branch main",
    createdAt: "2026-03-13T12:00:00.000Z",
  };
}

export function makeAnnotation(input: {
  id: string;
  imageId: string;
  comment?: string;
  intent?: "ask" | "context" | "fix" | "comment";
}): ComposerAnnotationAttachment {
  return {
    id: input.id,
    imageId: input.imageId,
    comment: input.comment ?? "Fix this",
    intent: input.intent ?? "fix",
    page: { title: "Dashboard", url: "https://example.com/dashboard" },
    element: {
      selector: "#save",
      tag: "button",
      role: "button",
      text: "Save",
      ariaLabel: null,
      id: "save",
      className: "primary",
      rect: { x: 1, y: 2, width: 3, height: 4 },
    },
    viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
    createdAt: "2026-05-02T00:00:00.000Z",
  };
}

export function makeCodeAnnotation(input: {
  id: string;
  comment?: string;
  intent?: "ask" | "context" | "fix" | "comment";
}): ComposerAnnotationAttachment {
  return {
    id: input.id,
    kind: "code",
    comment: input.comment ?? "Change this line",
    intent: input.intent ?? "fix",
    createdAt: "2026-06-02T00:00:00.000Z",
    file: {
      projectName: "Project",
      cwd: "/tmp/project",
      relativePath: "src/main.ts",
    },
    selection: {
      startLine: 12,
      endLine: 14,
      text: "const value = 1;",
    },
  };
}

export function makeTerminalAnnotation(input: {
  id: string;
  comment?: string;
  intent?: "ask" | "context" | "fix" | "comment";
  terminalId?: string;
  terminalLabel?: string;
  lineStart?: number;
  lineEnd?: number;
  text?: string;
}): ComposerAnnotationAttachment {
  return {
    id: input.id,
    kind: "terminal",
    comment: input.comment ?? "Explain this output",
    intent: input.intent ?? "ask",
    createdAt: "2026-06-23T00:00:00.000Z",
    terminal: {
      terminalId: input.terminalId ?? "terminal-1",
      terminalLabel: input.terminalLabel ?? "Terminal 1",
    },
    selection: {
      startLine: input.lineStart ?? 4,
      endLine: input.lineEnd ?? 5,
      text: input.text ?? "error: build failed\nexit code 1",
    },
  };
}

export function resetComposerDraftStore() {
  useComposerDraftStore.setState({
    draftsByThreadId: {},
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

export function modelSelection(
  provider: "codex" | "claudeAgent",
  model: string,
  options?: ModelSelection["options"],
): ModelSelection {
  return {
    provider,
    model,
    ...(options ? { options } : {}),
  } as ModelSelection;
}

export function opencodeModelSelection(
  model: string,
  input?: {
    options?: Extract<ModelSelection, { provider: "opencode" }>["options"];
    subProviderID?: string;
  },
): ModelSelection {
  return {
    provider: "opencode",
    model,
    ...(input?.options ? { options: input.options } : {}),
    ...(input?.subProviderID ? { subProviderID: input.subProviderID } : {}),
  } as ModelSelection;
}

export function providerModelOptions(options: ProviderModelOptions): ProviderModelOptions {
  return options;
}

export function createMockStorage() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((name: string) => store.get(name) ?? null),
    setItem: vi.fn((name: string, value: string) => {
      store.set(name, value);
    }),
    removeItem: vi.fn((name: string) => {
      store.delete(name);
    }),
  };
}
