import type { TerminalEvent, TerminalSessionSnapshot } from "@bigbud/contracts";
import type { TerminalScreenItem } from "@bigbud/contracts/workspace/terminal.stream.ts";
import { describe, expect, it } from "vitest";

import {
  TERMINAL_SCREEN_SPLICE_BUFFER_CHARS,
  TerminalScreenSplice,
  terminalScreenItem,
  type TerminalScreenSource,
} from "./Manager.hostScreen.ts";
import { TerminalHostOutputLedger, tagTerminalHostOutput } from "./Manager.hostScreen.ledger.ts";

const createdAt = "2026-11-21T00:00:00.000Z";

/** Simulates the manager: queue text with its sequence, then publish it tagged. */
function host() {
  const ledger = new TerminalHostOutputLedger();
  let sequence = 0;
  return {
    ledger,
    arrive(data: string) {
      sequence += 1;
      ledger.noteData(data);
      ledger.noteSequence(sequence);
      return sequence;
    },
    publish(data: string): TerminalEvent {
      const event = { type: "output" as const, threadId: "t", terminalId: "a", data, createdAt };
      tagTerminalHostOutput(event, ledger.notePublished(data.length));
      return event;
    },
  };
}

const screen = (throughSequence: number, generation = "g1"): TerminalScreenItem => ({
  type: "screen",
  threadId: "t",
  terminalId: "a",
  runtimeGeneration: generation,
  throughSequence: String(throughSequence),
  cols: 80,
  rows: 24,
  ansi: "S",
  pendingEscapeTail: "",
  scrollbackRows: 0,
  alternateScreen: false,
  fidelity: "full",
  cold: false,
});

