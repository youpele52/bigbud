import { describe, expect, it } from "vitest";

import { devinElicitationResult, parseDevinElicitation } from "./Adapter.elicitation.logic.ts";

/** Captured from `devin acp` 3000.12.57 for a two-question ask_user_question call. */
const capturedTwoQuestionRequest = {
  mode: "form",
  sessionId: "spotted-need",
  requestedSchema: {
    type: "object",
    properties: {
      q0: {
        type: "array",
        title: "Areas to change",
        description: "Which areas do you want to change?",
        minItems: 1,
        items: {
          anyOf: [
            { const: "Server", title: "Server", _meta: { "cognition.ai/description": "Backend" } },
            { const: "Web", title: "Web", _meta: { "cognition.ai/description": "Frontend" } },
            { const: "Docs", title: "Docs" },
          ],
        },
      },
      q1: {
        type: "string",
        title: "Release channel",
        description: "Which release channel?",
        oneOf: [
          { const: "Beta", title: "Beta" },
          { const: "Stable", title: "Stable" },
        ],
      },
    },
    required: ["q0", "q1"],
  },
  message: "Which areas do you want to change?",
  _meta: { "cognition.ai/allowOther": true, "cognition.ai/toolCallId": "call_1" },
};

describe("Devin elicitation mapping", () => {
  it("maps the captured multi- and single-choice form to id-valued questions", () => {
    const form = parseDevinElicitation(capturedTwoQuestionRequest)!;
    expect(form.questions).toEqual([
      {
        id: "q0",
        header: "Areas to change",
        question: "Which areas do you want to change?",
        options: [
          { id: "Server", label: "Server", description: "Backend" },
          { id: "Web", label: "Web", description: "Frontend" },
          { id: "Docs", label: "Docs", description: "Docs" },
        ],
        multiSelect: true,
        field: { type: "multiselect", required: true, allowCustom: false, minItems: 1 },
      },
      {
        id: "q1",
        header: "Release channel",
        question: "Which release channel?",
        options: [
          { id: "Beta", label: "Beta", description: "Beta" },
          { id: "Stable", label: "Stable", description: "Stable" },
        ],
        multiSelect: false,
      },
    ]);
    expect(form.kinds).toEqual({ q0: "multi", q1: "single" });
  });

  it("answers with typed content Devin accepts, and cancels on an empty answer set", () => {
    const form = parseDevinElicitation(capturedTwoQuestionRequest)!;
    expect(devinElicitationResult(form, { q0: ["Server", "Docs"], q1: "Beta" })).toEqual({
      action: "accept",
      content: { q0: ["Server", "Docs"], q1: "Beta" },
    });
    expect(devinElicitationResult(form, { q0: "Web", q1: ["Stable"] })).toEqual({
      action: "accept",
      content: { q0: ["Web"], q1: "Stable" },
    });
    expect(devinElicitationResult(form, {})).toEqual({ action: "cancel" });
  });

  it("only accepts listed values without allowOther, and maps booleans, numbers and text", () => {
    const form = parseDevinElicitation({
      mode: "form",
      requestedSchema: {
        properties: {
          pick: { type: "string", oneOf: [{ const: "a", title: "A" }] },
          ok: { type: "boolean", title: "Proceed?" },
          n: { type: "integer", minimum: 1, maximum: 5 },
          note: { type: "string", maxLength: 40, format: "email" },
        },
        required: ["pick"],
      },
    })!;
    expect(form.questions.map((question) => question.field)).toEqual([
      { type: "string", required: true, allowCustom: false },
      { type: "boolean", required: false, allowCustom: false },
      { type: "integer", required: false, allowCustom: true, minimum: 1, maximum: 5 },
      { type: "string", required: false, allowCustom: true, maxLength: 40, format: "email" },
    ]);
    expect(devinElicitationResult(form, { pick: "a", ok: "true", n: "3", note: "x@y.z" })).toEqual({
      action: "accept",
      content: { pick: "a", ok: true, n: 3, note: "x@y.z" },
    });
  });

  it("lets an optional allowOther question be skipped while still accepting free text", () => {
    const form = parseDevinElicitation({
      requestedSchema: {
        properties: { q0: { type: "string", oneOf: [{ const: "Beta", title: "Beta" }] } },
        required: [],
      },
      _meta: { "cognition.ai/allowOther": true },
    })!;
    expect(form.questions[0]!.field).toEqual({
      type: "string",
      required: false,
      allowCustom: true,
    });
    expect(devinElicitationResult(form, { other: "x" })).toEqual({ action: "accept", content: {} });
  });

  it("labels untitled questions with the request message instead of the property key", () => {
    const form = parseDevinElicitation({
      requestedSchema: { properties: { q0: { type: "string" } } },
      message: "Which branch?",
    })!;
    expect(form.questions[0]).toMatchObject({ id: "q0", header: "Which branch?" });
    expect(
      parseDevinElicitation({ requestedSchema: { properties: { q0: { type: "string" } } } })!
        .questions[0],
    ).toMatchObject({ header: "Question", question: "Question" });
  });

  it("declines URL elicitation and unusable schemas", () => {
    expect(parseDevinElicitation({ mode: "url", url: "https://example.com" })).toBeNull();
    expect(parseDevinElicitation({ mode: "form", requestedSchema: {} })).toBeNull();
    expect(parseDevinElicitation(null)).toBeNull();
  });
});
