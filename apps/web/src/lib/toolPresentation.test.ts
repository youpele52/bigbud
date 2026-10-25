import { describe, expect, it } from "vitest";

import { formatBigbudToolName, formatToolDisplayName } from "./toolPresentation";

describe("bigbud tool presentation", () => {
  it.each([
    "bigbud_thread_v1_rename_thread",
    "Bigbud_thread_v1_rename_thread",
    "BIGBUD_THREAD_V2_RENAME_THREAD",
    "bigbud_thread_rename_thread",
    "mcp__bigbud_thread_v1__rename_thread",
    "mcp__bigbud_orchestration__rename_thread",
    "mcp__bigbud_orchestration_thread-1__rename_thread",
    "bigbud_orchestration_thread-1_rename_thread",
    "bigbud_orchestration: rename_thread",
    "bigbud_orchestration.rename_thread",
  ])("shows a lowercase friendly label without mutating %s", (raw) => {
    expect(formatBigbudToolName(raw)).toBe("bigbud renamer");
    expect(formatToolDisplayName(raw)).toBe("bigbud renamer");
    expect(JSON.parse(JSON.stringify({ toolName: raw })).toolName).toBe(raw);
  });

  it.each([
    ["create_thread", "thread creator"],
    ["archive_thread", "thread archiver"],
    ["get_thread_status", "thread status reader"],
    ["send_thread_message", "thread messenger"],
    ["list_threads", "thread lister"],
    ["list_pinned_threads", "pinned thread lister"],
    ["pin_thread", "thread pinner"],
    ["unpin_thread", "thread unpinner"],
    ["list_available_models", "model lister"],
    ["get_system_resources", "system resource reader"],
    ["search_capabilities", "capability finder"],
    ["read_capability_guide", "capability guide reader"],
    ["browser", "browser"],
    ["computer_use", "computer controller"],
    ["list_notes", "note lister"],
    ["get_note", "note reader"],
    ["create_note", "note creator"],
    ["update_note", "note updater"],
    ["list_kanban_cards", "kanban card lister"],
    ["get_kanban_card", "kanban card reader"],
    ["create_kanban_card", "kanban card creator"],
    ["update_kanban_card", "kanban card updater"],
    ["move_kanban_card", "kanban card mover"],
    ["reorder_kanban_card", "kanban card reorderer"],
    ["update_plan", "plan updater"],
  ])("labels the %s orchestration action", (action, label) => {
    expect(formatToolDisplayName(`mcp__bigbud_orchestration__${action}`)).toBe(`bigbud ${label}`);
  });

  it.each([
    ["bigbud_read", "bigbud file reader"],
    ["bigbud_list", "bigbud directory lister"],
    ["bigbud_write", "bigbud file writer"],
    ["bigbud_edit", "bigbud file editor"],
    ["bigbud_shell", "bigbud shell"],
    ["bigbud_skill", "bigbud skill reader"],
    ["bigbud_check", "bigbud workspace checker"],
    ["bigbud_orchestration", "bigbud orchestrator"],
    ["mcp__bigbud_remote_workspace__read", "bigbud remote file reader"],
    ["bigbud_remote_workspace_apply_patch", "bigbud remote patch applier"],
    ["bigbud_remote_workspace: bash", "bigbud remote shell"],
    ["bigbud_remote_workspace.glob", "bigbud remote file finder"],
    ["bigbud_remote_workspace_grep", "bigbud remote content finder"],
  ])("labels broker tools without hiding remote scope: %s", (raw, expected) => {
    expect(formatToolDisplayName(raw)).toBe(expected);
  });

  it.each([
    "bigbud_thread_v1_future_tool",
    "mcp__bigbud_orchestration__future_tool",
    "bigbud_remote_workspace_future_tool",
    "bigbud_thread_v1_constructor",
    "bigbud_future_tool",
    "mcp__bigbud_future__tool",
  ])("uses a safe generic label for unknown owned tool %s", (raw) => {
    expect(formatToolDisplayName(raw)).toBe("bigbud tool");
  });

  it.each([
    "rename_thread",
    "Read",
    "readFile",
    "mcp__other__rename_thread",
    "other_bigbud_thread_v1_rename_thread",
    "mcp__other__bigbud_thread_v1_rename_thread",
    "Bigbud_orchestrations: rename_thread",
    "inspect bigbud_thread_v1_rename_thread",
    "bigbud_orchestration is Running",
    "bigbud_thread_v1_rename_thread --unsafe",
  ])("leaves other tool names and prose unchanged: %s", (raw) => {
    expect(formatBigbudToolName(raw)).toBeNull();
    expect(formatToolDisplayName(raw)).toBe(raw);
  });
});
