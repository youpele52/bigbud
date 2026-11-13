import { describe, expect, it } from "vitest";

import { toUserInputQuestions } from "./Adapter.stream.utils.ts";

describe("Codex request_user_input question mapping", () => {
  it("keeps free-text questions and options with empty descriptions instead of dropping them", () => {
    // Shapes allowed by Codex 0.167's ToolRequestUserInputQuestion schema.
    expect(
      toUserInputQuestions({
        isBlocking: true,
        questions: [
          {
            id: "branch",
            header: "Branch",
            question: "What should the branch be named?",
            options: null,
            isOther: true,
          },
          {
            id: "env",
            header: "",
            question: "Which environment?",
            options: [
              { label: "Staging", description: "" },
              { label: "Production", description: "Live users" },
              { label: " ", description: "ignored" },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        id: "branch",
        header: "Branch",
        question: "What should the branch be named?",
        options: [],
        multiSelect: false,
      },
      {
        id: "env",
        header: "Which environment?",
        question: "Which environment?",
        options: [
          { label: "Staging", description: "Staging" },
          { label: "Production", description: "Live users" },
        ],
        multiSelect: false,
      },
    ]);
  });

  it("still rejects questions without an id or question text", () => {
    expect(
      toUserInputQuestions({
        questions: [
          { id: "", question: "x" },
          { id: "a", question: " " },
        ],
      }),
    ).toBeUndefined();
    expect(toUserInputQuestions({})).toBeUndefined();
  });
});
