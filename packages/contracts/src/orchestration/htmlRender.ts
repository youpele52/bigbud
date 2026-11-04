import { Schema } from "effect";

/** Self-contained visual replies; remote resources and host capabilities are not supported. */
export const HtmlRenderInput = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  html: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(24_000)),
});
export type HtmlRenderInput = typeof HtmlRenderInput.Type;
export const HTML_RENDER_ACTIVITY_KIND = "html.render.published";