function collect(source: () => TerminalScreenSource, acceptScreen = true, waitForStart = true) {
  const items: Array<TerminalScreenItem | TerminalEvent> = [];
  let overflowed = false;
  const splice = new TerminalScreenSplice(
    source,
    {
      screen: (item) => items.push(item),
      event: (event) => items.push(event),
      overflow: () => {
        overflowed = true;
      },
    },
    { acceptScreen, waitForStart },
  );
  const texts = () =>
    items.map((item) =>
      item.type === "screen"
        ? `[screen ${item.throughSequence}]`
        : item.type === "output"
          ? item.data
          : item.type,
    );
  return { splice, items, texts, overflowed: () => overflowed };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("host output ledger", () => {
  it("maps sequences to char offsets and back", () => {
    const h = host();
    h.arrive("ab");
    h.arrive("");
    h.arrive("cde");
    expect(h.ledger.charsThrough(1)).toBe(2);
    expect(h.ledger.charsThrough(2)).toBe(2);
    expect(h.ledger.charsThrough(3)).toBe(5);
    expect(h.ledger.charsThrough(4)).toBeUndefined();
    expect(h.ledger.sequenceAtChars(4)).toBe(2);
    expect(h.ledger.sequenceAtChars(5)).toBe(3);
  });
});

describe("terminal screen splice", () => {
  it("sends the screen first and drops output at or below its sequence (duplicates)", async () => {
    const h = host();
    const { promise: fetched, resolve } = Promise.withResolvers<TerminalScreenItem>();
    const c = collect(() => ({ kind: "host", ledger: h.ledger, fetch: () => fetched }));
    h.arrive("one");
    const covered = h.publish("one");
    c.splice.start();
    c.splice.push(covered);
    const through = h.arrive("two-");
    c.splice.push(h.publish("two-"));
    h.arrive("three");
    c.splice.push(h.publish("three"));
    resolve(screen(through));
    await settle();
    expect(c.texts()).toEqual([`[screen ${through}]`, "three"]);
    // A replayed duplicate at or below the cut never reaches the view.
    c.splice.push(covered);
    expect(c.texts()).toEqual([`[screen ${through}]`, "three"]);
  });

  it("cuts inside a coalesced chunk that spans the snapshot's sequence", async () => {
    const h = host();
    const c = collect(() => ({
      kind: "host",
      ledger: h.ledger,
      fetch: async () => screen(through),
    }));
    h.arrive("abc");
    const through = h.arrive("def");
    h.arrive("ghi");
    c.splice.start();
    c.splice.push(h.publish("abcdefghi"));
    await settle();
    expect(c.texts()).toEqual([`[screen ${through}]`, "ghi"]);
  });

  it("drops output until a snapshot sequence that has not arrived yet passes", async () => {
    const h = host();
    const c = collect(() => ({ kind: "host", ledger: h.ledger, fetch: async () => screen(3) }));
    c.splice.start();
    await settle();
    h.arrive("x");
    c.splice.push(h.publish("x"));
    h.arrive("y");
    h.arrive("z");
    c.splice.push(h.publish("yz"));
    h.arrive("after");
    c.splice.push(h.publish("after"));
    expect(c.texts()).toEqual(["[screen 3]", "after"]);
  });

  it("does not cut a new process generation's output", async () => {
    const h = host();
    const c = collect(() => ({ kind: "host", ledger: h.ledger, fetch: async () => screen(9) }));
    c.splice.start();
    await settle();
    const restarted = {
      type: "restarted",
      threadId: "t",
      terminalId: "a",
      createdAt,
      snapshot: { runtimeGeneration: "g2" } as TerminalSessionSnapshot,
    } as TerminalEvent;
    c.splice.push(restarted);
    c.splice.push({ type: "output", threadId: "t", terminalId: "a", data: "fresh", createdAt });
    expect(c.texts()).toEqual(["[screen 9]", "restarted", "fresh"]);
  });

  it("streams live at once without acceptScreen or without a host screen", () => {
    const h = host();
    const plain = collect(
      () => ({ kind: "host", ledger: h.ledger, fetch: async () => screen(1) }),
      false,
    );
    plain.splice.start();
    plain.splice.push(h.publish("a"));
    expect(plain.texts()).toEqual(["a"]);
    const none = collect(() => ({ kind: "none" }));
    none.splice.start();
    none.splice.push({ type: "output", threadId: "t", terminalId: "a", data: "b", createdAt });
    expect(none.texts()).toEqual(["b"]);
  });

  it("waits for a pending session's start, then fetches its screen first", async () => {
    const h = host();
    let source: TerminalScreenSource = { kind: "pending" };
    const c = collect(() => source);
    c.splice.start();
    h.arrive("boot");
    c.splice.push(h.publish("boot"));
    source = { kind: "host", ledger: h.ledger, fetch: async () => screen(1) };
    c.splice.push({
      type: "activity",
      threadId: "t",
      terminalId: "a",
      createdAt,
      hasRunningSubprocess: false,
    });
    await settle();
    expect(c.texts()).toEqual(["[screen 1]", "activity"]);
  });

  it("stops waiting when the session settles without a host screen", () => {
    const c = collect(() => ({ kind: "pending" }));
    c.splice.start();
    c.splice.push({ type: "output", threadId: "t", terminalId: "a", data: "x", createdAt });
    expect(c.texts()).toEqual([]);
    c.splice.push({
      type: "error",
      threadId: "t",
      terminalId: "a",
      createdAt,
      message: "no",
      runtimeGeneration: "g",
    } as TerminalEvent);
    expect(c.texts()).toEqual(["x", "error"]);
  });

  it("falls back to live output when the screen cannot be fetched", async () => {
    const h = host();
    const c = collect(() => ({
      kind: "host",
      ledger: h.ledger,
      fetch: async () => Promise.reject(new Error("SCREEN_UNAVAILABLE")),
    }));
    c.splice.start();
    h.arrive("x");
    c.splice.push(h.publish("x"));
    await settle();
    expect(c.texts()).toEqual(["x"]);
  });

  it("ends a subscriber whose buffered output passes its bound while the screen loads", () => {
    const h = host();
    const c = collect(() => ({
      kind: "host",
      ledger: h.ledger,
      fetch: () => new Promise(() => undefined),
    }));
    c.splice.start();
    c.splice.push(h.publish("x".repeat(TERMINAL_SCREEN_SPLICE_BUFFER_CHARS + 1)));
    expect(c.overflowed()).toBe(true);
  });

  it("reports the acked host sequence from the view's parsed chars", async () => {
    const h = host();
    const c = collect(() => ({ kind: "host", ledger: h.ledger, fetch: async () => screen(1) }));
    h.arrive("aa");
    c.splice.start();
    await settle();
    h.arrive("bbb");
    c.splice.push(h.publish("aa"));
    c.splice.push(h.publish("bbb"));
    expect(c.splice.ackedSequence(0)).toBe(1);
    expect(c.splice.ackedSequence(3)).toBe(2);
  });
});

describe("terminal screen items", () => {
  const snapshot = {
    throughSequence: 42,
    cols: 120,
    rows: 40,
    scrollbackRows: 10,
    alternateScreen: true,
    fidelity: "trimmed" as const,
    modelState: "cold" as const,
    trimmedRows: 3,
    ansi: new TextEncoder().encode("é"),
    pendingEscapeTail: new TextEncoder().encode("\u001b["),
  };

  it("decodes a verified snapshot into the contract item", () => {
    expect(
      terminalScreenItem({ threadId: "t", terminalId: "a", runtimeGeneration: "g", snapshot }),
    ).toMatchObject({
      type: "screen",
      throughSequence: "42",
      ansi: "é",
      pendingEscapeTail: "\u001b[",
      fidelity: "trimmed",
      cold: true,
      alternateScreen: true,
    });
  });

  it("never sends an invalid model or a geometry the view cannot take", () => {
    const base = { threadId: "t", terminalId: "a", runtimeGeneration: "g" };
    expect(
      terminalScreenItem({ ...base, snapshot: { ...snapshot, modelState: "invalid" } }),
    ).toBeUndefined();
    expect(terminalScreenItem({ ...base, snapshot: { ...snapshot, cols: 1001 } })).toBeUndefined();
  });
});
