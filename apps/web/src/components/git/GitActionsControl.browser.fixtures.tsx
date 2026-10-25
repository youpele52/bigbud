import { ThreadId } from "@bigbud/contracts";
import { useState } from "react";
import { vi } from "vitest";
import GitActionsControl from "./GitActionsControl";

export const THREAD_A = ThreadId.makeUnsafe("thread-a");
export const THREAD_B = ThreadId.makeUnsafe("thread-b");
export const GIT_CWD = "/repo/project";
export const BRANCH_NAME = "feature/toast-scope";
export const branchQueryData = {
  isRepo: true,
  hasOriginRemote: true,
  branches: [
    {
      name: BRANCH_NAME,
      current: true,
      isDefault: false,
      worktreePath: null,
    },
  ],
};

export function findButtonByText(text: string): HTMLButtonElement | null {
  return (Array.from(document.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(text),
  ) ?? null) as HTMLButtonElement | null;
}

export function findMenuTrigger(): HTMLButtonElement | null {
  return (document.querySelector('[aria-label="Quick actions"]') ??
    null) as HTMLButtonElement | null;
}

export function findMenuItemByText(text: string): HTMLElement | null {
  return (Array.from(document.querySelectorAll('[role="menuitem"]')).find((element) =>
    element.textContent?.includes(text),
  ) ?? null) as HTMLElement | null;
}

/** Switch threads without replacing the component that owns the in-flight git action. */
export function Harness() {
  const [activeThreadId, setActiveThreadId] = useState(THREAD_A);

  return (
    <>
      <button type="button" onClick={() => setActiveThreadId(THREAD_B)}>
        Switch thread
      </button>
      <GitActionsControl
        gitCwd={GIT_CWD}
        activeThreadId={activeThreadId}
        onOpenOrchestra={vi.fn()}
      />
    </>
  );
}
