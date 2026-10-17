import type { FormInfo } from "@opencode/client";
import { expect, it } from "vitest";
import { formAnswer, formQuestions } from "./Runtime.forms.ts";

const form: FormInfo = {
  id: "frm_typed",
  sessionID: "ses_typed",
  title: "Setup",
  fields: [
    {
      key: "choice",
      type: "string",
      required: true,
      options: [
        { value: "one", label: "Same" },
        { value: "two", label: "Same" },
      ],
    },
    { key: "enabled", type: "boolean", required: true },
    { key: "count", type: "integer", required: true, minimum: 1, maximum: 3 },
    {
      key: "tags",
      type: "multiselect",
      required: true,
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
      minItems: 1,
      maxItems: 2,
    },
    { key: "note", type: "string", maxLength: 12 },
  ],
};
const valid = { choice: "two", enabled: "false", count: "2", tags: ["a", "b"] };

it("maps exact option identities, boolean choices, optionality and constraints to canonical questions", () => {
  const questions = formQuestions(form);
  expect(questions[0]?.options.map((option) => option.id)).toEqual(["one", "two"]);
  expect(questions[1]?.options).toMatchObject([
    { id: "true", label: "Yes" },
    { id: "false", label: "No" },
  ]);
  expect(questions[2]?.field).toMatchObject({
    type: "integer",
    required: true,
    minimum: 1,
    maximum: 3,
  });
  expect(questions[4]?.field?.required).toBe(false);
  expect(formAnswer(form, valid)).toEqual({
    choice: "two",
    enabled: false,
    count: 2,
    tags: ["a", "b"],
  });
});

for (const answers of [
  { ...valid, choice: "Same" },
  { ...valid, enabled: undefined },
  { ...valid, enabled: "yes" },
  { ...valid, count: "2.1" },
  { ...valid, count: " " },
  { ...valid, count: "4" },
  { ...valid, tags: [] },
  { ...valid, tags: ["c"] },
  { ...valid, tags: ["a", "b", "a"] },
  { ...valid, note: "too long for note" },
  { ...valid, unknown: "x" },
]) {
  it(`rejects invalid required/options/bounds answer ${JSON.stringify(answers)}`, () =>
    expect(() => formAnswer(form, answers)).toThrow());
}

it("validates supported string formats and rejects unsupported native presentations before exposing unusable questions", () => {
  for (const [format, good, bad] of [
    ["email", "a@example.invalid", "no-at"],
    ["uri", "https://example.invalid", "relative"],
    ["date", "2026-09-30", "2026-02-31"],
    ["date-time", "2026-09-30T12:00:00Z", "not-a-date"],
  ] as const) {
    const formatted: FormInfo = {
      ...form,
      fields: [{ key: "value", type: "string", required: true, format }],
    };
    expect(formAnswer(formatted, { value: good })).toEqual({ value: good });
    expect(() => formAnswer(formatted, { value: bad })).toThrow();
  }
  for (const field of [
    { key: "x", type: "external", url: "https://example.invalid" },
    { key: "x", type: "string", hidden: true },
    { key: "x", type: "string", pattern: "(a+)+$" },
    { key: "x", type: "string", when: [{ field: "y", value: "yes" }] },
  ] as const) {
    expect(() => formQuestions({ ...form, fields: [field] } as FormInfo)).toThrow("unsupported");
  }
  expect(() => formQuestions({ ...form, fields: [form.fields[0]!, form.fields[0]!] })).toThrow(
    "keys",
  );
});
