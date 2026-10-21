import { expect, it, vi } from "vitest";
import { OpencodeV2EventHub } from "./EventHub.ts";
import { FixtureEvents, fixtureEvent, flushMicrotasks } from "./Test.fixtures.ts";

it("enrolled nested children refresh through the single root queue even after observed history filled its separate hint bound", async () => {
  const source = new FixtureEvents();
  const hub = new OpencodeV2EventHub({
    maxOwners: 2,
    subscribe: (signal) => source.subscribe(signal),
    maxQueuedEvents: 4,
    maxEventBytes: 4096,
    consumerTimeoutMs: 100,
  });
  const onChildHint = vi.fn(),
    onEvent = vi.fn(async () => {});
  const unregister = hub.register({
    nativeSessionId: "ses_root",
    location: "/one",
    onEvent,
    onChildHint,
    onDirty: () => {},
  });
  hub.noteChildren(
    "ses_root",
    Array.from({ length: 32 }, (_, index) => `ses_old_${index}`),
  );
  hub.noteOwnedChildren("ses_root", ["ses_nested"]);
  hub.start();
  source.push(fixtureEvent("ses_nested", "/one", "owned-delta"));
  await flushMicrotasks();
  expect(onChildHint).toHaveBeenCalledOnce();
  expect(onEvent).not.toHaveBeenCalled();
  hub.noteOwnedChildren("ses_root", ["ses_new_live"]);
  source.push(fixtureEvent("ses_nested", "/one", "retired-delta"));
  source.push(fixtureEvent("ses_new_live", "/one", "new-delta"));
  await flushMicrotasks();
  expect(onChildHint).toHaveBeenCalledTimes(2);
  expect(() =>
    hub.noteOwnedChildren(
      "ses_root",
      Array.from({ length: 33 }, (_, index) => `ses_over_${index}`),
    ),
  ).toThrow("capacity");
  unregister();
  source.push(fixtureEvent("ses_new_live", "/one", "stale-delta"));
  await flushMicrotasks();
  expect(onChildHint).toHaveBeenCalledTimes(2);
  await hub.close();
});
