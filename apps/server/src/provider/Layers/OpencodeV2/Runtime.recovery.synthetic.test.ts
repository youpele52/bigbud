import { expect, it } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";

it("explains intervening synthetic input without claiming its idle/output or releasing the accepted admission", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    const threadId = ThreadId.makeUnsafe("synthetic-correlation");
    const modelSelection = {
      provider: "opencodeV2" as const,
      subProviderID: "synthetic-provider",
      model: "synthetic-model",
    };
    http.autoComplete = false;
    await runtime.start({
      threadId,
      modelSelection,
      cwd: directory,
      runtimeMode: "approval-required",
    });
    const input = {
      threadId,
      modelSelection,
      requestMessageId: MessageId.makeUnsafe("accepted"),
      input: "first",
    };
    await runtime.send(input);
    const session = runtime.get(threadId);
    http.messages.get(session.native.id)!.push({
      id: "synthetic-native",
      type: "synthetic",
      time: { created: 3 },
      text: "private synthetic content",
    });
    http.complete(session.native.id);
    await runtime.reconcile(session);
    expect(session.session.lastError).toContain("Native synthetic input intervened");
    expect(session.session.lastError).not.toContain("private synthetic content");
    expect(session.row?.state).toBe("accepted");
    expect(events.some((event) => event.type === "turn.completed")).toBe(false);
    await expect(
      runtime.send({ ...input, requestMessageId: MessageId.makeUnsafe("blocked") }),
    ).rejects.toThrow();
    expect(http.calls.filter((call) => call.pathname.endsWith("/prompt"))).toHaveLength(1);
  });
});
