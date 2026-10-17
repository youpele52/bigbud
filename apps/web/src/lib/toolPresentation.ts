const TOOL_LABELS: Readonly<Record<string, string>> = {
  rename_thread: "renamer",
  create_thread: "thread creator",
  archive_thread: "thread archiver",
  get_thread_status: "thread status reader",
  send_thread_message: "thread messenger",
  list_threads: "thread lister",
  list_pinned_threads: "pinned thread lister",
  pin_thread: "thread pinner",
  unpin_thread: "thread unpinner",
  list_available_models: "model lister",
  get_system_resources: "system resource reader",
  search_capabilities: "capability finder",
  read_capability_guide: "capability guide reader",
  browser: "browser",
  computer_use: "computer controller",
  list_notes: "note lister",
  get_note: "note reader",
  create_note: "note creator",
  update_note: "note updater",
  list_kanban_cards: "kanban card lister",
  get_kanban_card: "kanban card reader",
  create_kanban_card: "kanban card creator",
  update_kanban_card: "kanban card updater",
  move_kanban_card: "kanban card mover",
  reorder_kanban_card: "kanban card reorderer",
  update_plan: "plan updater",
  read: "file reader",
  list: "directory lister",
  write: "file writer",
  edit: "file editor",
  apply_patch: "patch applier",
  bash: "shell",
  shell: "shell",
  grep: "content finder",
  glob: "file finder",
  skill: "skill reader",
  check: "workspace checker",
  orchestration: "orchestrator",
};

const TOOL_ACTIONS = Object.keys(TOOL_LABELS).toSorted((left, right) => right.length - left.length);
const CODING_TOOL = /^bigbud_(read|list|write|edit|skill|check|shell|orchestration)$/i;
const NAMESPACED_TOOL =
  /^(?:mcp__)?(bigbud_thread(?:_v\d+)?|bigbud_orchestration|bigbud_remote_workspace)(?:(?:__|_|:\s*|\.)([a-z0-9][a-z0-9_-]*))?$/i;

/** UI labels only. Never use this formatter for dispatch, telemetry, persisted data or raw copy. */
export function formatBigbudToolName(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  const coding = CODING_TOOL.exec(normalized);
  if (coding) return `bigbud ${TOOL_LABELS[coding[1]!]}`;
  const match = NAMESPACED_TOOL.exec(normalized);
  if (!match) return /^(?:mcp__)?bigbud_[a-z][a-z0-9_]*$/.test(normalized) ? "bigbud tool" : null;
  const namespace = match[1]!;
  const action = match[2];
  if (!action) return "bigbud tool";
  let label = Object.hasOwn(TOOL_LABELS, action) ? TOOL_LABELS[action] : undefined;
  // Legacy OpenCode registers one orchestration MCP server per thread and flattens its name.
  if (!label && namespace === "bigbud_orchestration") {
    const scopedAction = TOOL_ACTIONS.find((name) => action.endsWith(`_${name}`));
    if (scopedAction) label = TOOL_LABELS[scopedAction];
  }
  if (!label) return "bigbud tool";
  return `bigbud ${namespace === "bigbud_remote_workspace" ? "remote " : ""}${label}`;
}

/** Preserve other providers' exact tool labels rather than guessing ownership from a substring. */
export function formatToolDisplayName(value: string): string {
  return formatBigbudToolName(value) ?? value;
}
