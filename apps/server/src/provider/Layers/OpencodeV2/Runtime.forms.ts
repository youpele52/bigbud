import type { FormInfo, FormAnswer } from "@opencode/client";
import type { UserInputQuestion } from "@bigbud/contracts/orchestration/providerRuntime.payloads.ts";
import { validUserInputAnswer } from "@bigbud/shared/providerUserInput";

/** Typed native fields retain exact keys/option values and required/closed-choice constraints. */
export function formQuestions(form: FormInfo): UserInputQuestion[] {
  if (
    form.fields.length > 64 ||
    form.fields.some(
      (field) =>
        !field.key.trim() ||
        field.key !== field.key.trim() ||
        ["__proto__", "constructor", "prototype"].includes(field.key),
    ) ||
    new Set(form.fields.map((field) => field.key)).size !== form.fields.length
  )
    throw new Error("V2 form field keys/bounds rejected.");
  return form.fields.map((field) => {
    if (
      field.type === "external" ||
      field.hidden ||
      field.when?.length ||
      (field.type === "string" && field.pattern !== undefined)
    )
      throw new Error(
        "V2 conditional/hidden/external/pattern form requires unsupported native presentation.",
      );
    const options =
      field.type === "boolean"
        ? [
            { value: "true", label: "Yes" },
            { value: "false", label: "No" },
          ]
        : "options" in field
          ? (field.options ?? [])
          : [];
    if (
      options.length > 64 ||
      options.some((option) => !option.value.trim() || option.value !== option.value.trim()) ||
      new Set(options.map((option) => option.value)).size !== options.length
    )
      throw new Error("V2 form option identities/bounds rejected.");
    const minimum =
      "minimum" in field && typeof field.minimum === "number" ? field.minimum : undefined;
    const maximum =
      "maximum" in field && typeof field.maximum === "number" ? field.maximum : undefined;
    if (
      ("minimum" in field && typeof field.minimum === "string" && field.minimum !== "-Infinity") ||
      ("maximum" in field && typeof field.maximum === "string" && field.maximum !== "Infinity")
    )
      throw new Error("V2 nonfinite form constraint is unsupported.");
    return {
      id: field.key,
      header: field.title?.trim() || field.key,
      question: field.description?.trim() || field.title?.trim() || field.key,
      options: options.map((option) => ({
        id: option.value,
        label: option.label?.trim() || option.value,
        description: option.label?.trim() || option.value,
      })),
      multiSelect: field.type === "multiselect",
      field: {
        type: field.type,
        required: field.required === true,
        allowCustom:
          field.type === "string"
            ? !field.options || field.custom === true
            : field.type === "multiselect"
              ? field.custom === true
              : field.type !== "boolean",
        ...(field.type === "string"
          ? {
              minLength: field.minLength,
              maxLength: Math.min(field.maxLength ?? 24000, 24000),
              format: field.format,
            }
          : {}),
        ...(field.type === "multiselect"
          ? { minItems: field.minItems, maxItems: Math.min(field.maxItems ?? 64, 64) }
          : {}),
        ...(minimum !== undefined ? { minimum } : {}),
        ...(maximum !== undefined ? { maximum } : {}),
      },
    };
  });
}

export function formAnswer(form: FormInfo, answers: Record<string, unknown>): FormAnswer {
  const questions = formQuestions(form);
  if (Object.keys(answers).some((key) => !questions.some((question) => question.id === key)))
    throw new Error("V2 unknown form answer key.");
  const answer: FormAnswer = {};
  for (const question of questions) {
    const raw = answers[question.id];
    if (!validUserInputAnswer(question, raw))
      throw new Error(`V2 invalid or missing ${question.field!.type} answer: ${question.id}`);
    if (raw === undefined || raw === null) continue;
    answer[question.id] =
      question.field!.type === "boolean"
        ? raw === true || raw === "true"
        : question.field!.type === "number" || question.field!.type === "integer"
          ? Number(raw)
          : (raw as FormAnswer[string]);
  }
  return answer;
}
