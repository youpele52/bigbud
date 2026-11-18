import { Schema } from "effect";

import {
  isThreadCoordinationRefusal,
  type ThreadCoordinationRefusal,
} from "./ThreadCoordinationConfirmation.result.ts";

/** The v1 text, frozen in OpenCode V2's bootstrap ABI; the live text below supersedes it. */
export const FROZEN_V1_TARGET_THREAD_ID_DESCRIPTION =
  "Optional canonical thread ID; omit for the current thread. Only explicitly requested current-project threads or directly delegated children are eligible.";

/** Live `targetThreadId` text, shared by rename and Inyosira organization tools. */
export const TARGET_THREAD_ID_DESCRIPTION =
  "Optional canonical thread ID; omit for the current thread. Only an explicitly requested thread is eligible; a thread in another project may first need the user's confirmation.";

export const RENAME_THREAD_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    title: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description: "New canonical thread title",
    },
    targetThreadId: {
      type: "string",
      minLength: 1,
      description: TARGET_THREAD_ID_DESCRIPTION,
    },
  },
  required: ["title"],
  additionalProperties: false,
} as const;

export const RenameThreadArguments = Schema.Struct({
  title: Schema.String,
  targetThreadId: Schema.optional(Schema.String),
});

/**
 * Model-facing rename text for in-process bridges. A cross-project confirmation refusal is
 * printed as its JSON payload (the same shape the HTTP route returns, minus `ok`).
 */
export function formatRenameThreadToolResult(
  result: { readonly title: string } | ThreadCoordinationRefusal,
  fallbackTitle: string,
): string {
  return isThreadCoordinationRefusal(result)
    ? JSON.stringify(result, null, 2)
    : `Renamed thread to "${result.title ?? fallbackTitle}".`;
}

/** The same formatting for generated bridge sources, as `renameThreadResultText(result, title)`. */
export function renderRenameThreadResultTextSource(): string {
  return [
    "function renameThreadResultText(result, title) {",
    "  if (result && (result.status === 'confirmation_required' || result.status === 'confirmation_denied')) {",
    "    const { ok: _ok, ...payload } = result;",
    "    return JSON.stringify(payload, null, 2);",
    "  }",
    '  return `Renamed thread to "${result?.title ?? title}".`;',
    "}",
  ].join("\n");
}
