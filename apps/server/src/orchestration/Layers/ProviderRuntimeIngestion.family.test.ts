import { expect, it } from "vitest";
import {
  asEventId,
  asThreadId,
  createHarness,
  registerProviderRuntimeIngestionTestCleanup,
  waitForThread,
} from "./ProviderRuntimeIngestion.test.helpers.ts";

registerProviderRuntimeIngestionTestCleanup();
it("projects card-independent native family Stop authority and clears it without changing root liveness", async () => {
  const harness = await createHarness({ provider: "opencodeV2" });
  for (const retainedFamily of [true, false]) {
    harness.emit({
      provider: "opencodeV2",
      threadId: asThreadId("thread-1"),
      eventId: asEventId(`family-${retainedFamily}`),
      type: "session.state.changed",
      createdAt: new Date().toISOString(),
      payload: { state: "ready", retainedFamily },
    });
    const thread = await waitForThread(
      harness.engine,
      (thread) => thread.session?.retainedFamily === retainedFamily,
    );
    expect(thread.session?.status).toBe("ready");
    expect(thread.session?.activeTurnId).toBeNull();
    expect(thread.tasks ?? []).toHaveLength(0);
  }
});
