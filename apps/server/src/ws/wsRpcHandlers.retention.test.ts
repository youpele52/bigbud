import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { ServerThreadRetentionError } from "@bigbud/contracts/server/threadRetention.ts";
import { assert } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { describe, it, vi } from "vitest";

import type { WsRpcContext } from "./wsRpcContext.ts";
import { makeThreadRetentionWsRpcHandlers } from "./wsRpcHandlers.retention.ts";

describe("thread retention RPC handlers", () => {
  it("forwards preview input and result without changing the payload", async () => {
    const result = { generatedAt: "2026-08-04T00:00:00.000Z" } as never;
    const preview = vi.fn(() => Effect.succeed(result));
    const handlers = makeThreadRetentionWsRpcHandlers({
      threadRetention: { preview },
    } as unknown as WsRpcContext);
    const input = { trigger: "manual", policy: "30-days" } as const;

    assert.strictEqual(
      await Effect.runPromise(handlers[WS_METHODS.serverPreviewThreadRetention](input)),
      result,
    );
    assert.deepEqual(preview.mock.calls, [[input]]);
  });

  it("preserves typed service failures", async () => {
    const failure = new ServerThreadRetentionError({ code: "disabled", message: "disabled" });
    const handlers = makeThreadRetentionWsRpcHandlers({
      threadRetention: { enqueue: () => Effect.fail(failure) },
    } as unknown as WsRpcContext);

    const exit = await Effect.runPromise(
      Effect.exit(handlers[WS_METHODS.serverStartThreadRetention]({ challengeToken: "token" })),
    );
    assert.isTrue(Exit.isFailure(exit));
  });
});
