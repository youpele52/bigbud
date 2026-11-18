export const HTML_RENDER_TOOL_DESCRIPTION =
  "Publish a durable inline visual reply in the current bigbud thread. Supply a title and self-contained HTML fragment with optional CSS and JavaScript. Prefer HTML/CSS. bigbud supplies fonts and 14px defaults; inherit fonts. For colours, either use bigbud's theme variables, which follow light and dark mode (var(--background), var(--foreground), var(--card), var(--muted), var(--muted-foreground), var(--border), var(--primary), var(--chart-1) to var(--chart-5)), or choose any palette and set background, text colour and color-scheme together on your outer container. Never mix your own text colours with bigbud's background or invent variable names with fallback colours. Scripts run in an isolated sandbox without host access, forms or popups. The visual itself never navigates and ordinary external resources are blocked; ordinary <a href> links to http or https URLs open in the user's browser when clicked. This is not zero-network isolation: browser APIs such as WebRTC remain available. Use embedded data images only. Never include secrets. Never use render_html to ask the user a question or collect input; use your native question tool, which bigbud renders with clickable options and a free-text field with attachments. This publishes immediately, not a preview.";
export const HTML_RENDER_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["title", "html"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 120 },
    html: { type: "string", minLength: 1, maxLength: 24000 },
  },
} as const;
