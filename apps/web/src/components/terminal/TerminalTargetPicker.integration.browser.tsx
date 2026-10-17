import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@bigbud/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { useTerminalStateStore } from "../../stores/terminal";
import {
  closeTerminalPanel,
  openTerminalPanel,
} from "../../stores/terminal/terminalPanel.coordinator";
import { readTerminalLaunch } from "../../lib/terminalLaunchBinding";
import { pendingThreadCreations } from "../../lib/threadMaterialization.admission";
import { createChatViewBrowserTestContext } from "../chat/view/ChatView.browser/context";
import { waitForComposerEditor } from "../chat/view/ChatView.browser/dom";
import { DEFAULT_VIEWPORT, THREAD_ID } from "../chat/view/ChatView.browser/fixtures";
import {
  createDraftOnlySnapshot,
  setDraftThreadWithoutWorktree,
} from "../chat/view/ChatView.browser/scenarioFixtures";

const ctx = createChatViewBrowserTestContext();
ctx.registerLifecycleHooks();
afterEach(() => {
  useTerminalStateStore.getState().setTerminalWslDistribution(THREAD_ID, null);
});

it.each(["drawer", "panel"] as const)(
  "%s real picker opens a new WSL viewport while both surfaces keep one canonical no-AI owner",
  async (mode) => {
    setDraftThreadWithoutWorktree();
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      resolveRpc: (body) => {
        if (body._tag === WS_METHODS.terminalWslDistributions)
          return { supported: true, distributions: ["Ubuntu dev"] };
        if (body._tag === WS_METHODS.terminalOpen && body.executionTargetId === "wsl:Ubuntu%20dev")
          return {
            ...(ctx.resolveDefaultRpc(body) as object),
            cwd: "/mapped/project",
            runtimeEnv: { T3CODE_PROJECT_ROOT: "/mapped/project" },
            wslIdentity: { distribution: "Ubuntu dev", username: "alice", uid: 1000 },
          };
        return undefined;
      },
    });
    try {
      await waitForComposerEditor();
      useTerminalStateStore.getState().setTerminalOpen(THREAD_ID, true);
      useTerminalStateStore
        .getState()
        .ensurePanelTerminal(THREAD_ID, "independent-panel", { open: true });
      openTerminalPanel();
      const opens = () => ctx.wsRequests.filter((body) => body._tag === WS_METHODS.terminalOpen);
      // Bootstrap completion precedes route readiness; opening also saves the draft owner first.
      await expect.poll(() => ctx.readServerSnapshot().threads).toHaveLength(1);
      await pendingThreadCreations.get(THREAD_ID);
      await vi.waitFor(() => expect(opens()).toHaveLength(2));
      await vi.waitFor(() =>
        expect(document.querySelectorAll(".thread-terminal-drawer")).toHaveLength(2),
      );
      const terminalId = mode === "drawer" ? "default" : "independent-panel";
      const root = Array.from(
        document.querySelectorAll<HTMLElement>(".thread-terminal-drawer"),
      ).find(
        (element) =>
          Boolean(element.querySelector("[data-terminal-resize-handle]")) === (mode === "drawer"),
      );
      expect(root).toBeDefined();
      const picker = root!.querySelector<HTMLButtonElement>('[aria-label="New terminal target"]');
      expect(picker).not.toBeNull();
      await page.elementLocator(picker!).click();
      await page.getByRole("menuitem", { name: "WSL: Ubuntu dev" }).click();
      expect(useTerminalStateStore.getState().terminalWslDistributionByThreadId[THREAD_ID]).toBe(
        "Ubuntu dev",
      );
      const newButton = root!.querySelector<HTMLButtonElement>('[aria-label^="New Terminal"]');
      expect(newButton).not.toBeNull();
      await page.elementLocator(newButton!).click();
      await vi.waitFor(() => expect(opens()).toHaveLength(3));
      const launched = opens().at(-1)!;
      expect(launched).toMatchObject({
        threadId: THREAD_ID,
        executionTargetId: "wsl:Ubuntu%20dev",
        cwd: "/repo/project",
        env: { T3CODE_PROJECT_ROOT: "/repo/project" },
      });
      expect(launched.terminalId).not.toBe(terminalId);
      await vi.waitFor(() =>
        expect(readTerminalLaunch(THREAD_ID, String(launched.terminalId))?.wslIdentity).toEqual({
          distribution: "Ubuntu dev",
          username: "alice",
          uid: 1000,
        }),
      );
      expect(readTerminalLaunch(THREAD_ID, "default")?.executionTargetId).toBe("local");
      expect(readTerminalLaunch(THREAD_ID, "independent-panel")?.executionTargetId).toBe("local");
      await page
        .elementLocator(
          root!.querySelector<HTMLButtonElement>('[aria-label="New terminal target"]')!,
        )
        .click();
      await expect
        .element(page.getByLabelText("Active terminal target"))
        .toHaveTextContent("Ubuntu dev · alice (uid 1000)");
      await page.getByRole("menuitem", { name: "WSL: Ubuntu dev" }).click();
      await page
        .elementLocator(root!.querySelector<HTMLButtonElement>('[aria-label^="Split Terminal"]')!)
        .click();
      // Moving a single viewport into the split grid reattaches its existing session too.
      await vi.waitFor(() => expect(new Set(opens().map((body) => body.terminalId)).size).toBe(4));
      expect(opens().at(-1)).toMatchObject({
        threadId: THREAD_ID,
        executionTargetId: "wsl:Ubuntu%20dev",
      });
      const commands = ctx.wsRequests.filter(
        (body) => body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand,
      );
      expect(commands.filter((body) => body.type === "thread.create")).toHaveLength(1);
      expect(commands.filter((body) => body.type === "thread.turn.start")).toHaveLength(0);
      expect(ctx.readServerSnapshot().threads).toHaveLength(1);
      expect(ctx.readServerSnapshot().threads[0]).toMatchObject({
        id: THREAD_ID,
        messages: [],
        session: null,
        workspaceExecutionTargetId: "local",
      });
      expect(
        ctx.wsRequests.some((body) =>
          [WS_METHODS.terminalRestart, WS_METHODS.terminalClose, WS_METHODS.terminalWrite].some(
            (method) => body._tag === method,
          ),
        ),
      ).toBe(false);
    } finally {
      closeTerminalPanel();
      await mounted.cleanup();
    }
  },
);
