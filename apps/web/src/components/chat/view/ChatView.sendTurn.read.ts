import type { ServerReadDocumentUrlResult } from "@bigbud/contracts";

function escapeDocumentValue(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function parseReadDocumentCommand(text: string): { readonly url: string } | null {
  const match = /^\/read\s+(\S+)\s*$/i.exec(text.trim());
  if (!match?.[1]) return null;

  try {
    const url = new URL(match[1]);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return { url: url.toString() };
  } catch {
    return null;
  }
}

export function formatReadDocumentPrompt(result: ServerReadDocumentUrlResult): string {
  const lines = [
    "Read this document URL and use the extracted contents below.",
    "",
    "<read_document_result>",
    `Source URL: ${result.sourceUrl}`,
    `Resolved URL: ${result.resolvedUrl}`,
    ...(result.title ? [`Title: ${escapeDocumentValue(result.title)}`] : []),
    "<document_contents>",
    escapeDocumentValue(result.text),
    "</document_contents>",
    "</read_document_result>",
  ];
  return lines.join("\n");
}
