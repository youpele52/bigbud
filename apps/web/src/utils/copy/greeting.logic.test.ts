import { describe, expect, it, vi } from "vitest";

import {
  createGreetingSelector,
  getGreetingPeriod,
  renderGreeting,
  selectGreeting,
} from "./greeting.logic";
import { GREETING_MESSAGES } from "./greeting.messages";

function localTime(hour: number, minute = 0) {
  return new Date(2026, 9, 11, hour, minute);
}

function sequence(...values: number[]) {
  let index = 0;
  return () => values[index++ % values.length]!;
}

describe("new-chat greeting selection", () => {
  it.each([
    [0, 0, "night"],
    [4, 59, "night"],
    [5, 0, "morning"],
    [11, 59, "morning"],
    [12, 0, "afternoon"],
    [16, 59, "afternoon"],
    [17, 0, "evening"],
    [21, 59, "evening"],
    [22, 0, "night"],
    [23, 59, "night"],
  ] as const)("uses local time at %s:%s: %s", (hour, minute, period) => {
    expect(getGreetingPeriod(localTime(hour, minute))).toBe(period);
  });

  it("leaves precisely the first 10% of random outcomes logo-only", () => {
    let logoOnly = 0;
    for (let index = 0; index < 1000; index++) {
      const result = selectGreeting({ now: localTime(9), random: sequence(index / 1000, 0, 0) });
      if (result === null) logoOnly++;
    }
    expect(logoOnly).toBe(100);
    expect(selectGreeting({ now: localTime(9), random: sequence(0.1, 0, 0) })).not.toBeNull();
  });

  it("weights greetings 60% time-aware and 40% anytime independently", () => {
    let timeAware = 0;
    for (let index = 0; index < 1000; index++) {
      const result = selectGreeting({ now: localTime(9), random: sequence(0.5, index / 1000, 0) });
      if (result?.id.startsWith("morning-")) timeAware++;
    }
    expect(timeAware).toBe(600);
  });

  it("keeps each identity stable across revisits and changes in the device clock", () => {
    const now = vi.fn(() => localTime(9));
    const random = vi.fn(() => 0.5);
    const choose = createGreetingSelector({ now, random });
    const first = choose("draft-a");
    now.mockImplementation(() => localTime(18));
    expect(choose("draft-a")).toBe(first);
    expect(now).toHaveBeenCalledTimes(1);
    expect(random).toHaveBeenCalledTimes(3);
    const next = choose("draft-b");
    expect(next?.id).toMatch(/^evening-/);
    expect(next?.id).not.toBe(first?.id);
    expect(choose("draft-a")).toBe(first);
    expect(choose("draft-b")).toBe(next);
  });

  it("avoids the immediately previous copy, including after a logo-only chat or revisiting a draft", () => {
    const random = vi.fn(sequence(0.5, 0.7, 0));
    const choose = createGreetingSelector({ now: () => localTime(9), random });
    const first = choose("a");
    const second = choose("b");
    expect(second?.id).not.toBe(first?.id);
    expect(choose("a")).toBe(first);
    random.mockImplementationOnce(() => 0.01);
    expect(choose("logo-only")).toBeNull();
    expect(choose("c")?.id).not.toBe(first?.id);
    expect(choose("logo-only")).toBeNull();
  });

  it("renders Unicode names as literal text and deliberately chosen nameless copy", () => {
    const message = GREETING_MESSAGES.anytime[0];
    expect(renderGreeting(message, "  Youpele  ")).toBe("What’s up next, Youpele?");
    expect(renderGreeting(message, "\n ")).toBe("What’s up next?");
    expect(renderGreeting(message, "小雨 $& <script>")).toBe("What’s up next, 小雨 $& <script>?");
    expect(renderGreeting(GREETING_MESSAGES.night[1], "Youpele")).toBe(
      "It’s a late-night jam session.",
    );
    expect(renderGreeting(null, "Youpele")).toBeNull();
  });

  it("has 36 unique, readable curated messages, with complete named/unnamed variants", () => {
    const messages = Object.values(GREETING_MESSAGES).flat();
    expect(messages).toHaveLength(36);
    expect(new Set(messages.map((message) => message.id)).size).toBe(36);
    for (const message of messages) {
      expect(renderGreeting(message, "")).not.toMatch(/\{name\}|,\s*[?.]/);
      expect(renderGreeting(message, "Youpele")).not.toContain("{name}");
    }
  });
});
