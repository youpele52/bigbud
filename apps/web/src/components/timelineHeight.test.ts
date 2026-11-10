import { describe, expect, it } from "vitest";

import { appendTerminalContextsToPrompt } from "../lib/terminalContext";
import { buildInlineTerminalContextText } from "./chat/common/userMessageTerminalContexts";
import { estimateTimelineMessageHeight } from "./timelineHeight";

describe("estimateTimelineMessageHeight", () => {
  it("uses assistant sizing rules for assistant messages", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "assistant",
        text: "a".repeat(144),
      }),
    ).toBe(86.5);
  });

  it("uses assistant sizing rules for system messages", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "system",
        text: "a".repeat(144),
      }),
    ).toBe(86.5);
  });

  it("adds one attachment row for one or two user attachments", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "hello",
        attachments: [{ id: "1" }],
      }),
    ).toBe(324.75);

    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "hello",
        attachments: [{ id: "1" }, { id: "2" }],
      }),
    ).toBe(324.75);
  });

  it("adds a second attachment row for three or four user attachments", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "hello",
        attachments: [{ id: "1" }, { id: "2" }, { id: "3" }],
      }),
    ).toBe(552.75);

    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "hello",
        attachments: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }],
      }),
    ).toBe(552.75);
  });

  it("does not cap long user message estimates", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "a".repeat(56 * 120),
      }),
    ).toBe(2804);
  });

  it("counts explicit newlines for user message estimates", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "first\nsecond\nthird",
      }),
    ).toBe(142.25);
  });

  it("adds terminal context chrome without counting the hidden block as message text", () => {
    const prompt = appendTerminalContextsToPrompt("Investigate this", [
      {
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 40,
        lineEnd: 43,
        text: [
          "git status",
          "M apps/web/src/components/chat/MessagesTimeline.tsx",
          "?? tmp",
          "",
        ].join("\n"),
      },
    ]);

    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: prompt,
      }),
    ).toBe(
      estimateTimelineMessageHeight({
        role: "user",
        text: `${buildInlineTerminalContextText([{ header: "Terminal 1 lines 40-43" }])} Investigate this`,
      }),
    );
  });

  it("adds a compact closed row without counting delegated provenance as message text", () => {
    const task = "Implement the delegated task.";
    const prompt = [
      "<delegated_thread_provenance>",
      "Parent thread: Parent task (thread-parent)",
      "Parent project: project-parent",
      "Delegation: delegation-1",
      "</delegated_thread_provenance>",
      "",
      task,
    ].join("\n");

    expect(estimateTimelineMessageHeight({ role: "user", text: prompt })).toBe(
      estimateTimelineMessageHeight({ role: "user", text: task }) + 24,
    );
  });

  it("uses narrower width to increase user line wrapping", () => {
    const message = {
      role: "user" as const,
      text: "a".repeat(52),
    };

    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 320 })).toBe(119.5);
    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 768 })).toBe(96.75);
  });

  it("does not clamp user wrapping too aggressively on very narrow layouts", () => {
    const message = {
      role: "user" as const,
      text: "a".repeat(20),
    };

    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 100 })).toBe(165);
    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 320 })).toBe(96.75);
  });

  it.each([
    { timelineWidthPx: 768, lines: 40 },
    { timelineWidthPx: 714, lines: 44 },
    { timelineWidthPx: 314, lines: 107 },
  ])(
    "models long proportional user text at width $timelineWidthPx",
    ({ timelineWidthPx, lines }) => {
      // 80% bubble minus px-4 and borders; 14px DM Sans is about 7.2px per glyph.
      expect(
        estimateTimelineMessageHeight(
          { role: "user", text: "x".repeat(3_200) },
          { timelineWidthPx },
        ),
      ).toBe(74 + lines * 22.75);
    },
  );

  it("uses narrower width to increase assistant line wrapping", () => {
    const message = {
      role: "assistant" as const,
      text: "a".repeat(200),
    };

    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 320 })).toBe(154.75);
    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 768 })).toBe(86.5);
  });
});
