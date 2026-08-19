import { afterEach, describe, expect, it, vi } from "vitest";

import { announceMascotAttention, subscribeMascotAttention } from "./mascotAttention.logic";

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  readonly #listeners = new Set<(event: MessageEvent) => void>();

  constructor(readonly name: string) {
    FakeBroadcastChannel.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type === "message") this.#listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type === "message") this.#listeners.delete(listener);
  }

  postMessage(data: unknown) {
    for (const instance of FakeBroadcastChannel.instances) {
      if (instance === this || instance.name !== this.name) continue;
      const event = { data } as MessageEvent;
      for (const listener of instance.#listeners) listener(event);
    }
  }

  close() {
    this.#listeners.clear();
    FakeBroadcastChannel.instances = FakeBroadcastChannel.instances.filter(
      (instance) => instance !== this,
    );
  }
}

describe("mascot attention", () => {
  afterEach(() => {
    FakeBroadcastChannel.instances = [];
    vi.unstubAllGlobals();
  });

  it("delivers attention to other channel subscribers", () => {
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    const listener = vi.fn();
    const unsubscribe = subscribeMascotAttention(listener);

    announceMascotAttention();

    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });
});
