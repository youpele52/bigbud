import { ServerThreadRetentionError } from "@bigbud/contracts/server/threadRetention.ts";
import { ThreadRetentionMutationAuthorization } from "@bigbud/contracts/server/rpc.retention.ts";
import { Effect, Layer, Option } from "effect";
import { Headers } from "effect/unstable/http";

const AUTHORIZATION_HEADER = "x-bigbud-retention-mutation-authorization";

export function isTrustedRetentionMutationOrigin(headers: Headers.Headers): boolean {
  const origin = Option.getOrUndefined(Headers.get(headers, "origin"));
  const host = Option.getOrUndefined(Headers.get(headers, "host"));
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.host.toLowerCase() === host.toLowerCase()
    );
  } catch {
    return false;
  }
}

export function makeRetentionMutationAuthorization() {
  const capability = crypto.randomUUID();
  const authorizeHeaders = (headers: Headers.Headers, trusted: boolean): Headers.Headers => {
    const sanitized = Headers.remove(headers, AUTHORIZATION_HEADER);
    return trusted ? Headers.set(sanitized, AUTHORIZATION_HEADER, capability) : sanitized;
  };
  const layer = Layer.succeed(ThreadRetentionMutationAuthorization, (effect, options) =>
    Option.contains(Headers.get(options.headers, AUTHORIZATION_HEADER), capability)
      ? effect
      : Effect.fail(
          new ServerThreadRetentionError({
            code: "unauthorized",
            message: "Trusted local user presence is required for thread retention changes.",
          }),
        ),
  );
  return { authorizeHeaders, layer };
}
