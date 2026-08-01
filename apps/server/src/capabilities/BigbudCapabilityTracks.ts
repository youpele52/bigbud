import {
  ARCHIVE_THREAD_TOOL_DESCRIPTION,
  BROWSER_TOOL_DESCRIPTION,
  COMPUTER_USE_TOOL_DESCRIPTION,
  CREATE_THREAD_TOOL_DESCRIPTION,
  GET_THREAD_STATUS_TOOL_DESCRIPTION,
  LIST_PINNED_THREADS_TOOL_DESCRIPTION,
  LIST_THREADS_TOOL_DESCRIPTION,
  PIN_THREAD_TOOL_DESCRIPTION,
  RENAME_THREAD_TOOL_DESCRIPTION,
  SEND_THREAD_MESSAGE_TOOL_DESCRIPTION,
  UNPIN_THREAD_TOOL_DESCRIPTION,
} from "../orchestration-tools/threadOrchestrationBridge.shared.ts";
import { AGENT_WORKSPACE_TOOL_SPECS } from "../orchestration-tools/AgentWorkspaceToolSpecs.ts";
import {
  createCapabilityCatalog,
  type CapabilityRisk,
  type CapabilityTrack,
} from "./CapabilityCatalog.ts";

const normalizeBrand = (text: string): string =>
  text.replaceAll("BigBud", "bigbud").replaceAll("Bigbud", "bigbud");

const threadToolTrack = (input: {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly summary?: string;
  readonly triggers: ReadonlyArray<string>;
  readonly risk: CapabilityRisk;
  readonly workflow: string;
  readonly permissions: string;
  readonly examples: ReadonlyArray<string>;
  readonly antiPatterns: ReadonlyArray<string>;
  readonly relatedCapabilityIds?: ReadonlyArray<string>;
}): CapabilityTrack => ({
  id: input.id,
  displayName: input.displayName,
  kind: "bigbud-tool",
  summary: normalizeBrand(input.summary ?? input.description),
  triggers: input.triggers,
  outcome: normalizeBrand(input.description),
  risk: input.risk,
  availability: ["Available when the thread orchestration bridge is configured."],
  prerequisites: ["An active bigbud thread tool session."],
  relatedCapabilityIds: input.relatedCapabilityIds ?? [],
  source: "bigbud orchestration tool definition",
  trust: "bigbud",
  guide: {
    workflow: input.workflow,
    permissions: input.permissions,
    examples: input.examples,
    antiPatterns: input.antiPatterns,
  },
});

