import { describe, expect, it } from "vitest";

import {
  CursorAskQuestionRequest,
  buildCursorAskQuestionAnsweredResponse,
  buildCursorAskQuestionCancelledResponse,
  buildCursorAskQuestionResponse,
  buildCursorCreatePlanAcceptedResponse,
  extractAskQuestions,
} from "./CursorAcpExtension.ts";

const request = {
  toolCallId: "tool-1",
  questions: [
    {
      id: "first",
      prompt: "Pick the first option",
      options: [
        { id: "first-a", label: "A" },
        { id: "first-b", label: "B" },
      ],
    },
    {
      id: "second",
      prompt: "Pick the second option",
      options: [{ id: "second-a", label: "A" }],
      allowMultiple: true,
    },
  ],
} satisfies typeof CursorAskQuestionRequest.Type;

describe("extractAskQuestions", () => {
  it("preserves Cursor option ids and does not invent an option", () => {
    expect(
      extractAskQuestions({
        toolCallId: request.toolCallId,
        questions: [
          { id: "first", prompt: "Pick the first option", options: [] },
          {
            id: "second",
            prompt: "Pick the second option",
            options: [{ id: " id-a ", label: "A" }],
            allowMultiple: true,
          },
        ],
      }),
    ).toEqual([
      {
        id: "first",
        header: "Question",
        question: "Pick the first option",
        options: [],
        multiSelect: false,
      },
      {
        id: "second",
        header: "Question",
        question: "Pick the second option",
        options: [{ id: "id-a", label: "A", description: "A" }],
        multiSelect: true,
      },
    ]);
  });
});

describe("Cursor ask-question response builders", () => {
  it("keeps question order, resolves ids before labels, and deduplicates ids", () => {
    expect(
      buildCursorAskQuestionAnsweredResponse({
        request,
        answers: { second: ["A", "second-a", "second-a"], first: "first-b" },
      }),
    ).toEqual({
      outcome: {
        outcome: "answered",
        answers: [
          { questionId: "first", selectedOptionIds: ["first-b"] },
          { questionId: "second", selectedOptionIds: ["second-a"] },
        ],
      },
    });
  });

  it("skips missing, malformed, ambiguous, and unresolvable answers", () => {
    expect(buildCursorAskQuestionAnsweredResponse({ request, answers: {} })).toEqual({
      outcome: { outcome: "skipped" },
    });
    expect(
      buildCursorAskQuestionAnsweredResponse({ request, answers: { first: ["first-a", 4] } }),
    ).toEqual({ outcome: { outcome: "skipped" } });
    expect(buildCursorAskQuestionAnsweredResponse({ request, answers: { first: "" } })).toEqual({
      outcome: { outcome: "skipped" },
    });
    expect(
      buildCursorAskQuestionAnsweredResponse({
        request: {
          toolCallId: request.toolCallId,
          questions: [
            {
              id: "first",
              prompt: "Pick the first option",
              options: [
                { id: "a", label: "Same" },
                { id: "b", label: "Same" },
              ],
            },
          ],
        },
        answers: { first: "Same" },
      }),
    ).toEqual({ outcome: { outcome: "skipped" } });
    expect(
      buildCursorAskQuestionAnsweredResponse({ request, answers: { first: "unknown" } }),
    ).toEqual({ outcome: { outcome: "skipped" } });
  });

  it("supports the typed cancellation envelope", () => {
    expect(
      buildCursorAskQuestionResponse({ request, resolution: { outcome: "cancelled" } }),
    ).toEqual(buildCursorAskQuestionCancelledResponse());
  });
});

describe("Cursor plan response builder", () => {
  it("returns the documented nested acceptance envelope", () => {
    expect(buildCursorCreatePlanAcceptedResponse()).toEqual({
      outcome: { outcome: "accepted" },
    });
  });
});
