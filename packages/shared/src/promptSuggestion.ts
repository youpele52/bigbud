/**
 * Provider-agnostic prompt suggestion helpers (Phase 7), shared by the server pipeline and the
 * web composer. Pure functions.
 *
 * @module promptSuggestion
 */
import {
  PROMPT_SUGGESTION_ACTIVITY_KIND,
  PROMPT_SUGGESTION_MAX_LENGTH,
  PROMPT_SUGGESTION_MIN_LENGTH,
  PromptSuggestionActivityPayload,
} from "@bigbud/contracts/orchestration/orchestration.promptSuggestion";
import { Schema } from "effect";

import { toBoundedRedactedText } from "./providerRuntime";

/** Tabs, line breaks and Unicode line separators become spaces before collapsing. */
const BREAKING_CODES: ReadonlySet<number> = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0x2028, 0x2029,
]);

/** C0/C1 controls, zero-width characters and bidi controls are removed outright. */
function isInvisibleOrControl(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0x061c ||
    code === 0xfeff
  );
}

function collapse(raw: string): string {
  let cleaned = "";
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    if (BREAKING_CODES.has(code)) cleaned += " ";
    else if (!isInvisibleOrControl(code)) cleaned += char;
  }
  return cleaned.replace(/\s+/gu, " ").trim();
}

export interface NormalizePromptSuggestionOptions {
  /** A suggestion equal to this message (ignoring case and spacing) is dropped. */
  readonly lastUserMessage?: string | undefined;
}

/**
 * One line, no control/zero-width/bidi characters, 15–150 characters after normalization.
 * Out-of-range input is dropped (`null`), never truncated.
 */
export function normalizePromptSuggestion(
  raw: unknown,
  options: NormalizePromptSuggestionOptions = {},
): string | null {
  if (typeof raw !== "string") return null;
  const suggestion = collapse(raw);
  const length = [...suggestion].length;
  if (length < PROMPT_SUGGESTION_MIN_LENGTH || length > PROMPT_SUGGESTION_MAX_LENGTH) return null;
  if (
    options.lastUserMessage !== undefined &&
    collapse(options.lastUserMessage).toLowerCase() === suggestion.toLowerCase()
  ) {
    return null;
  }
  return suggestion;
}

const isPromptSuggestionPayload = Schema.is(PromptSuggestionActivityPayload);

/** The payload of a well-formed `prompt.suggestion` activity, else `null`. */
export function readPromptSuggestionActivity(activity: {
  readonly kind: string;
  readonly payload: unknown;
}): PromptSuggestionActivityPayload | null {
  if (activity.kind !== PROMPT_SUGGESTION_ACTIVITY_KIND) return null;
  return isPromptSuggestionPayload(activity.payload) ? activity.payload : null;
}

/** Transcript text for generated suggestions: common secret forms redacted, then bounded. */
export function redactPromptSuggestionContext(text: string, maxChars: number): string {
  return toBoundedRedactedText(text, { maxChars });
}
