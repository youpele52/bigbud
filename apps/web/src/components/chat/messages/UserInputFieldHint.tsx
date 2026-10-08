import type { UserInputQuestion } from "@bigbud/contracts";

/** Show native constraints before the composer accepts an answer; legacy questions remain unchanged. */
export function UserInputFieldHint({ question }: { question: UserInputQuestion }) {
  const field = question.field;
  if (!field) return null;
  const hints = [field.required ? "Required" : "Optional — leave blank to skip", field.type];
  if (!field.allowCustom && question.options.length) hints.push("Choose from the listed options");
  if (field.minimum !== undefined) hints.push(`minimum ${field.minimum}`);
  if (field.maximum !== undefined) hints.push(`maximum ${field.maximum}`);
  if (field.minLength !== undefined) hints.push(`at least ${field.minLength} characters`);
  if (field.maxLength !== undefined) hints.push(`at most ${field.maxLength} characters`);
  if (field.minItems !== undefined) hints.push(`at least ${field.minItems} selections`);
  if (field.maxItems !== undefined) hints.push(`at most ${field.maxItems} selections`);
  if (field.format) hints.push(field.format);
  if (field.type === "multiselect" && field.allowCustom)
    hints.push(
      'Custom entries: enter a JSON string array, e.g. ["a", "b"]. Combined with selected options; commas/newlines inside entries are not split.',
    );
  return <p className="mb-1.5 text-xs text-muted-foreground">{hints.join(" · ")}</p>;
}
