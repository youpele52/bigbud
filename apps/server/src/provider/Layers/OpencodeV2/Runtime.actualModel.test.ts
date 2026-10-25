import { expect, it } from "vitest";
import { ThreadId, MessageId } from "@bigbud/contracts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";

it("binds canonical completion evidence to the correlated native assistant's actual model", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory, events }) => {
    http.autoComplete = false;
    const threadId = ThreadId.makeUnsafe("actual-model-fixture");
    await runtime.start({
      threadId,
      cwd: directory,
      runtimeMode: "approval-required",
      modelSelection: {
        provider: "opencodeV2",
        model: "synthetic-model",
        subProviderID: "synthetic-provider",
      },
    });
    const sent = await runtime.send({
      threadId,
      requestMessageId: MessageId.makeUnsafe("request-A"),
      input: "Fixture only",
    });
    const session = runtime.get(threadId);
    http.complete(session.native.id);
    http.messages.set(
      session.native.id,
      http.messages
        .get(session.native.id)!
        .map((message) =>
          message.type === "assistant"
            ? { ...message, model: { id: "actual-model-B", providerID: "actual-account-B" } }
            : message,
        ),
    );
    await runtime.reconcile(session);
    expect(
      events.find((event) => event.type === "turn.completed" && event.turnId === sent.turnId),
    ).toMatchObject({
      payload: {
        actualModelSelection: {
          provider: "opencodeV2",
          model: "actual-model-B",
          subProviderID: "actual-account-B",
        },
      },
    });
  });
});
