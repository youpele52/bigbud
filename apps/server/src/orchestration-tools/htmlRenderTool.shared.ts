export const HTML_RENDER_TOOL_DESCRIPTION =
  "Publish a durable inline visual reply in the current bigbud thread. Supply a title and self-contained HTML fragment with optional CSS and JavaScript. Prefer HTML/CSS. bigbud supplies current theme colors, fonts and 14px defaults; use var(--background), var(--foreground), var(--muted), var(--muted-foreground), var(--border), var(--primary), var(--card), and inherited fonts. Scripts run in an isolated sandbox without host access, forms or popups. External navigation and ordinary external resources are blocked. This is not zero-network isolation: browser APIs such as WebRTC remain available. Use embedded data images only. Never include secrets. This publishes immediately, not a preview.";
export const HTML_RENDER_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["title", "html"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 120 },
    html: { type: "string", minLength: 1, maxLength: 24000 },
  },
} as const;
