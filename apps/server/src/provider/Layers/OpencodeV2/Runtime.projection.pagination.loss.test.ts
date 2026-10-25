import { expect, it, vi } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { fixtureEvent } from "./Test.fixtures.ts";
import { readV2Messages } from "./Runtime.projection.ts";
import { V2ResponseSizeError } from "./Client.response.ts";

it("text history survives bounded HTTP pagination and dropped oversized events without duplicate execution", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const threadId = ThreadId.makeUnsafe("maximum-media-http");
    const modelSelection = {
      provider: "opencodeV2" as const,
      subProviderID: "synthetic-provider",
      model: "synthetic-model",
    };
    await runtime.start({
      threadId,
      cwd: directory,
      modelSelection,
      runtimeMode: "approval-required",
    });
    const owner = runtime.get(threadId);
    http.autoComplete = false;
    const input = {
      threadId,
      modelSelection,
      requestMessageId: MessageId.makeUnsafe("max-first"),
      input: "Retain this text history " + "A".repeat(110000),
    };
    const first = await runtime.send(input);
    const generation = owner.lease.hub.generation(owner.native.id)!;
    http.source.push(fixtureEvent(owner.native.id, directory, "x".repeat(200000)));
    await expect
      .poll(() => owner.lease.hub.generation(owner.native.id))
      .toBeGreaterThan(generation);
    http.complete(owner.native.id, "authoritative maximum output");
    await expect.poll(() => owner.terminalDelivered).toBe(true);
    await runtime.send({ ...input, requestMessageId: MessageId.makeUnsafe("max-second") });
    http.complete(owner.native.id, "second authoritative output");
    await expect.poll(() => owner.terminalDelivered).toBe(true);
    const read = vi
      .spyOn(http.client.message, "list")
      .mockRejectedValueOnce(new V2ResponseSizeError());
    const messages = await readV2Messages(owner);
    const users = messages.filter((message) => message.type === "user");
    expect(users).toHaveLength(2);
    for (const user of users) expect(user.text).toBe(input.input);
    expect(read.mock.calls.some(([query]) => query.limit === 1 && query.cursor)).toBe(true);
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(2);
    expect(events.some((event) => event.type === "thread.token-usage.updated")).toBe(true);
    expect((await runtime.send(input)).turnId).toBe(first.turnId);
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(2);
  });
});
