import { ThreadRetentionMutationAuthorization } from "@bigbud/contracts/server/rpc.retention.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { Headers } from "effect/unstable/http";

import {
  isTrustedRetentionMutationOrigin,
  makeRetentionMutationAuthorization,
} from "./wsRetentionMutationAuthorization.ts";

it("accepts only a matching browser origin as unauthenticated user presence", () => {
  assert.isTrue(
    isTrustedRetentionMutationOrigin(
      Headers.fromInput({ host: "127.0.0.1:3020", origin: "http://127.0.0.1:3020" }),
    ),
  );
  assert.isFalse(
    isTrustedRetentionMutationOrigin(
      Headers.fromInput({ host: "127.0.0.1:3020", origin: "https://attacker.example" }),
    ),
  );
  assert.isFalse(isTrustedRetentionMutationOrigin(Headers.fromInput({ host: "127.0.0.1:3020" })));
});

it.effect("rejects a forged retention authorization header", () => {
  const authorization = makeRetentionMutationAuthorization();
  return Effect.gen(function* () {
    const middleware = yield* ThreadRetentionMutationAuthorization;
    const forgedHeaders = authorization.authorizeHeaders(
      Headers.fromInput({ "x-bigbud-retention-mutation-authorization": "forged" }),
      false,
    );
    const exit = yield* Effect.exit(
      middleware(
        Effect.succeed("unreachable") as never,
        {
          headers: forgedHeaders,
        } as never,
      ),
    );
    assert.isTrue(Exit.isFailure(exit));
  }).pipe(Effect.provide(authorization.layer));
});

it.effect("allows the server-injected trusted-origin capability", () => {
  const authorization = makeRetentionMutationAuthorization();
  return Effect.gen(function* () {
    const middleware = yield* ThreadRetentionMutationAuthorization;
    const trustedHeaders = authorization.authorizeHeaders(Headers.empty, true);
    const result = yield* middleware(
      Effect.succeed("allowed") as never,
      {
        headers: trustedHeaders,
      } as never,
    );
    assert.equal(result as unknown, "allowed");
  }).pipe(Effect.provide(authorization.layer));
});
