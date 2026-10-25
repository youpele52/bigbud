import type { OpenCodeEvent } from "@opencode/client";
import { describe, expect, it, vi } from "vitest";

import { OpencodeV2EventHub } from "./EventHub.ts";
import { V2_MAX_CHILDREN_PER_OWNER, V2ChildIndex } from "./EventHub.children.ts";
import { FixtureEvents, fixtureEvent, flushMicrotasks } from "./Test.fixtures.ts";

const makeHub = (source: FixtureEvents) =>
  new OpencodeV2EventHub({
    maxOwners: 32,
    subscribe: (signal) => source.subscribe(signal),
    maxQueuedEvents: 4,
    maxEventBytes: 4096,
    consumerTimeoutMs: 100,
  });

const created = (sessionID: string, parentID?: string): OpenCodeEvent =>
  ({
    id: `created-${sessionID}`,
    type: "session.created",
    created: 1,
    durable: { aggregateID: sessionID, seq: 0, version: 1 },
    location: { directory: "/one" },
    data: {
      sessionID,
      projectID: "synthetic",
      location: { directory: "/one" },
      slug: sessionID,
      version: "2.0.26",
      ...(parentID ? { parentID } : {}),
    },
  }) as unknown as OpenCodeEvent;

const childStep = (sessionID: string, id = "step"): OpenCodeEvent =>
  ({
    id: `${id}-${sessionID}`,
    type: "session.execution.succeeded",
    created: 2,
    location: { directory: "/one" },
    data: { sessionID },
  }) as unknown as OpenCodeEvent;

function registerParent(hub: OpencodeV2EventHub) {
  const owner = { onEvent: vi.fn(async () => {}), onDirty: vi.fn(), onChildHint: vi.fn() };
  const unregister = hub.register({ nativeSessionId: "ses_one", location: "/one", ...owner });
  return { ...owner, unregister };
}

describe("OpenCode v2 event hub child hints", () => {
  it("hints the owner for a child announced by session.created, never delivering child events", async () => {
    const source = new FixtureEvents();
    const hub = makeHub(source);
    const parent = registerParent(hub);
    hub.start();
    source.push(created("ses_child", "ses_one"));
    source.push(childStep("ses_child"));
    await flushMicrotasks();
    expect(parent.onChildHint).toHaveBeenCalledTimes(2);
    expect(parent.onEvent).not.toHaveBeenCalled();
    expect(parent.onDirty).not.toHaveBeenCalled();
    await hub.close();
  });

  it("keeps dropping unknown IDs and ignores child deltas", async () => {
    const source = new FixtureEvents();
    const hub = makeHub(source);
    const parent = registerParent(hub);
    hub.start();
    source.push(childStep("ses_stranger"));
    source.push(created("ses_orphan"));
    source.push(created("ses_foreign", "ses_unregistered"));
    source.push(childStep("ses_foreign"));
    await flushMicrotasks();
    expect(parent.onChildHint).not.toHaveBeenCalled();
    hub.noteChildren("ses_one", ["ses_known"]);
    source.push(fixtureEvent("ses_known", "/one", "delta"));
    await flushMicrotasks();
    expect(parent.onChildHint).not.toHaveBeenCalled();
    source.push(childStep("ses_known"));
    await flushMicrotasks();
    expect(parent.onChildHint).toHaveBeenCalledTimes(1);
    expect(parent.onEvent).not.toHaveBeenCalled();
    await hub.close();
  });

  it("forgets an owner's children on unregister and ignores reads for unknown owners", async () => {
    const source = new FixtureEvents();
    const hub = makeHub(source);
    const parent = registerParent(hub);
    hub.noteChildren("ses_missing", ["ses_child"]);
    hub.noteChildren("ses_one", ["ses_child"]);
    parent.unregister();
    const next = registerParent(hub);
    hub.start();
    source.push(childStep("ses_child"));
    await flushMicrotasks();
    expect(parent.onChildHint).not.toHaveBeenCalled();
    expect(next.onChildHint).not.toHaveBeenCalled();
    await hub.close();
  });

  it("survives a throwing hint handler", async () => {
    const source = new FixtureEvents();
    const hub = makeHub(source);
    const parent = registerParent(hub);
    parent.onChildHint.mockImplementation(() => {
      throw new Error("boom");
    });
    hub.start();
    source.push(created("ses_child", "ses_one"));
    source.push(fixtureEvent());
    await flushMicrotasks();
    expect(parent.onEvent).toHaveBeenCalledTimes(1);
    await hub.close();
  });
});

describe("V2ChildIndex", () => {
  it("bounds children per owner and never rebinds a child", () => {
    const index = new V2ChildIndex();
    for (let i = 0; i < V2_MAX_CHILDREN_PER_OWNER; i++)
      expect(index.learn("owner", `child-${i}`)).toBe(true);
    expect(index.learn("owner", "overflow")).toBe(false);
    expect(index.ownerOf("overflow")).toBeUndefined();
    expect(index.learn("other", "child-0")).toBe(false);
    expect(index.ownerOf("child-0")).toBe("owner");
    expect(index.learn("owner", "owner")).toBe(false);
    index.forget("owner");
    expect(index.ownerOf("child-0")).toBeUndefined();
  });
});
