import { describe, expect, it, vi } from "vitest";

import {
  createGreetingSelector,
  getGreetingPeriod,
  isGreetingEligibleOnLocalDate,
  renderGreeting,
  selectGreeting,
} from "./greeting.logic";
import { GREETING_MESSAGES, type GreetingMessage } from "./greeting.messages";

function localTime(hour: number, minute = 0) {
  return new Date(2026, 9, 11, hour, minute);
}

function allGreetingMessages(): ReadonlyArray<GreetingMessage> {
  return Object.values(GREETING_MESSAGES).flat();
}

function greetingById(id: string) {
  return allGreetingMessages().find((message) => message.id === id)!;
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
    const morningIds = new Set<string>(GREETING_MESSAGES.morning.map((message) => message.id));
    for (let index = 0; index < 1000; index++) {
      const result = selectGreeting({ now: localTime(9), random: sequence(0.5, index / 1000, 0) });
      if (result && morningIds.has(result.id)) timeAware++;
    }
    expect(timeAware).toBe(600);
  });

  it("checks weekday, weekend, and Sunday-only restrictions using the local date", () => {
    const saturday = new Date(2026, 9, 10, 23, 59);
    const sunday = new Date(2026, 9, 11, 0, 0);
    const monday = new Date(2026, 9, 12, 0, 0);

    expect(isGreetingEligibleOnLocalDate(greetingById("source-happy-monday"), monday)).toBe(true);
    expect(isGreetingEligibleOnLocalDate(greetingById("source-happy-monday"), sunday)).toBe(false);
    const fridayFeeling = greetingById("source-friday-feeling");
    expect(isGreetingEligibleOnLocalDate(fridayFeeling, new Date(2026, 9, 9))).toBe(true);
    expect(isGreetingEligibleOnLocalDate(fridayFeeling, monday)).toBe(false);
    expect(isGreetingEligibleOnLocalDate(greetingById("source-sunday-session"), sunday)).toBe(true);
    expect(isGreetingEligibleOnLocalDate(greetingById("source-sunday-session"), saturday)).toBe(
      false,
    );
    expect(isGreetingEligibleOnLocalDate(greetingById("source-sunday-session"), monday)).toBe(
      false,
    );
    for (const id of ["source-weekend-welcome", "source-weekend-mind"]) {
      expect(isGreetingEligibleOnLocalDate(greetingById(id), saturday)).toBe(true);
      expect(isGreetingEligibleOnLocalDate(greetingById(id), sunday)).toBe(true);
      expect(isGreetingEligibleOnLocalDate(greetingById(id), monday)).toBe(false);
    }
    expect(isGreetingEligibleOnLocalDate(GREETING_MESSAGES.anytime[0], monday)).toBe(true);
  });

  it.each<readonly [string, number, string]>([
    ["Monday", 12, "source-happy-monday"],
    ["Tuesday", 13, "source-happy-tuesday"],
    ["Wednesday", 14, "source-happy-wednesday"],
    ["Thursday", 15, "source-happy-thursday"],
    ["Friday", 9, "source-happy-friday"],
    ["Saturday", 10, "source-happy-saturday"],
    ["Sunday", 11, "source-happy-sunday"],
  ])("allows %s greetings only on their named local day", (_, date, id) => {
    const namedDate = new Date(2026, 9, date, 12);
    const adjacentDays = [new Date(2026, 9, date - 1, 23, 59), new Date(2026, 9, date + 1, 0, 0)];
    const message = greetingById(id);

    expect(GREETING_MESSAGES.morning).toContain(message);
    expect(isGreetingEligibleOnLocalDate(message, namedDate)).toBe(true);
    for (const adjacentDay of adjacentDays) {
      expect(isGreetingEligibleOnLocalDate(message, adjacentDay)).toBe(false);
    }
  });

  it("filters weekday-only greetings before selection while retaining the 60/40 split", () => {
    const mondayGreeting = selectGreeting({
      now: new Date(2026, 9, 12, 9),
      random: sequence(0.5, 0.5, 0.9),
    });
    expect(mondayGreeting?.id).toBe("source-happy-monday");

    for (let index = 0; index < 100; index++) {
      const sundayGreeting = selectGreeting({
        now: new Date(2026, 9, 11, 9),
        random: sequence(0.5, 0.5, index / 100),
      });
      expect(sundayGreeting?.id).not.toBe("source-happy-monday");
    }
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
    expect(renderGreeting(greetingById("source-happy-monday"), "")).toBe("Happy Monday, bud");
    expect(renderGreeting(GREETING_MESSAGES.anytime[0], "")).toBe("What’s up next?");
    expect(renderGreeting(null, "Youpele")).toBeNull();
  });

  it("uses bud for new name slots and preserves configured nicknames", () => {
    const adaptedMessages = allGreetingMessages().filter((message) =>
      message.id.startsWith("source-"),
    );
    const namedMessages = adaptedMessages.filter((message) => message.named);

    expect(namedMessages).toHaveLength(23);
    for (const message of namedMessages) {
      expect(message.nameFallback).toBe("bud");
      expect(renderGreeting(message, "")).toBe(message.named?.replace("{name}", "bud"));
      expect(renderGreeting(message, "  Youpele  ")).toBe(
        message.named?.replace("{name}", "Youpele"),
      );
      expect(renderGreeting(message, "")).not.toMatch(/,\s*[?.]/);
    }
  });

  it("adds each new source template once and reuses the existing night-thought template", () => {
    const sourceMessages = allGreetingMessages().filter((message) =>
      message.id.startsWith("source-"),
    );
    const sourceIds = [
      "source-good-morning",
      "source-welcome-morning",
      "source-hey-there",
      "source-happy-monday",
      "source-happy-tuesday",
      "source-happy-wednesday",
      "source-happy-thursday",
      "source-happy-friday",
      "source-friday-feeling",
      "source-weekend-welcome",
      "source-happy-saturday",
      "source-weekend-mind",
      "source-sunday-session",
      "source-happy-sunday",
      "source-coffee",
      "source-good-afternoon",
      "source-how-are-you",
      "source-whats-new",
      "source-back-at-it",
      "source-returns",
      "source-good-evening",
      "source-evening",
      "source-how-was-your-day",
      "source-how-is-it-going",
      "source-night-owl",
    ];
    const renderedWithNickname = sourceMessages.map((message) =>
      renderGreeting(message, "Youpele"),
    );
    const allSourceTemplates = [...sourceMessages, greetingById("night-mind")];
    const sourcePeriodCounts = Object.values(GREETING_MESSAGES).map(
      (messages) => messages.filter((message) => message.id.startsWith("source-")).length,
    );

    expect(sourceMessages.map((message) => message.id)).toEqual(sourceIds);
    expect(sourceMessages).toHaveLength(25);
    expect(allSourceTemplates).toHaveLength(26);
    expect(sourcePeriodCounts).toEqual([15, 4, 4, 2, 0]);
    expect(renderedWithNickname).toEqual([
      "Good morning, Youpele",
      "Welcome, Youpele",
      "Hey there, Youpele",
      "Happy Monday, Youpele",
      "Happy Tuesday, Youpele",
      "Happy Wednesday, Youpele",
      "Happy Thursday, Youpele",
      "Happy Friday, Youpele",
      "That Friday feeling, Youpele",
      "Welcome to the weekend, Youpele",
      "Happy Saturday, Youpele",
      "What’s on your mind, Youpele?",
      "Sunday session, Youpele?",
      "Happy Sunday, Youpele",
      "Coffee and bigbud time?",
      "Good afternoon, Youpele",
      "Hi Youpele, how are you?",
      "What’s new, Youpele?",
      "Back at it, Youpele",
      "Youpele returns!",
      "Good evening, Youpele",
      "Evening, Youpele",
      "How was your day, Youpele?",
      "How’s it going, Youpele?",
      "Hello, night owl",
    ]);
    expect(renderedWithNickname.join(" ")).not.toMatch(/claude/i);
    expect(greetingById("night-mind").nameless).toBe("What’s on your mind tonight, bud?");
    expect(renderGreeting(greetingById("night-mind"), "")).toBe(
      "What’s on your mind tonight, bud?",
    );
    expect(greetingById("source-coffee").nameless).toBe("Coffee and bigbud time?");
  });

  it("preserves 36 curated messages and adds the 25 source phrases not already present", () => {
    const messages = allGreetingMessages();
    const adaptedMessages = messages.filter((message) => message.id.startsWith("source-"));
    expect(messages).toHaveLength(61);
    expect(adaptedMessages).toHaveLength(25);
    expect(messages.length - adaptedMessages.length).toBe(36);
    expect(new Set(messages.map((message) => message.id)).size).toBe(61);
    for (const message of messages) {
      expect(renderGreeting(message, "")).not.toMatch(/\{name\}|,\s*[?.]/);
      expect(renderGreeting(message, "Youpele")).not.toContain("{name}");
    }
  });
});
