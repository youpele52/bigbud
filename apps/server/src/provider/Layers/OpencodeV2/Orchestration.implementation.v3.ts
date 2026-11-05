import { V2_THREAD_HANDLER_V1 } from "./Orchestration.implementation.v1.ts";
import type { V2PureThreadHandler } from "./Orchestration.implementation.types.v3.ts";

/** ABI-4 interpretation is frozen separately from retained implementation generations. */
export const V2_THREAD_HANDLER_V3: V2PureThreadHandler = Object.freeze<V2PureThreadHandler>({
  prepare(value) {
    if (value.action !== "render_html")
      return V2_THREAD_HANDLER_V1.prepare({ ...value, action: value.action });
    const { title, html } = value.input;
    if (
      Object.keys(value.input).some((key) => key !== "title" && key !== "html") ||
      typeof title !== "string" ||
      title.length < 1 ||
      title.length > 120 ||
      typeof html !== "string" ||
      html.length < 1 ||
      html.length > 24000
    )
      throw new Error("V2 HTML arguments rejected.");
    return { action: "render_html", htmlArguments: { title, html } };
  },
  interpret({ canonicalResult }) {
    return canonicalResult;
  },
});
