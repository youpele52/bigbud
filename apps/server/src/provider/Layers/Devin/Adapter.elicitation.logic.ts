import type { ProviderUserInputAnswers } from "@bigbud/contracts/orchestration/orchestration.provider.ts";
import type { UserInputQuestion } from "@bigbud/contracts/orchestration/providerRuntime.payloads.ts";

/**
 * Devin's `ask_user_question` tool sends MCP-style form elicitation (`elicitation/create`, not
 * ACP `session/elicitation`) and is only offered to clients that advertise form elicitation.
 * Verified against `devin acp` 3000.12.57: one property per question, single choice as
 * `type: "string"` + `oneOf: [{ const, title }]`, multi choice as `type: "array"` +
 * `items.anyOf`, answered with `{ action: "accept", content: { q0: "…", q1: ["…"] } }`.
 */
export const DEVIN_ELICITATION_METHOD = "elicitation/create";
export const DEVIN_ELICITATION_CAPABILITIES = { form: {} } as const;

type DevinFieldKind = "single" | "multi" | "text" | "boolean" | "number" | "integer";

export interface DevinElicitationForm {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly kinds: Readonly<Record<string, DevinFieldKind>>;
}

export type DevinElicitationResult =
  | { readonly action: "accept"; readonly content: Record<string, unknown> }
  | { readonly action: "decline" }
  | { readonly action: "cancel" };

const MAX_QUESTIONS = 32;
const FORMATS = new Set(["email", "uri", "date", "date-time"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Option ids are the values Devin expects back, so answers never carry appended text. */
function choiceOptions(schema: Record<string, unknown>): UserInputQuestion["options"] {
  const alternatives = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(alternatives)) {
    return alternatives.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.const !== "string") return [];
      const meta = isRecord(entry._meta)
        ? text(entry._meta["cognition.ai/description"])
        : undefined;
      const label = text(entry.title) ?? entry.const;
      return [{ id: entry.const, label, description: meta ?? label }];
    });
  }
  if (!Array.isArray(schema.enum)) return [];
  return schema.enum.flatMap((value) =>
    typeof value === "string" ? [{ id: value, label: value, description: value }] : [],
  );
}

function toQuestion(
  id: string,
  schema: Record<string, unknown>,
  required: boolean,
  allowOther: boolean,
  message: string | undefined,
): { question: UserInputQuestion; kind: DevinFieldKind } {
  const header = text(schema.title) ?? message ?? "Question";
  const base = { id, header, question: text(schema.description) ?? message ?? header };
  if (schema.type === "array") {
    const options = isRecord(schema.items) ? choiceOptions(schema.items) : [];
    const minItems = count(schema.minItems);
    const maxItems = count(schema.maxItems);
    return {
      kind: "multi",
      question: {
        ...base,
        options,
        multiSelect: true,
        field: {
          type: "multiselect",
          required,
          // Custom multiselect entries would need JSON-array text, so only listed values are
          // sent; the panel says when typed text is skipped. Free text only without options.
          allowCustom: options.length === 0,
          ...(minItems !== undefined ? { minItems } : {}),
          ...(maxItems !== undefined ? { maxItems } : {}),
        },
      },
    };
  }
  if (schema.type === "boolean") {
    const options = [
      { id: "true", label: "Yes", description: "Yes" },
      { id: "false", label: "No", description: "No" },
    ];
    return {
      kind: "boolean",
      question: { ...base, options, field: { type: "boolean", required, allowCustom: false } },
    };
  }
  if (schema.type === "number" || schema.type === "integer") {
    const minimum = count(schema.minimum);
    const maximum = count(schema.maximum);
    return {
      kind: schema.type,
      question: {
        ...base,
        options: [],
        field: {
          type: schema.type,
          required,
          allowCustom: true,
          ...(minimum !== undefined ? { minimum } : {}),
          ...(maximum !== undefined ? { maximum } : {}),
        },
      },
    };
  }
  const options = choiceOptions(schema);
  if (options.length > 0) {
    // Without allowOther only a listed value is valid. A required allowOther question needs no
    // field (any answer, chips stay bare ids); an optional one keeps a field so it can be skipped.
    const field =
      allowOther && required
        ? {}
        : { field: { type: "string" as const, required, allowCustom: allowOther } };
    return { kind: "single", question: { ...base, options, multiSelect: false, ...field } };
  }
  const minLength = count(schema.minLength);
  const maxLength = count(schema.maxLength);
  const format =
    typeof schema.format === "string" && FORMATS.has(schema.format) ? schema.format : undefined;
  return {
    kind: "text",
    question: {
      ...base,
      options: [],
      field: {
        type: "string",
        required,
        allowCustom: true,
        ...(minLength !== undefined ? { minLength } : {}),
        ...(maxLength !== undefined ? { maxLength } : {}),
        ...(format ? { format: format as "email" | "uri" | "date" | "date-time" } : {}),
      },
    },
  };
}

/** Maps a form elicitation to bigbud questions; null for URL mode or an unusable schema. */
export function parseDevinElicitation(params: unknown): DevinElicitationForm | null {
  if (!isRecord(params) || (params.mode !== undefined && params.mode !== "form")) return null;
  const schema = isRecord(params.requestedSchema) ? params.requestedSchema : undefined;
  const properties = schema && isRecord(schema.properties) ? schema.properties : undefined;
  if (!properties) return null;
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const allowOther = isRecord(params._meta) && params._meta["cognition.ai/allowOther"] === true;
  const message = text(params.message);
  const questions: UserInputQuestion[] = [];
  const kinds: Record<string, DevinFieldKind> = {};
  for (const [id, property] of Object.entries(properties).slice(0, MAX_QUESTIONS)) {
    if (!isRecord(property)) continue;
    const mapped = toQuestion(id, property, required.has(id), allowOther, message);
    questions.push(mapped.question);
    kinds[id] = mapped.kind;
  }
  return questions.length > 0 ? { questions, kinds } : null;
}

/** Converts bigbud answers back to the typed form content; no answers at all means cancel. */
export function devinElicitationResult(
  form: DevinElicitationForm,
  answers: ProviderUserInputAnswers,
): DevinElicitationResult {
  if (Object.keys(answers).length === 0) return { action: "cancel" };
  const content: Record<string, unknown> = {};
  for (const question of form.questions) {
    const raw = answers[question.id];
    if (raw === undefined || raw === null || raw === "") continue;
    const first = Array.isArray(raw) ? raw[0] : raw;
    switch (form.kinds[question.id]) {
      case "multi":
        content[question.id] = (Array.isArray(raw) ? raw : [raw]).map(String);
        break;
      case "boolean":
        content[question.id] = first === true || first === "true";
        break;
      case "number":
      case "integer": {
        const value = Number(first);
        if (Number.isFinite(value)) content[question.id] = value;
        break;
      }
      default:
        content[question.id] = String(first);
    }
  }
  return { action: "accept", content };
}
