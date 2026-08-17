import { describe, expect, it } from "vitest";

import type { ChatMessage, Thread } from "~/models/types";

import {
  deriveMascotWorkAnimation,
  expressesAgentUncertainty,
  hasAssistantStreamProgress,
  hasNewAgentUncertainty,
  hasNewCelebratoryFeedback,
  isCelebratoryFeedback,
  selectMascotAnimation,
} from "./mascotAnimation.logic";

function message(id: string, role: ChatMessage["role"], text: string, streaming = false) {
  return { id, role, text, streaming } as ChatMessage;
}

function thread(
  id: string,
  messages: ChatMessage[] = [],
  status: "connecting" | "ready" | "running" = "ready",
): Thread {
  return {
    id,
    messages,
    session: {
      status,
      ...(status === "running" ? { activeTurnId: "turn-1" } : {}),
    },
  } as Thread;
}

describe("mascot animation logic", () => {
  it("uses thinking for an active turn until actual text progress is observed", () => {
    expect(deriveMascotWorkAnimation([thread("1", [], "running")])).toBe("thinking");
    expect(
      deriveMascotWorkAnimation([
        thread("1", [message("assistant-1", "assistant", "Hello", true)], "running"),
      ]),
    ).toBe("thinking");
    expect(deriveMascotWorkAnimation([thread("1")])).toBe("okay");
  });

  it("reports stream progress only when active assistant text changes", () => {
    const previous = thread("1", [message("assistant-1", "assistant", "Hello", true)], "running");
    const progressed = thread(
      "1",
      [message("assistant-1", "assistant", "Hello world", true)],
      "running",
    );
    const stopped = thread("1", progressed.messages, "ready");

    expect(hasAssistantStreamProgress([previous], [progressed])).toBe(true);
    expect(hasAssistantStreamProgress([progressed], [progressed])).toBe(false);
    expect(hasAssistantStreamProgress([progressed], [stopped])).toBe(false);
  });

  it("uses thinking instead of typing whenever the streaming agent is uncertain", () => {
    const uncertain = thread(
      "1",
      [message("assistant-1", "assistant", "I'm not sure yet", true)],
      "running",
    );

    expect(expressesAgentUncertainty("I may be wrong about this")).toBe(true);
    expect(expressesAgentUncertainty("The answer is ready")).toBe(false);
    expect(deriveMascotWorkAnimation([uncertain])).toBe("thinking");
  });

  it("recognizes praise and confirmation without celebrating negative feedback", () => {
    expect(isCelebratoryFeedback("Perfect, you nailed it!")).toBe(true);
    expect(isCelebratoryFeedback("You got the answer")).toBe(true);
    expect(isCelebratoryFeedback("The model got the answer")).toBe(true);
    expect(isCelebratoryFeedback("Thanks, that worked")).toBe(true);
    expect(isCelebratoryFeedback("That is not correct")).toBe(false);
    expect(isCelebratoryFeedback("This is not perfect yet")).toBe(false);
    expect(isCelebratoryFeedback("It didn't work")).toBe(false);
  });

  it("celebrates only when matching feedback is a new user message", () => {
    const previous = thread("1", [message("user-1", "user", "Please try again")]);
    const praised = thread("1", [
      ...previous.messages,
      message("user-2", "user", "Great work, you got it"),
    ]);

    expect(hasNewCelebratoryFeedback([previous], [praised])).toBe(true);
    expect(hasNewCelebratoryFeedback([praised], [praised])).toBe(false);
  });

  it("detects uncertainty when an assistant message begins or changes", () => {
    const previous = thread("1", [message("assistant-1", "assistant", "Checking", true)]);
    const uncertain = thread("1", [
      message("assistant-1", "assistant", "Checking, but I don't know yet", true),
    ]);

    expect(hasNewAgentUncertainty([previous], [uncertain])).toBe(true);
    expect(hasNewAgentUncertainty([uncertain], [uncertain])).toBe(false);
  });

  it("uses the pointing pose for app attention ahead of idle and hover", () => {
    expect(
      selectMascotAnimation({
        agentUncertain: false,
        isCelebrating: false,
        hasAttention: true,
        isHovered: true,
        isGreeting: false,
        assistantIsActivelyTyping: false,
        workAnimation: "okay",
      }),
    ).toBe("pointing");
    expect(
      selectMascotAnimation({
        agentUncertain: false,
        isCelebrating: true,
        hasAttention: true,
        isHovered: false,
        isGreeting: false,
        assistantIsActivelyTyping: false,
        workAnimation: "okay",
      }),
    ).toBe("celebration");
  });
});
