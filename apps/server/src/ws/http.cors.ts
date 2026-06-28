import { Effect } from "effect";
import {
  HttpServerRequest,
  HttpServerResponse,
  type HttpServerResponse as HttpServerResponseType,
} from "effect/unstable/http";

interface CorsMiddlewareOptions {
  readonly allowedMethods: readonly string[];
  readonly allowedHeaders: readonly string[];
  readonly maxAge: number;
}

export function makeCorsMiddleware(options: CorsMiddlewareOptions) {
  const responseHeaders = {
    "access-control-allow-origin": "*",
  } as const;
  const preflightHeaders = {
    ...responseHeaders,
    "access-control-allow-headers": options.allowedHeaders.join(","),
    "access-control-allow-methods": options.allowedMethods.join(", "),
    "access-control-allow-private-network": "true",
    "access-control-max-age": String(options.maxAge),
  } as const;

  return <E, R>(httpApp: Effect.Effect<HttpServerResponseType.HttpServerResponse, E, R>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.method === "OPTIONS") {
        return HttpServerResponse.empty({
          headers: preflightHeaders,
          status: 204,
        });
      }
      const response = yield* httpApp;
      return HttpServerResponse.setHeaders(response, responseHeaders);
    });
}
