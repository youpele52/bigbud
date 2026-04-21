import { WS_METHODS } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import { createChatViewBrowserTestContext } from "./context";
import { DEFAULT_VIEWPORT } from "./fixtures";
import { createDraftOnlySnapshot, setDraftThreadWithoutWorktree } from "./scenarioFixtures";
import { waitForButtonByText, waitForElement } from "./dom";

const ctx = createChatViewBrowserTestContext();
ctx.registerLifecycleHooks();

async function clickOpenAndExpectEditor(editor: string): Promise<void> {
  const openButton = await waitForButtonByText("Open");
  await vi.waitFor(() => {
    expect(openButton.disabled).toBe(false);
  });
  openButton.click();

  await vi.waitFor(
    () => {
      const openRequest = ctx.wsRequests.find(
        (request) => request._tag === WS_METHODS.shellOpenInEditor,
      );
      expect(openRequest).toMatchObject({
        _tag: WS_METHODS.shellOpenInEditor,
        cwd: "/repo/project",
        editor,
      });
    },
    { timeout: 8_000, interval: 16 },
  );
}

describe("ChatView editor picker integration", () => {
  it("opens the project cwd for draft threads without a worktree path", async () => {
    setDraftThreadWithoutWorktree();
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (fixture) => {
        fixture.serverConfig = { ...fixture.serverConfig, availableEditors: ["vscode"] };
      },
    });

    try {
      await ctx.waitForServerConfigToApply();
      await clickOpenAndExpectEditor("vscode");
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the project cwd with VS Code Insiders when it is the only available editor", async () => {
    setDraftThreadWithoutWorktree();
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (fixture) => {
        fixture.serverConfig = { ...fixture.serverConfig, availableEditors: ["vscode-insiders"] };
      },
    });

    try {
      await ctx.waitForServerConfigToApply();
      await clickOpenAndExpectEditor("vscode-insiders");
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the project cwd with Trae when it is the only available editor", async () => {
    setDraftThreadWithoutWorktree();
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (fixture) => {
        fixture.serverConfig = { ...fixture.serverConfig, availableEditors: ["trae"] };
      },
    });

    try {
      await ctx.waitForServerConfigToApply();
      await clickOpenAndExpectEditor("trae");
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters the open picker menu and opens VSCodium from the menu", async () => {
    setDraftThreadWithoutWorktree();
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (fixture) => {
        fixture.serverConfig = {
          ...fixture.serverConfig,
          availableEditors: ["vscode-insiders", "vscodium"],
        };
      },
    });

    try {
      await ctx.waitForServerConfigToApply();
      const menuButton = await waitForElement<HTMLButtonElement>(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Copy options"]'),
        "Unable to find Open picker button.",
      );
      menuButton.click();

      await waitForElement(
        () =>
          Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find((item) =>
            item.textContent?.includes("VS Code Insiders"),
          ) ?? null,
        "Unable to find VS Code Insiders menu item.",
      );

      expect(
        Array.from(document.querySelectorAll('[data-slot="menu-item"]')).some((item) =>
          item.textContent?.includes("Zed"),
        ),
      ).toBe(false);

      const vscodiumItem = await waitForElement<HTMLElement>(
        () =>
          (Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find((item) =>
            item.textContent?.includes("VSCodium"),
          ) as HTMLElement | undefined) ?? null,
        "Unable to find VSCodium menu item.",
      );
      vscodiumItem.click();

      await vi.waitFor(
        () => {
          const openRequest = ctx.wsRequests.find(
            (request) => request._tag === WS_METHODS.shellOpenInEditor,
          );
          expect(openRequest).toMatchObject({
            _tag: WS_METHODS.shellOpenInEditor,
            cwd: "/repo/project",
            editor: "vscodium",
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to the first installed editor when the stored favorite is unavailable", async () => {
    localStorage.setItem("bigbud:last-editor", JSON.stringify("vscodium"));
    setDraftThreadWithoutWorktree();
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createDraftOnlySnapshot(),
      configureFixture: (fixture) => {
        fixture.serverConfig = { ...fixture.serverConfig, availableEditors: ["vscode-insiders"] };
      },
    });

    try {
      await ctx.waitForServerConfigToApply();
      await clickOpenAndExpectEditor("vscode-insiders");
    } finally {
      await mounted.cleanup();
    }
  });
});
