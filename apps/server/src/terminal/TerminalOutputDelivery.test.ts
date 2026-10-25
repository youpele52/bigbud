import { describe, expect, it, vi } from "vitest";
import type { TerminalEvent } from "@bigbud/contracts";
import {
  BEGIN_SYNCHRONIZED_UPDATE as BSU,
  END_SYNCHRONIZED_UPDATE as ESU,
} from "@bigbud/shared/terminalSynchronizedOutput";
import { TERMINAL_OUTPUT_DELIVERY_LIMITS, TerminalOutputDelivery } from "./TerminalOutputDelivery";

const base = { threadId: "thread", terminalId: "term", createdAt: "2026-10-21T00:00:00.000Z" };
const output = (data: string): TerminalEvent => ({ ...base, type: "output", data });
const limits = {
  ...TERMINAL_OUTPUT_DELIVERY_LIMITS,
  creditWindow: 10,
  chunk: 4,
  frameHardLimit: 32,
  holdHighWater: 20,
  holdLowWater: 10,
  overflow: 40,
};

function fixture() {
  const emitted: TerminalEvent[] = [];
  const setHeld = vi.fn();
  const overflow = vi.fn();
  const delivery = new TerminalOutputDelivery(
    { emit: (event) => emitted.push(event), setHeld, overflow },
    limits,
  );
  const data = () =>
    emitted.map((event) => (event.type === "output" ? event.data : `<${event.type}>`)).join("");
  return { delivery, emitted, data, setHeld, overflow };
}

describe("TerminalOutputDelivery", () => {
  it("waits for start, then sends at most the credit window", () => {
    const { delivery, data } = fixture();
    delivery.push(output("abcdefghijklmnop"));
    expect(data()).toBe("");
    delivery.start();
    expect(data()).toBe("abcdefghij");
    expect(delivery.diagnostics).toMatchObject({ sentChars: 10, pendingChars: 6 });
    delivery.acknowledge(4);
    expect(data()).toBe("abcdefghijklmn");
    // An acknowledgement beyond what was sent is clamped, never trusted as extra credit.
    delivery.acknowledge(1_000);
    expect(data()).toBe("abcdefghijklmnop");
    expect(delivery.diagnostics.acknowledgedChars).toBe(14);
  });

  it("keeps event order and never credits non-output events", () => {
    const { delivery, data } = fixture();
    delivery.start();
    delivery.push(output("0123456789"));
    delivery.push({ ...base, type: "cleared" });
    delivery.push({ ...base, type: "activity", hasRunningSubprocess: true });
    delivery.push(output("x"));
    expect(data()).toBe("0123456789<cleared>");
    delivery.acknowledge(10);
    expect(data()).toBe("0123456789<cleared>x");
  });

  it("splits before an open synchronized frame and keeps a frame whole up to the hard limit", () => {
    const { delivery, emitted } = fixture();
    const frame = `${BSU}x${ESU}`;
    delivery.start();
    delivery.acknowledge(0);
    delivery.push(output(`ab${frame}`));
    const chunks = emitted.map((event) => (event.type === "output" ? event.data : ""));
    expect(chunks[0]).toBe("ab");
    expect(chunks[1]).toBe(frame);
  });

  it("holds the producer past high water, releases below low water, and re-holds on restart", () => {
    const { delivery, setHeld } = fixture();
    delivery.start();
    delivery.push(output("x".repeat(31)));
    expect(setHeld).toHaveBeenLastCalledWith(true);
    delivery.push({ ...base, type: "restarted", snapshot: {} as never });
    expect(setHeld).toHaveBeenCalledTimes(2);
    for (let acked = 10; acked <= 30; acked += 10) delivery.acknowledge(acked);
    expect(setHeld).toHaveBeenLastCalledWith(false);
  });

  it("ends the subscription instead of buffering without bound", () => {
    const { delivery, overflow, setHeld } = fixture();
    delivery.start();
    delivery.push(output("y".repeat(60)));
    expect(overflow).toHaveBeenCalledOnce();
    expect(setHeld).toHaveBeenLastCalledWith(false);
    expect(delivery.diagnostics.pendingChars).toBe(0);
  });
});
