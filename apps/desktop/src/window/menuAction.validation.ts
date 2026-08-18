import type {
  CompactChatLinkHandoff,
  DesktopMenuAction,
  DesktopRendererReadyAction,
} from "@bigbud/contracts/server/ipc.ts";

export const MAX_COMPACT_LINK_THREAD_ID_LENGTH = 256;
export const MAX_COMPACT_LINK_HREF_LENGTH = 8_192;
export const MAX_COMPACT_LINK_WORKSPACE_ROOT_LENGTH = 4_096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBoundedNonEmptyString(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximumLength;
}

export function isCompactChatLinkHandoff(value: unknown): value is CompactChatLinkHandoff {
  if (!isRecord(value) || value.type !== "compact-chat-link") {
    return false;
  }

  return (
    isBoundedNonEmptyString(value.threadId, MAX_COMPACT_LINK_THREAD_ID_LENGTH) &&
    isBoundedNonEmptyString(value.href, MAX_COMPACT_LINK_HREF_LENGTH) &&
    (value.workspaceRoot === null ||
      isBoundedNonEmptyString(value.workspaceRoot, MAX_COMPACT_LINK_WORKSPACE_ROOT_LENGTH))
  );
}

export function isDesktopRendererReadyAction(value: unknown): value is DesktopRendererReadyAction {
  return isRecord(value) && value.type === "desktop-renderer-ready" && value.role === "main";
}

export function isDesktopMenuAction(value: unknown): value is DesktopMenuAction {
  return (
    typeof value === "string" ||
    isCompactChatLinkHandoff(value) ||
    isDesktopRendererReadyAction(value)
  );
}
