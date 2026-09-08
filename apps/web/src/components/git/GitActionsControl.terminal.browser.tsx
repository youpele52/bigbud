import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { GitActionsControlActions } from "./GitActionsControl.actions";

function findMenuItem(text: string): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (item) => item.textContent?.trim() === text,
    ) ?? null
  );
}

describe("GitActionsControl terminal quick action", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders Open Terminal immediately before tasks and invokes its callback", async () => {
    const onOpenTerminal = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <GitActionsControlActions
        gitCwd={null}
        showGit={false}
        queryClient={new QueryClient()}
        isRepo={false}
        isInitPending={false}
        isGitActionRunning={false}
        hasOriginRemote={false}
        gitStatusForActions={null}
        gitStatusError={null}
        gitActionMenuItems={[]}
        planCardLabel="Tasks"
        planCardOpen={false}
        onMenuItemSelect={vi.fn()}
        onOpenTerminal={onOpenTerminal}
        onTogglePlanCard={vi.fn()}
      />,
      { container: host },
    );

    try {
      document.querySelector<HTMLButtonElement>('[aria-label="Quick actions"]')?.click();
      await vi.waitFor(() => expect(findMenuItem("Open Terminal")).toBeTruthy());

      const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
      const terminalItem = findMenuItem("Open Terminal")!;
      const tasksItem = findMenuItem("Show tasks")!;
      expect(items.indexOf(terminalItem) + 1).toBe(items.indexOf(tasksItem));

      terminalItem.click();
      expect(onOpenTerminal).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps Open Terminal immediately before Hide tasks", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <GitActionsControlActions
        gitCwd={null}
        showGit={false}
        queryClient={new QueryClient()}
        isRepo={false}
        isInitPending={false}
        isGitActionRunning={false}
        hasOriginRemote={false}
        gitStatusForActions={null}
        gitStatusError={null}
        gitActionMenuItems={[]}
        planCardLabel="Tasks"
        planCardOpen
        onMenuItemSelect={vi.fn()}
        onOpenTerminal={vi.fn()}
        onTogglePlanCard={vi.fn()}
      />,
      { container: host },
    );

    try {
      document.querySelector<HTMLButtonElement>('[aria-label="Quick actions"]')?.click();
      await vi.waitFor(() => expect(findMenuItem("Hide tasks")).toBeTruthy());

      const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
      expect(items.indexOf(findMenuItem("Open Terminal")!) + 1).toBe(
        items.indexOf(findMenuItem("Hide tasks")!),
      );
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
