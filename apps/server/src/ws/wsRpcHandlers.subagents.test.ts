import { ThreadId, WS_METHODS } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { ProviderValidationError } from "../provider/Errors.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import type { WsRpcContext } from "./wsRpcContext.ts";
import { makeWsRpcSubagentHandlers } from "./wsRpcHandlers.subagents.ts";

const input = { threadId: ThreadId.makeUnsafe("thread-ws-stop"), nativeTaskId: "task-a" };
const contextWith = (stopSubagent: ProviderServiceShape["stopSubagent"]) =>
  ({ providerService: { stopSubagent } }) as unknown as WsRpcContext;

it.effect("forwards per-subagent Stop to the provider service", () =>
  Effect.gen(function* () {
    const calls: Array<unknown> = [];
    const handlers = makeWsRpcSubagentHandlers(
      contextWith((request) => Effect.sync(() => void calls.push(request))),
    );
    yield* handlers[WS_METHODS.providerStopSubagent](input);
    assert.deepEqual(calls, [input]);
  }),
);

it.effect("maps provider failures to a typed Stop error with the provider's reason", () =>
  Effect.gen(function* () {
    const handlers = makeWsRpcSubagentHandlers(
      contextWith(() =>
        Effect.fail(new ProviderValidationError({ operation: "stop", issue: "Not running." })),
      ),
    );
    const result = yield* Effect.flip(handlers[WS_METHODS.providerStopSubagent](input));
    assert.equal(result._tag, "ProviderStopSubagentError");
    assert.include(result.message, "Not running.");
  }),
);
