import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { titleFixture } from "./ProviderCommandReactorSessionOps.title.fixture.ts";
import { maybeGenerateThreadTitleForFirstTurn } from "./ProviderCommandReactorSessionOps.title.ts";

// Paid attempt bounds are exercised through the real composition in
// ThreadMetadataGeneration.production.test.ts, not through the removed staged router.
describe("durable title request routing", () => {
  it("queues immutable inputs without invoking the legacy auxiliary router or rename tool", async () => {
    const f = titleFixture();
    const title = vi.fn(() => Effect.void);
    const services = {
      ...f.services,
      metadataGeneration: { title, summary: () => Effect.void, start: () => Effect.void },
    };
    await Effect.runPromise(
      maybeGenerateThreadTitleForFirstTurn(services)({
        ...f.input(),
        titleSeed: "Investigate reconnect",
        retryKey: "explicit-retry-1",
      }),
    );
    expect(title).toHaveBeenCalledExactlyOnceWith({
      threadId: f.thread.id,
      messageText: "Investigate session reconnect",
      titleSeed: "Investigate reconnect",
      retryKey: "explicit-retry-1",
    });
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("fails closed when durable admission is absent instead of running old stages", async () => {
    const f = titleFixture();
    await Effect.runPromise(f.run());
    f.addSuccess(1);
    f.addSuccess(2);
    f.addSuccess(3);
    await Effect.runPromise(f.run(true));
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.thread.title).toBe("New thread");
  });
});
