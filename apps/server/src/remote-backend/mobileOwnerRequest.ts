import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

/**
 * Bounded strict JSON body of an owner-socket request. Query, fragment, non-JSON content type,
 * oversize, slow (5 s) or undecodable bodies all yield `null`; the caller answers 400.
 */
export const readMobileOwnerJson = <A>(maxBytes: number, decode: (value: unknown) => A) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "http://owner.invalid");
    if (
      request.url.includes("?") ||
      request.url.includes("#") ||
      url.search ||
      url.hash ||
      request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json"
    )
      return null;
    return yield* request.text.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, FileSystem.Size(maxBytes)),
      Effect.timeout("5 seconds"),
      Effect.flatMap((text) =>
        Effect.try({
          try: () => {
            if (Buffer.byteLength(text) > maxBytes) throw new Error("Oversized");
            return decode(JSON.parse(text));
          },
          catch: () => null,
        }),
      ),
      Effect.catchCause(() => Effect.succeed(null)),
    );
  });
