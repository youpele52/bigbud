export const PI_ASK_USER_TOOL_NAME = "ask_user";

export const PI_ASK_USER_TOOL_DESCRIPTION =
  "Ask the user a question in bigbud's question panel and wait for the answer. Pass options for a choice (the user picks one) or omit them for a free-text answer. A question with options is always single-choice: never word it as \"select all that apply\" or ask for several picks; to collect several, omit options and ask for a list, or ask one question per item. Use it for decisions you cannot settle from context or reasonable assumptions, and whenever a bigbud tool result asks for the user's confirmation (pass its question and options exactly); ask one question per call. Never ask questions through render_html or plain chat text when this tool is available.";

/**
 * Pi has no built-in way for the model to ask the user. This tool opens Pi's own extension
 * dialogs (`ctx.ui.select` / `ctx.ui.input`), which the bigbud Pi adapter already renders as a
 * native question and answers over RPC. Pi dialogs are single-choice, so there is no multi-select.
 * Relies on the bridge's `defineTool`, `Type`, and `textResult`.
 */
export function renderPiAskUserToolSource(): string {
  return [
    "const askUserTool = defineTool({",
    `  name: ${JSON.stringify(PI_ASK_USER_TOOL_NAME)},`,
    `  label: ${JSON.stringify(PI_ASK_USER_TOOL_NAME)},`,
    `  description: ${JSON.stringify(PI_ASK_USER_TOOL_DESCRIPTION)},`,
    "  parameters: Type.Object({",
    '    question: Type.String({ minLength: 1, description: "The question, phrased for the user." }),',
    "    options: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {",
    "      maxItems: 12,",
    '      description: "Choices to pick from. Omit for a free-text answer.",',
    "    })),",
    "  }),",
    "  async execute(_toolCallId, { question, options }, signal, _onUpdate, ctx) {",
    "    if (!ctx?.hasUI) {",
    "      return textResult('No user interface is attached. Make a reasonable assumption and state it.');",
    "    }",
    "    const title = String(question ?? '').trim();",
    "    const choices = [...new Set((Array.isArray(options) ? options : []).map((option) => String(option).trim()).filter(Boolean))];",
    "    const dialog = signal ? { signal } : undefined;",
    "    const answer = choices.length > 0",
    "      ? await ctx.ui.select(title, choices, dialog)",
    "      : await ctx.ui.input(title, undefined, dialog);",
    "    return textResult(",
    "      answer === undefined || answer === ''",
    "        ? 'The user dismissed the question without answering.'",
    "        : `The user answered: ${answer}`,",
    "    );",
    "  },",
    "});",
  ].join("\n");
}
