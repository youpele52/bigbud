import type { UserInputQuestion } from "@bigbud/contracts/orchestration/providerRuntime.payloads.ts";

/** Validate the supported typed form subset without evaluating arbitrary native regular expressions. */
export function validUserInputAnswer(question: UserInputQuestion, raw: unknown): boolean {
  const field = question.field;
  if (!field) return true;
  if (raw === undefined || raw === null) return !field.required;
  if (field.type === "boolean")
    return raw === true || raw === false || raw === "true" || raw === "false";
  if (field.type === "number" || field.type === "integer") {
    const value =
      typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
    return (
      Number.isFinite(value) &&
      (field.type !== "integer" || Number.isInteger(value)) &&
      (field.minimum === undefined || value >= field.minimum) &&
      (field.maximum === undefined || value <= field.maximum)
    );
  }
  if (field.type === "multiselect")
    return (
      Array.isArray(raw) &&
      raw.every(
        (value) =>
          typeof value === "string" &&
          (field.allowCustom || question.options.some((option) => option.id === value)),
      ) &&
      raw.length >= (field.minItems ?? (field.required ? 1 : 0)) &&
      raw.length <= (field.maxItems ?? 64)
    );
  if (
    typeof raw !== "string" ||
    raw.length < (field.minLength ?? (field.required ? 1 : 0)) ||
    raw.length > (field.maxLength ?? 24000)
  )
    return false;
  if (!field.allowCustom && !question.options.some((option) => option.id === raw)) return false;
  if (field.format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);
  if (field.format === "uri") {
    try {
      const url = new URL(raw);
      return Boolean(url.protocol);
    } catch {
      return false;
    }
  }
  if (field.format === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
    const value = new Date(`${raw}T00:00:00.000Z`);
    return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === raw;
  }
  if (field.format === "date-time") return Number.isFinite(new Date(raw).getTime());
  return true;
}
