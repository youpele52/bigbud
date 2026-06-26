import * as Schema from "effect/Schema";

export const ComposerAnnotationElement = Schema.Struct({
  selector: Schema.String,
  tag: Schema.String,
  role: Schema.String,
  text: Schema.String,
  ariaLabel: Schema.NullOr(Schema.String),
  id: Schema.NullOr(Schema.String),
  className: Schema.String,
  rect: Schema.Struct({
    x: Schema.Number,
    y: Schema.Number,
    width: Schema.Number,
    height: Schema.Number,
  }),
});
export type ComposerAnnotationElement = typeof ComposerAnnotationElement.Type;

export const ComposerAnnotationViewport = Schema.Struct({
  width: Schema.Number,
  height: Schema.Number,
  devicePixelRatio: Schema.Number,
});
export type ComposerAnnotationViewport = typeof ComposerAnnotationViewport.Type;

export const AnnotationIntentSchema = Schema.Literals(["ask", "context", "fix"]);
export type AnnotationIntent = typeof AnnotationIntentSchema.Type;

export const ComposerAnnotationAttachmentBase = Schema.Struct({
  id: Schema.String,
  comment: Schema.String,
  intent: AnnotationIntentSchema,
  createdAt: Schema.String,
});
export type ComposerAnnotationAttachmentBase = typeof ComposerAnnotationAttachmentBase.Type;

export const ComposerBrowserAnnotationAttachment = Schema.Struct({
  ...ComposerAnnotationAttachmentBase.fields,
  kind: Schema.optionalKey(Schema.Literal("browser")),
  imageId: Schema.String,
  page: Schema.Struct({
    url: Schema.String,
    title: Schema.String,
  }),
  element: ComposerAnnotationElement,
  viewport: ComposerAnnotationViewport,
});
export type ComposerBrowserAnnotationAttachment = typeof ComposerBrowserAnnotationAttachment.Type;

export const ComposerCodeAnnotationAttachment = Schema.Struct({
  ...ComposerAnnotationAttachmentBase.fields,
  kind: Schema.Literal("code"),
  file: Schema.Struct({
    projectName: Schema.optional(Schema.String),
    cwd: Schema.String,
    relativePath: Schema.String,
  }),
  selection: Schema.Struct({
    startLine: Schema.Number,
    endLine: Schema.Number,
    text: Schema.String,
  }),
});
export type ComposerCodeAnnotationAttachment = typeof ComposerCodeAnnotationAttachment.Type;

export const ComposerTerminalAnnotationAttachment = Schema.Struct({
  ...ComposerAnnotationAttachmentBase.fields,
  kind: Schema.Literal("terminal"),
  terminal: Schema.Struct({
    terminalId: Schema.String,
    terminalLabel: Schema.String,
  }),
  selection: Schema.Struct({
    startLine: Schema.Number,
    endLine: Schema.Number,
    text: Schema.String,
  }),
});
export type ComposerTerminalAnnotationAttachment = typeof ComposerTerminalAnnotationAttachment.Type;

export const ComposerAnnotationAttachment = Schema.Union([
  ComposerBrowserAnnotationAttachment,
  ComposerCodeAnnotationAttachment,
  ComposerTerminalAnnotationAttachment,
]);
export type ComposerAnnotationAttachment = typeof ComposerAnnotationAttachment.Type;

function normalizeAnnotationText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeNullableAnnotationText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeAnnotationNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function normalizeAnnotationComment(comment: unknown): string {
  return normalizeAnnotationText(comment);
}

export function normalizeBrowserAnnotationPage(
  page: unknown,
): ComposerBrowserAnnotationAttachment["page"] {
  const candidate = typeof page === "object" && page !== null ? page : {};
  return {
    url: normalizeAnnotationText((candidate as { url?: unknown }).url),
    title: normalizeAnnotationText((candidate as { title?: unknown }).title),
  };
}

export function normalizeBrowserAnnotationElement(element: unknown): ComposerAnnotationElement {
  const candidate = typeof element === "object" && element !== null ? element : {};
  const rectCandidate =
    typeof (candidate as { rect?: unknown }).rect === "object" &&
    (candidate as { rect?: unknown }).rect !== null
      ? (candidate as { rect: Record<string, unknown> }).rect
      : {};

  return {
    selector: normalizeAnnotationText((candidate as { selector?: unknown }).selector),
    tag: normalizeAnnotationText((candidate as { tag?: unknown }).tag) || "unknown",
    role: normalizeAnnotationText((candidate as { role?: unknown }).role),
    text: normalizeAnnotationText((candidate as { text?: unknown }).text),
    ariaLabel: normalizeNullableAnnotationText((candidate as { ariaLabel?: unknown }).ariaLabel),
    id: normalizeNullableAnnotationText((candidate as { id?: unknown }).id),
    className: normalizeAnnotationText((candidate as { className?: unknown }).className),
    rect: {
      x: normalizeAnnotationNumber(rectCandidate.x),
      y: normalizeAnnotationNumber(rectCandidate.y),
      width: normalizeAnnotationNumber(rectCandidate.width),
      height: normalizeAnnotationNumber(rectCandidate.height),
    },
  };
}

export function normalizeBrowserAnnotationViewport(viewport: unknown): ComposerAnnotationViewport {
  const candidate = typeof viewport === "object" && viewport !== null ? viewport : {};
  return {
    width: normalizeAnnotationNumber((candidate as { width?: unknown }).width),
    height: normalizeAnnotationNumber((candidate as { height?: unknown }).height),
    devicePixelRatio: normalizeAnnotationNumber(
      (candidate as { devicePixelRatio?: unknown }).devicePixelRatio,
    ),
  };
}

export function normalizeAnnotationAttachment(
  annotation: ComposerAnnotationAttachment,
): ComposerAnnotationAttachment {
  if (isCodeAnnotationAttachment(annotation) || isTerminalAnnotationAttachment(annotation)) {
    return {
      ...annotation,
      comment: normalizeAnnotationComment(annotation.comment),
    };
  }

  return {
    ...annotation,
    comment: normalizeAnnotationComment(annotation.comment),
    page: normalizeBrowserAnnotationPage(annotation.page),
    element: normalizeBrowserAnnotationElement(annotation.element),
    viewport: normalizeBrowserAnnotationViewport(annotation.viewport),
  };
}

export function isCodeAnnotationAttachment(
  annotation: ComposerAnnotationAttachment,
): annotation is ComposerCodeAnnotationAttachment {
  return annotation.kind === "code";
}

export function isTerminalAnnotationAttachment(
  annotation: ComposerAnnotationAttachment,
): annotation is ComposerTerminalAnnotationAttachment {
  return annotation.kind === "terminal";
}

export function isBrowserAnnotationAttachment(
  annotation: ComposerAnnotationAttachment,
): annotation is ComposerBrowserAnnotationAttachment {
  return !isCodeAnnotationAttachment(annotation) && !isTerminalAnnotationAttachment(annotation);
}
