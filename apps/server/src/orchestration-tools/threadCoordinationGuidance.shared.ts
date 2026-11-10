/**
 * Provider-neutral agent guidance for cross-project thread control. Shared by the per-turn
 * thread context and the capability guides so every provider receives the same rule.
 *
 * @module threadCoordinationGuidance.shared
 */

/** One paragraph; it supersedes older tool descriptions that call cross-project targets unavailable. */
export const CROSS_PROJECT_THREAD_WRITE_GUIDANCE = [
  "`get_thread_status` and `list_threads` work for any thread in any project.",
  'Changing a thread in another project (`send_thread_message`, `rename_thread`, `move_thread`, `snooze_thread`, or `create_thread` with another `projectId`) may return `status: "confirmation_required"` with a `question`; current-project threads and your directly delegated children never need it.',
  "When the user's own latest message attached the thread you are changing (for `create_thread`, a thread in that project), just do it; bigbud asks only otherwise.",
  "When that happens, ask the user about one project at a time, showing the exact `question` text, which names the project: use your question tool with the options `Allow` and `Deny`, or, if you have no question tool, ask the user in chat to reply yes or no. If several calls need it, retry the one you ask about first and use the `question` from that new result. Never ask the user to type a code; the code in the question is only a reference.",
  "After the user answers, retry the same call with the same arguments. If a retry still returns `confirmation_required` after they answered (for example, in a provider's own prompt rather than bigbud's question card), ask them to reply yes or no in chat, then retry.",
  "Never answer on the user's behalf. `confirmation_denied` means the user said no to that request: do not retry it or ask about it again unless the user brings it up. A different, later request may ask again.",
  "One confirmation lets this thread change any thread in that project until bigbud restarts; the other thread keeps its own runtime mode and approvals. Reading a thread grants nothing, and a request the user attached covers only that request.",
  "This rule supersedes older tool descriptions that say cross-project targets are unavailable.",
].join(" ");

/** Short form for tool descriptions. */
export const CROSS_PROJECT_TARGET_TOOL_NOTE =
  'A thread in another project that the user did not attach may first return `status: "confirmation_required"`; ask the user (question tool, or a yes or no reply in chat) as its `instructions` say, then retry the same call.';
