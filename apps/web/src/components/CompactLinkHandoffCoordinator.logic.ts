import type { CompactChatLinkHandoff } from "@bigbud/contracts/server/ipc.ts";
import { defaultUrlTransform } from "react-markdown";

import { resolveMarkdownFileLinkTarget, rewriteMarkdownFileUriHref } from "~/utils/markdown";

export function resolveCompactLinkWorkspaceRoot(
  handoff: CompactChatLinkHandoff,
  fallbackWorkspaceRoot: string | undefined,
): string | undefined {
  return handoff.workspaceRoot ?? fallbackWorkspaceRoot;
}

export async function handleCompactLinkHandoff(input: {
  action: CompactChatLinkHandoff;
  navigateToThread: (threadId: string) => Promise<void>;
  workspaceRoot: () => string | undefined;
  isCurrent: () => boolean;
  openFile: (targetPath: string, workspaceRoot: string | undefined) => void;
  openBrowser: (url: string) => void;
}): Promise<void> {
  await input.navigateToThread(input.action.threadId);
  if (!input.isCurrent()) return;

  const href =
    rewriteMarkdownFileUriHref(input.action.href) ?? defaultUrlTransform(input.action.href);
  if (!href) return;

  const workspaceRoot = input.workspaceRoot();
  const targetPath = resolveMarkdownFileLinkTarget(href, workspaceRoot);
  if (targetPath) {
    input.openFile(targetPath, workspaceRoot);
  } else {
    input.openBrowser(href);
  }
}
