import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest, type RequestOptions as SecureRequestOptions } from "node:https";
import { isIP } from "node:net";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import {
  DocumentUrlError,
  documentHostname,
  resolveDocumentAddresses,
  resolvePublicDocumentAddresses,
  validateDocumentUrl,
  withDocumentAbort,
} from "./documentUrl.policy.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_DOCUMENT_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_ADDRESS_ATTEMPTS = 4;
const FALLBACK_ATTEMPT_MS = 2500;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface DocumentResponse {
  readonly status: number;
  readonly header: (name: string) => string | undefined;
  readonly body: AsyncIterable<Uint8Array>;
  readonly dispose: () => void;
}

export interface DocumentDownloadTransport {
  readonly resolve: typeof resolveDocumentAddresses;
  readonly open: (options: SecureRequestOptions) => Promise<DocumentResponse>;
}

const transport: DocumentDownloadTransport = {
  resolve: resolveDocumentAddresses,
  open: (options) =>
    new Promise((resolve, reject) => {
      const request = (options.protocol === "https:" ? httpsRequest : httpRequest)(
        options,
        (response) => {
          resolve({
            status: response.statusCode ?? 0,
            header: (name) => {
              const value = response.headers[name];
              return typeof value === "string" ? value : undefined;
            },
            body: response,
            dispose: () => response.destroy(),
          });
        },
      );
      request.once("error", reject);
      request.end();
    }),
};

function documentRequestOptions(url: URL, address: string, signal: AbortSignal) {
  const hostname = documentHostname(url);
  const options: RequestOptions = {
    protocol: url.protocol,
    // Connect directly to the vetted address, with no second lookup or pooled connection.
    hostname: address,
    port: url.port,
    path: url.pathname + url.search,
    headers: { host: url.host, "accept-encoding": "identity" },
    agent: false,
    signal,
  };
  const secureOptions: SecureRequestOptions = {
    ...options,
    // Preserve the original host for SNI and certificate verification, not the pinned address.
    ...(url.protocol === "https:"
      ? { servername: isIP(hostname) ? "" : hostname, rejectUnauthorized: true }
      : {}),
  };
  return secureOptions;
}

function tooLarge() {
  return new DocumentUrlError(
    "This document exceeds the 10 MB download limit. Try a smaller document.",
  );
}

async function* boundedBody(body: AsyncIterable<Uint8Array>) {
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > MAX_DOCUMENT_DOWNLOAD_BYTES) throw tooLarge();
    yield chunk;
  }
}

async function collectBody(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of boundedBody(body)) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  return Buffer.concat(chunks, size);
}

async function readBody(response: DocumentResponse, signal: AbortSignal): Promise<Buffer> {
  if (Number(response.header("content-length")) > MAX_DOCUMENT_DOWNLOAD_BYTES) throw tooLarge();
  const encoding = response.header("content-encoding")?.trim().toLowerCase();
  if (!encoding || encoding === "identity") return collectBody(response.body);
  const decoder =
    encoding === "gzip"
      ? createGunzip()
      : encoding === "deflate"
        ? createInflate()
        : encoding === "br"
          ? createBrotliDecompress()
          : null;
  if (!decoder) {
    throw new DocumentUrlError(
      "The site used an unsupported content encoding. Try a direct download URL or attach the file locally.",
    );
  }
  return pipeline(boundedBody(response.body), decoder, collectBody, { signal });
}

async function openDocumentResponse(
  url: URL,
  addresses: readonly string[],
  signal: AbortSignal,
  open: DocumentDownloadTransport["open"],
): Promise<DocumentResponse> {
  const candidates = addresses.slice(0, MAX_ADDRESS_ATTEMPTS);
  for (const [index, address] of candidates.entries()) {
    const hasFallback = index + 1 < candidates.length;
    const attempt = new AbortController();
    const timer = hasFallback ? setTimeout(() => attempt.abort(), FALLBACK_ATTEMPT_MS) : undefined;
    const attemptSignal = hasFallback ? AbortSignal.any([signal, attempt.signal]) : signal;
    try {
      return await withDocumentAbort(attemptSignal, async () => {
        const response = await open(documentRequestOptions(url, address, attemptSignal));
        if (attemptSignal.aborted) {
          response.dispose();
          attemptSignal.throwIfAborted();
        }
        return response;
      });
    } catch (error) {
      signal.throwIfAborted();
      if (!hasFallback) throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new DocumentUrlError("No public document address was available.");
}

export async function downloadDocumentUrl(input: {
  readonly url: URL;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly transport?: DocumentDownloadTransport;
}) {
  const { resolve, open } = input.transport ?? transport;
  const timeout = AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  try {
    let url = input.url;
    for (let redirects = 0; ; redirects++) {
      validateDocumentUrl(url);
      const addresses = await resolvePublicDocumentAddresses(url, signal, resolve);
      const response = await openDocumentResponse(url, addresses, signal, open);
      try {
        signal.throwIfAborted();
        if (REDIRECT_STATUSES.has(response.status)) {
          if (redirects >= MAX_REDIRECTS) {
            throw new DocumentUrlError("Too many redirects. Try the direct document URL.");
          }
          const location = response.header("location");
          const nextUrl = location && URL.parse(location, url.href);
          if (!nextUrl)
            throw new DocumentUrlError(
              "The site returned an invalid redirect. Try the direct URL.",
            );
          validateDocumentUrl(nextUrl);
          if (url.protocol === "https:" && nextUrl.protocol === "http:") {
            throw new DocumentUrlError(
              "The site redirected to an insecure URL. Try a direct HTTPS URL.",
            );
          }
          url = nextUrl;
          continue;
        }
        if (response.status < 200 || response.status >= 300) {
          throw new DocumentUrlError(
            `The site returned HTTP ${response.status}. Check that the document is publicly accessible.`,
          );
        }
        const bytes = await withDocumentAbort(signal, () => readBody(response, signal));
        return {
          url,
          bytes,
          contentType: response.header("content-type"),
          contentDisposition: response.header("content-disposition"),
        };
      } finally {
        response.dispose();
      }
    }
  } catch (error) {
    if (timeout.aborted)
      throw new DocumentUrlError(
        "The document download timed out. Try again or attach the file locally.",
      );
    if (input.signal?.aborted) throw new DocumentUrlError("The document download was cancelled.");
    if (error instanceof DocumentUrlError) throw error;
    throw new DocumentUrlError(
      "Could not download the document. Check that the site is reachable and try again.",
    );
  }
}
