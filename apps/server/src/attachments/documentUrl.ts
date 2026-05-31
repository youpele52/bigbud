import { extractPromptTextFromBuffer, supportsPromptTextExtraction } from "./documentText.ts";
import { truncateExtractedText } from "./documentText.shared.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface DocumentUrlReadResult {
  readonly sourceUrl: string;
  readonly resolvedUrl: string;
  readonly title: string | null;
  readonly text: string;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function inferFileName(url: URL): string {
  const lastSegment = url.pathname.split("/").findLast((segment) => segment.length > 0);
  return lastSegment && lastSegment.length > 0 ? lastSegment : "document";
}

function inferResponseFileName(response: Response, url: URL): string {
  const contentDisposition = response.headers.get("content-disposition") ?? "";
  const encodedFileNameMatch = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
  if (encodedFileNameMatch?.[1]) {
    return decodeURIComponent(encodedFileNameMatch[1]);
  }

  const fileNameMatch = /filename="?([^";]+)"?/i.exec(contentDisposition);
  if (fileNameMatch?.[1]) {
    return fileNameMatch[1];
  }

  return inferFileName(url);
}

function resolveAcademicPdfUrl(url: URL): URL | null {
  if (url.hostname === "arxiv.org" || url.hostname === "www.arxiv.org") {
    const match = url.pathname.match(/^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?$/);
    if (!match?.[1]) return null;
    return new URL(`https://arxiv.org/pdf/${match[1]}.pdf`);
  }

  if (url.hostname === "eprint.iacr.org") {
    const match = url.pathname.match(/^\/(\d{4})\/(\d+)(?:\.pdf)?$/);
    if (!match?.[1] || !match[2]) return null;
    return new URL(`https://eprint.iacr.org/${match[1]}/${match[2]}.pdf`);
  }

  return null;
}

function extractHtmlDocument(input: {
  readonly html: string;
  readonly fallbackTitle: string | null;
}) {
  const withoutScripts = input.html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ");
  const title =
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(withoutScripts)?.[1]?.trim() ?? input.fallbackTitle;
  const body = withoutScripts
    .replace(/<\/(p|div|section|article|li|tr|h\d)>/gi, "\n")
    .replace(/<br\b[^>]*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = normalizeText(decodeHtmlEntities(body));

  return {
    title: title ? decodeHtmlEntities(title) : null,
    text,
  };
}

function createRequestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export async function readPromptTextFromUrl(input: {
  readonly url: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly fetchImpl?: FetchLike;
}): Promise<DocumentUrlReadResult | null> {
  const sourceUrl = new URL(input.url);
  const targetUrl = resolveAcademicPdfUrl(sourceUrl) ?? sourceUrl;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const response = await (input.fetchImpl ?? fetch)(targetUrl, {
    signal: createRequestSignal(input.signal, timeoutMs),
  });
  if (!response.ok) {
    return null;
  }

  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";

  if (mimeType.startsWith("text/html")) {
    const html = await response.text();
    const rendered = extractHtmlDocument({ html, fallbackTitle: sourceUrl.hostname });
    if (rendered.text.length === 0) return null;
    return {
      sourceUrl: sourceUrl.toString(),
      resolvedUrl: targetUrl.toString(),
      title: rendered.title,
      text: truncateExtractedText(rendered.text),
    };
  }

  const responseFileName = inferResponseFileName(response, targetUrl);

  if (!supportsPromptTextExtraction({ mimeType, fileName: responseFileName })) {
    return null;
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
    return null;
  }

  const text = await extractPromptTextFromBuffer({
    bytes,
    mimeType,
    fileName: responseFileName,
  });
  if (!text) return null;

  return {
    sourceUrl: sourceUrl.toString(),
    resolvedUrl: targetUrl.toString(),
    title: null,
    text,
  };
}
