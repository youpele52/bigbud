import type { ThreadId } from "@bigbud/contracts";

import type {
  ComposerAnnotationAttachment,
  PersistedComposerImageAttachment,
  PersistedTerminalContextDraft,
} from "./types.store";

export function normalizePersistedAttachment(
  value: unknown,
): PersistedComposerImageAttachment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const name = candidate.name;
  const mimeType = candidate.mimeType;
  const sizeBytes = candidate.sizeBytes;
  const dataUrl = candidate.dataUrl;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof mimeType !== "string" ||
    typeof sizeBytes !== "number" ||
    !Number.isFinite(sizeBytes) ||
    typeof dataUrl !== "string" ||
    id.length === 0 ||
    dataUrl.length === 0
  ) {
    return null;
  }
  return {
    id,
    name,
    mimeType,
    sizeBytes,
    dataUrl,
  };
}

function normalizeFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizePersistedAnnotation(value: unknown): ComposerAnnotationAttachment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const page = candidate.page;
  const element = candidate.element;
  const viewport = candidate.viewport;
  if (!page || typeof page !== "object") return null;
  if (!element || typeof element !== "object") return null;
  if (!viewport || typeof viewport !== "object") return null;

  const pageCandidate = page as Record<string, unknown>;
  const elementCandidate = element as Record<string, unknown>;
  const viewportCandidate = viewport as Record<string, unknown>;
  const rect = elementCandidate.rect;
  if (!rect || typeof rect !== "object") return null;
  const rectCandidate = rect as Record<string, unknown>;
  const id = candidate.id;
  const imageId = candidate.imageId;
  const comment = candidate.comment;
  const createdAt = candidate.createdAt;
  const url = pageCandidate.url;
  const title = pageCandidate.title;
  const selector = elementCandidate.selector;
  const tag = elementCandidate.tag;
  const role = elementCandidate.role;
  const text = elementCandidate.text;
  const className = elementCandidate.className;
  const rectX = normalizeFiniteNumber(rectCandidate.x);
  const rectY = normalizeFiniteNumber(rectCandidate.y);
  const rectWidth = normalizeFiniteNumber(rectCandidate.width);
  const rectHeight = normalizeFiniteNumber(rectCandidate.height);
  const viewportWidth = normalizeFiniteNumber(viewportCandidate.width);
  const viewportHeight = normalizeFiniteNumber(viewportCandidate.height);
  const devicePixelRatio = normalizeFiniteNumber(viewportCandidate.devicePixelRatio);
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof imageId !== "string" ||
    imageId.length === 0 ||
    typeof comment !== "string" ||
    typeof createdAt !== "string" ||
    createdAt.length === 0 ||
    typeof url !== "string" ||
    typeof title !== "string" ||
    typeof selector !== "string" ||
    typeof tag !== "string" ||
    typeof role !== "string" ||
    typeof text !== "string" ||
    typeof className !== "string" ||
    rectX === null ||
    rectY === null ||
    rectWidth === null ||
    rectHeight === null ||
    viewportWidth === null ||
    viewportHeight === null ||
    devicePixelRatio === null
  ) {
    return null;
  }
  const ariaLabel = elementCandidate.ariaLabel;
  const elementId = elementCandidate.id;
  return {
    id,
    imageId,
    comment,
    page: { url, title },
    element: {
      selector,
      tag,
      role,
      text,
      ariaLabel: typeof ariaLabel === "string" ? ariaLabel : null,
      id: typeof elementId === "string" ? elementId : null,
      className,
      rect: { x: rectX, y: rectY, width: rectWidth, height: rectHeight },
    },
    viewport: {
      width: viewportWidth,
      height: viewportHeight,
      devicePixelRatio,
    },
    createdAt,
  };
}

export function normalizePersistedTerminalContextDraft(
  value: unknown,
): PersistedTerminalContextDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const threadId = candidate.threadId;
  const createdAt = candidate.createdAt;
  const lineStart = candidate.lineStart;
  const lineEnd = candidate.lineEnd;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof threadId !== "string" ||
    threadId.length === 0 ||
    typeof createdAt !== "string" ||
    createdAt.length === 0 ||
    typeof lineStart !== "number" ||
    !Number.isFinite(lineStart) ||
    typeof lineEnd !== "number" ||
    !Number.isFinite(lineEnd)
  ) {
    return null;
  }
  const terminalId = typeof candidate.terminalId === "string" ? candidate.terminalId.trim() : "";
  const terminalLabel =
    typeof candidate.terminalLabel === "string" ? candidate.terminalLabel.trim() : "";
  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const normalizedLineStart = Math.max(1, Math.floor(lineStart));
  const normalizedLineEnd = Math.max(normalizedLineStart, Math.floor(lineEnd));
  return {
    id,
    threadId: threadId as ThreadId,
    createdAt,
    terminalId,
    terminalLabel,
    lineStart: normalizedLineStart,
    lineEnd: normalizedLineEnd,
  };
}
