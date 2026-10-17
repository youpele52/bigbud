/** Development safety ceiling, not an approved throughput/resource acceptance budget. */
export const V2_DEVELOPMENT_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Safe local classification: only a byte-bound failure permits narrowing a projection page. */
export class V2ResponseSizeError extends Error {
  constructor() {
    super("OpenCode v2 response exceeded the decoding safety bound.");
    this.name = "V2ResponseSizeError";
  }
}

/** The pinned Promise client wraps response-body failures in a transport error's cause. */
export function isV2ResponseSizeError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth++) {
    if (current instanceof V2ResponseSizeError) return true;
    if (!(current instanceof Error)) return false;
    current = current.cause;
  }
  return false;
}

/** Bound bytes before SDK JSON/SSE decoding; blank SSE lines delimit one event frame. */
export function boundV2Response(
  response: Response,
  maxBytes = V2_DEVELOPMENT_RESPONSE_BYTES,
): Response {
  if (!response.body) return response;
  const eventStream = response.headers.get("content-type")?.includes("text/event-stream") ?? false;
  let bytes = 0;
  let lineBytes = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        for (const byte of chunk) {
          bytes++;
          if (bytes > maxBytes) {
            controller.error(new V2ResponseSizeError());
            return;
          }
          if (eventStream && byte === 10) {
            if (lineBytes === 0) bytes = 0;
            lineBytes = 0;
          } else if (byte !== 13) lineBytes++;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
