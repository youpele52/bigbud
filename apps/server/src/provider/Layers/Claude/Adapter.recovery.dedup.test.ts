import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import { claimNativeMessageId } from "./Adapter.session.runtime.ts";
import { FakeClaudeQuery } from "./Adapter.test.helpers.ts";

describe("Claude query epoch message deduplication", () => {
  it("claims UUID/type/subtype once within a live query, not across new sessions", () => {
    const seen = new Set<string>();
    const message = {
      type: "system",
      subtype: "status",
      uuid: "native-message-1",
    } as unknown as SDKMessage;
    assert.equal(claimNativeMessageId(seen, message), true);
    assert.equal(claimNativeMessageId(seen, message), false);
    assert.equal(
      claimNativeMessageId(seen, { ...message, subtype: "task_started" } as SDKMessage),
      true,
    );
    assert.equal(claimNativeMessageId(new Set(), message), true);
    assert.equal(claimNativeMessageId(seen, { type: "system" } as SDKMessage), true);
  });

  it("does not pretend a re-handshake can reopen an exhausted iterator", async () => {
    const query = new FakeClaudeQuery();
    query.setInitializationResponse({} as never);
    query.finish();
    const failed = await query.reinitialize().then(
      () => false,
      () => true,
    );
    assert.equal(failed, true);
    const next = await query[Symbol.asyncIterator]().next();
    assert.equal(next.done, true);
  });
});
