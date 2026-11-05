import { V2_NATIVE_BOOTSTRAP_SPECS } from "./Orchestration.plugin.specs.ts";

/** Bootstrap ABI 4: extends, never rewrites, the retained five-tool ABI. */
export const V2_HTML_BOOTSTRAP_SPECS = [
  ...V2_NATIVE_BOOTSTRAP_SPECS,
  {
    name: "bigbud_thread_v1_render_html",
    action: "render_html",
    description:
      "Publish a durable inline visual reply in the current bigbud thread. Supply a title and self-contained HTML with optional inline CSS and JavaScript. Prefer HTML/CSS and inherited fonts. bigbud supplies theme variables and 14px defaults. Scripts are isolated from the host. Remote resources, forms and popups are unavailable; use embedded images. Never include credentials. This publishes immediately, not a preview.",
    input: {
      type: "object",
      additionalProperties: false,
      required: ["title", "html"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 120 },
        html: { type: "string", minLength: 1, maxLength: 24000 },
      },
    },
  },
] as const;
