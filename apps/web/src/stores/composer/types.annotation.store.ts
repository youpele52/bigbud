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

export const ComposerAnnotationAttachment = Schema.Union([
  ComposerBrowserAnnotationAttachment,
  ComposerCodeAnnotationAttachment,
]);
export type ComposerAnnotationAttachment = typeof ComposerAnnotationAttachment.Type;

export function isCodeAnnotationAttachment(
  annotation: ComposerAnnotationAttachment,
): annotation is ComposerCodeAnnotationAttachment {
  return annotation.kind === "code";
}