export const BIGBUD_CAPABILITY_TRACKS: ReadonlyArray<CapabilityTrack> = [
  ...AGENT_WORKSPACE_TOOL_SPECS.map((spec) =>
    threadToolTrack({
      id: `workspace.${spec.name.replaceAll("_", ".")}`,
      displayName: spec.name.replaceAll("_", " "),
      description: spec.description,
      triggers: ["The task requires working with global or project notes or kanban cards."],
      risk:
        spec.name.startsWith("list_") || spec.name.startsWith("get_")
          ? "read-only"
          : "reversible-write",
      workflow: `Call ${spec.name} with a global item or an item in the current project.`,
      permissions:
        "Restricted to global items and the current thread's project. Other projects and deletion are unavailable.",
      examples: [`Use ${spec.name} for global or current-project workspace items.`],
      antiPatterns: ["Do not attempt deletion or cross-project access."],
    }),
  ),
  threadToolTrack({
    id: "thread.rename",
    displayName: "Rename thread",
    description: RENAME_THREAD_TOOL_DESCRIPTION,
    triggers: ["The user explicitly asks to rename the current thread."],
    risk: "reversible-write",
    workflow: "Call rename_thread with the new title.",
    permissions: "Only the current thread is in scope.",
    examples: ["Rename this thread to Release audit."],
    antiPatterns: ["Do not rename an attached or unrelated thread."],
  }),
  threadToolTrack({
    id: "thread.archive",
    displayName: "Archive thread",
    description: ARCHIVE_THREAD_TOOL_DESCRIPTION,
    triggers: ["The user explicitly asks to archive the current thread."],
    risk: "reversible-write",
    workflow: "Call archive_thread for the current thread.",
    permissions: "Requires an explicit user request.",
    examples: ["Archive this thread."],
    antiPatterns: ["Do not archive a thread merely because its task is complete."],
  }),
  threadToolTrack({
    id: "thread.create",
    displayName: "Create standalone thread",
    description: CREATE_THREAD_TOOL_DESCRIPTION,
    triggers: ["Independent work should run in a standalone thread."],
    risk: "mutating",
    workflow:
      "Call create_thread once with a title and self-contained task. Poll the accepted child with get_thread_status.",
    permissions: "Use another project only when explicitly authorized.",
    examples: ["Create a child thread to investigate the server failure."],
    antiPatterns: [
      "Do not assume the child inherits the parent transcript.",
      "Do not duplicate an accepted child.",
    ],
    relatedCapabilityIds: ["thread.status"],
  }),
  threadToolTrack({
    id: "thread.message.send",
    displayName: "Send thread message",
    description: SEND_THREAD_MESSAGE_TOOL_DESCRIPTION,
    triggers: ["An agent needs to follow up in another thread in the current project."],
    risk: "mutating",
    workflow:
      "Call send_thread_message with the target thread ID and message. Use delivery queue only when explicitly desired.",
    permissions: "The caller and target must exist in the same project.",
    examples: ["Send the audit thread an additional constraint."],
    antiPatterns: ["Do not use this to steer or restart a running provider turn."],
    relatedCapabilityIds: ["thread.status"],
  }),
  threadToolTrack({
    id: "thread.status",
    displayName: "Get thread status",
    description: GET_THREAD_STATUS_TOOL_DESCRIPTION,
    triggers: ["Work depends on another thread finishing.", "A child thread startup is pending."],
    risk: "read-only",
    workflow: "Call get_thread_status with the target thread ID and poll when necessary.",
    permissions: "Read-only within the current project.",
    examples: ["Check whether the delegated audit is complete."],
    antiPatterns: ["Do not infer completion from thread creation acceptance."],
    relatedCapabilityIds: ["thread.create"],
  }),
  threadToolTrack({
    id: "thread.list",
    displayName: "List project threads",
    description: LIST_THREADS_TOOL_DESCRIPTION,
    summary: "List the threads in a bigbud project with their live workflow status.",
    triggers: [
      "The user asks which threads exist in a project.",
      "A thread ID must be discovered before coordinating with another thread.",
    ],
    risk: "read-only",
    workflow:
      "Call list_threads for the current project, then narrow with status or limit. Use get_thread_status for live detail on a single thread.",
    permissions: "Read-only. Returns thread metadata only, never transcripts.",
    examples: ["Show the active threads in this project."],
    antiPatterns: [
      "Do not report a total without checking hasMore; results are capped.",
      "Do not poll this to wait for another thread; use get_thread_status.",
    ],
    relatedCapabilityIds: ["thread.status", "thread.pins.list"],
  }),
  threadToolTrack({
    id: "thread.pins.list",
    displayName: "List pinned threads",
    description: LIST_PINNED_THREADS_TOOL_DESCRIPTION,
    triggers: ["The user asks which threads are pinned."],
    risk: "read-only",
    workflow: "Call list_pinned_threads.",
    permissions: "Read-only, with global thread scope.",
    examples: ["Show my pinned threads."],
    antiPatterns: ["Do not change pin state while listing."],
    relatedCapabilityIds: ["thread.pin", "thread.unpin"],
  }),
  threadToolTrack({
    id: "thread.pin",
    displayName: "Pin thread",
    description: PIN_THREAD_TOOL_DESCRIPTION,
    triggers: ["The user explicitly asks to pin a thread."],
    risk: "reversible-write",
    workflow: "Call pin_thread with the exact thread ID.",
    permissions: "Requires an explicit user request.",
    examples: ["Pin this thread."],
    antiPatterns: ["Do not pin a thread proactively."],
    relatedCapabilityIds: ["thread.unpin", "thread.pins.list"],
  }),
  threadToolTrack({
    id: "thread.unpin",
    displayName: "Unpin thread",
    description: UNPIN_THREAD_TOOL_DESCRIPTION,
    triggers: ["The user explicitly asks to unpin a thread."],
    risk: "reversible-write",
    workflow: "Call unpin_thread with the exact thread ID.",
    permissions: "Requires an explicit user request.",
    examples: ["Unpin this thread."],
    antiPatterns: ["Do not unpin a thread proactively."],
    relatedCapabilityIds: ["thread.pin", "thread.pins.list"],
  }),
  threadToolTrack({
    id: "browser",
    displayName: "In-app browser",
    description: BROWSER_TOOL_DESCRIPTION,
    summary: "Control bigbud's visible or background browser for web navigation and interaction.",
    triggers: ["A task needs web navigation or interaction in bigbud's browser."],
    risk: "mutating",
    workflow: "Choose a visible or background browser target, interact, then release the tab.",
    permissions:
      "Page interactions can create external side effects; match them to the user's request.",
    examples: ["Inspect a signed-in page in the visible browser."],
    antiPatterns: ["Do not close a shared tab unless explicitly asked."],
    relatedCapabilityIds: ["computer.desktop"],
  }),
  threadToolTrack({
    id: "computer.desktop",
    displayName: "Desktop computer use",
    description: COMPUTER_USE_TOOL_DESCRIPTION,
    summary: "Automate native desktop apps and operating-system interactions when enabled.",
    triggers: ["The user requests native desktop app or operating-system interaction."],
    risk: "mutating",
    workflow: "Use surface desktop and inspect permissions when automation fails.",
    permissions: "Mutating actions require full-access runtime mode.",
    examples: ["Open Calendar and inspect today's events."],
    antiPatterns: ["Do not use desktop automation for bigbud's built-in browser."],
    relatedCapabilityIds: ["browser"],
  }),
];

export const BIGBUD_CAPABILITY_CATALOG = createCapabilityCatalog(BIGBUD_CAPABILITY_TRACKS);
