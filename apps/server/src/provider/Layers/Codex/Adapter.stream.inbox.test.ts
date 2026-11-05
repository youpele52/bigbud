import { describe, expect, it, vi } from "vitest";
import { createCodexEventInbox } from "./Adapter.stream.inbox.ts";
import type { ProviderEvent } from "@bigbud/contracts";

const event = (method: string) => ({ method }) as ProviderEvent;

describe("Codex ordered bounded event inbox", () => {
  it("does not let later events overtake a slow consumer", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const consumed: string[] = [];
    const inbox = createCodexEventInbox({
      consume: async (value) => {
        if (value.method === "delta") await gate;
        consumed.push(value.method!);
      },
      overflow: vi.fn(),
    });
    inbox.offer(event("delta"));
    inbox.offer(event("approval"));
    inbox.offer(event("terminal"));
    expect(consumed).toEqual([]);
    release();
    await vi.waitFor(() => expect(consumed).toEqual(["delta", "approval", "terminal"]));
    inbox.close();
  });

  it("stops producers synchronously on overflow and publishes uncertainty after queued controls", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const consumed: string[] = [];
    const overflow = vi.fn(() => async () => {
      consumed.push("uncertain");
    });
    const inbox = createCodexEventInbox({
      maxEvents: 2,
      consume: async (value) => {
        await gate;
        consumed.push(value.method!);
      },
      overflow,
    });
    inbox.offer(event("delta"));
    inbox.offer(event("approval"));
    inbox.offer(event("terminal"));
    inbox.offer(event("later"));
    expect(overflow).toHaveBeenCalledOnce();
    release();
    await vi.waitFor(() => expect(consumed).toEqual(["delta", "approval", "uncertain"]));
  });

  it("enforces bytes as well as event count", () => {
    const overflow = vi.fn();
    const consume = vi.fn();
    const inbox = createCodexEventInbox({ maxBytes: 10, consume, overflow });
    inbox.offer(event("oversized"));
    expect(overflow).toHaveBeenCalledOnce();
    expect(consume).not.toHaveBeenCalled();
  });
});
