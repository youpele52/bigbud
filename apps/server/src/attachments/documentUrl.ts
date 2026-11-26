import { extractPromptTextFromBuffer, supportsPromptTextExtraction } from "./documentText.ts";
import { OfficeDocumentLimitError } from "./documentText.office.zip.ts";
import { extractHtmlDocument } from "./documentUrl.html.ts";
import { downloadDocumentUrl, type DocumentDownloadTransport } from "./documentUrl.download.ts";
import { DocumentUrlError, validateDocumentUrl } from "./documentUrl.policy.ts";

export interface DocumentUrlReadResult {
  readonly sourceUrl: string;
  readonly resolvedUrl: string;
  readonly title: string | null;
  readonly text: string;
}

function inferFileName(url: URL): string {
  const lastSegment = url.pathname.split("/").findLast((segment) => segment.length > 0);
  return lastSegment && lastSegment.length > 0 ? lastSegment : "document";
}

function inferResponseFileName(contentDisposition: string, url: URL): string {
  const encodedFileNameMatch = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
  if (encodedFileNameMatch?.[1]) {
    try {
      return decodeURIComponent(encodedFileNameMatch[1]);
    } catch {
      // A malformed optional filename should not hide otherwise readable content.
    }
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

export async function readPromptTextFromUrl(input: {
  readonly url: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly transport?: DocumentDownloadTransport;
}): Promise<DocumentUrlReadResult> {
  const sourceUrl = URL.parse(input.url);
  if (!sourceUrl) throw new DocumentUrlError("Enter a valid HTTP or HTTPS document URL.");
  validateDocumentUrl(sourceUrl);
  const targetUrl = resolveAcademicPdfUrl(sourceUrl) ?? sourceUrl;
  const { url, bytes, contentType, contentDisposition } = await downloadDocumentUrl({
    ...input,
    url: targetUrl,
  });
  const mimeType = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  const extractionTimeout = AbortSignal.timeout(30_000);
  const signal = input.signal
    ? AbortSignal.any([input.signal, extractionTimeout])
    : extractionTimeout;
  try {
    signal.throwIfAborted();
    let title: string | null = null;
    let text: string | null;
    if (mimeType === "text/html") {
      ({ title, text } = await extractHtmlDocument(
        new TextDecoder().decode(bytes),
        url.hostname,
        signal,
      ));
    } else {
      const fileName = inferResponseFileName(contentDisposition ?? "", url);
      if (!supportsPromptTextExtraction({ mimeType, fileName })) {
        throw new DocumentUrlError(
          "This URL did not return a supported document. Try a web page, PDF, Office document, or text file.",
        );
      }
      text = await extractPromptTextFromBuffer({ bytes, mimeType, fileName, signal });
    }
    signal.throwIfAborted();
    if (!text) {
      throw new DocumentUrlError(
        "No readable text was found. Check the document or try a different URL.",
      );
    }
    return { sourceUrl: sourceUrl.href, resolvedUrl: url.href, title, text };
  } catch (error) {
    if (input.signal?.aborted) throw new DocumentUrlError("The document read was cancelled.");
    if (extractionTimeout.aborted) {
      throw new DocumentUrlError(
        "Extracting text took too long. Try a smaller document or attach the relevant pages.",
      );
    }
    if (error instanceof OfficeDocumentLimitError) throw new DocumentUrlError(error.message);
    throw error;
  }
}
