import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  removeInlineTerminalContextPlaceholder,
} from "../../../../lib/terminalContext";
import { useComposerDraftStore } from "../../../../stores/composer";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";

import { createChatViewBrowserTestContext } from "./context";
import {
  DEFAULT_VIEWPORT,
  THREAD_ID,
  createSnapshotForTargetUser,
  createTerminalContext,
} from "./fixtures";
import {
  waitForComposerEditor,
  waitForComposerMenuItem,
  waitForElement,
  waitForInteractionModeButton,
  waitForSendButton,
} from "./dom";

const ctx = createChatViewBrowserTestContext();
ctx.registerLifecycleHooks();

describe("ChatView composer integration", () => {
  it("toggles plan mode with Shift+Tab only while the composer is focused", async () => {
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-target-hotkey" as never,
        targetText: "hotkey target",
      }),
    });

    try {
      const initialModeButton = await waitForInteractionModeButton("Build");
      expect(initialModeButton.title).toContain("enter plan mode");

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect((await waitForInteractionModeButton("Build")).title).toContain("enter plan mode");

      const composerEditor = await waitForComposerEditor();
      composerEditor.focus();
      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(async () => {
        expect((await waitForInteractionModeButton("Plan")).title).toContain(
          "return to normal chat mode",
        );
      });

      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(async () => {
        expect((await waitForInteractionModeButton("Build")).title).toContain("enter plan mode");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps removed terminal context pills removed when a new one is added", async () => {
    const removedLabel = "Terminal 1 lines 1-2";
    const addedLabel = "Terminal 2 lines 9-10";
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_ID,
      createTerminalContext({
        id: "ctx-removed",
        terminalLabel: "Terminal 1",
        lineStart: 1,
        lineEnd: 2,
        text: "bun i\nno changes",
      }),
    );

    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-terminal-pill-backspace" as never,
        targetText: "terminal pill backspace target",
      }),
    });

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain(removedLabel);
      });

      const store = useComposerDraftStore.getState();
      const currentPrompt = store.draftsByThreadId[THREAD_ID]?.prompt ?? "";
      const nextPrompt = removeInlineTerminalContextPlaceholder(currentPrompt, 0);
      store.setPrompt(THREAD_ID, nextPrompt.prompt);
      store.removeTerminalContext(THREAD_ID, "ctx-removed");

      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]).toBeUndefined();
        expect(document.body.textContent).not.toContain(removedLabel);
      });

      useComposerDraftStore.getState().addTerminalContext(
        THREAD_ID,
        createTerminalContext({
          id: "ctx-added",
          terminalLabel: "Terminal 2",
          lineStart: 9,
          lineEnd: 10,
          text: "git status\nOn branch main",
        }),
      );

      await vi.waitFor(() => {
        const draft = useComposerDraftStore.getState().draftsByThreadId[THREAD_ID];
        expect(draft?.terminalContexts.map((context) => context.id)).toEqual(["ctx-added"]);
        expect(document.body.textContent).toContain(addedLabel);
        expect(document.body.textContent).not.toContain(removedLabel);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("disables send when the composer only contains an expired terminal pill", async () => {
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_ID,
      createTerminalContext({
        id: "ctx-expired-only",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "",
      }),
    );

    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-expired-pill-disabled" as never,
        targetText: "expired pill disabled target",
      }),
    });

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain("Terminal 1 line 4");
      });
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(true);
    } finally {
      await mounted.cleanup();
    }
  });

  it("warns when sending text while omitting expired terminal pills", async () => {
    useComposerDraftStore.getState().addTerminalContext(
      THREAD_ID,
      createTerminalContext({
        id: "ctx-expired-send-warning",
        terminalLabel: "Terminal 1",
        lineStart: 4,
        lineEnd: 4,
        text: "",
      }),
    );
    useComposerDraftStore
      .getState()
      .setPrompt(THREAD_ID, `yoo${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}waddup`);

    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-expired-pill-warning" as never,
        targetText: "expired pill warning target",
      }),
    });

    try {
      const sendButton = await waitForSendButton();
      expect(sendButton.disabled).toBe(false);
      sendButton.click();

      await vi.waitFor(() => {
        expect(document.body.textContent).toContain(
          "Expired terminal context omitted from message",
        );
        expect(document.body.textContent).not.toContain("Terminal 1 line 4");
        expect(document.body.textContent).toContain("yoowaddup");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the slash-command menu visible above the composer", async () => {
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-menu-target" as never,
        targetText: "command menu thread",
      }),
    });

    try {
      await waitForComposerEditor();
      await page.getByTestId("composer-editor").fill("/");

      const menuItem = await waitForComposerMenuItem("slash:model");
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );

      await vi.waitFor(() => {
        const menuRect = menuItem.getBoundingClientRect();
        const composerRect = composerForm.getBoundingClientRect();
        const hitTarget = document.elementFromPoint(
          menuRect.left + menuRect.width / 2,
          menuRect.top + menuRect.height / 2,
        );

        expect(menuRect.width).toBeGreaterThan(0);
        expect(menuRect.height).toBeGreaterThan(0);
        expect(menuRect.bottom).toBeLessThanOrEqual(composerRect.bottom);
        expect(hitTarget instanceof Element && menuItem.contains(hitTarget)).toBe(true);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("surrounds the selected composer text when typing an opening delimiter", async () => {
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-surround-selection-target" as never,
        targetText: "surround selection thread",
      }),
    });

    try {
      const composerEditor = await waitForComposerEditor();
      await page.getByTestId("composer-editor").fill("review this change");

      composerEditor.focus();
      const selection = window.getSelection();
      const textNode = composerEditor.firstChild;
      if (!selection || !textNode) {
        throw new Error("Unable to prepare composer selection.");
      }
      selection.removeAllRanges();
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, "review".length);
      selection.addRange(range);

      composerEditor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "(",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      composerEditor.dispatchEvent(
        new InputEvent("beforeinput", {
          inputType: "insertText",
          data: "(",
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
          "(review) this change",
        );
        const selectedText = window.getSelection()?.toString();
        expect(selectedText).toBe("review");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders discovered skill chips when selecting from the $ skill menu", async () => {
    const mounted = await ctx.mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-skill-chip-target" as never,
        targetText: "skill chip thread",
      }),
      configureFixture: (fixture) => {
        fixture.serverConfig = {
          ...fixture.serverConfig,
          discovery: {
            ...fixture.serverConfig.discovery,
            skills: [
              {
                id: "codex:skill:review",
                provider: "codex",
                name: "review",
                source: "project",
                description: "Review the current change before sending it.",
                sourcePath: "/repo/project/.agents/skills/review/SKILL.md",
              },
            ],
          },
        };
      },
    });

    try {
      await waitForComposerEditor();
      await page.getByTestId("composer-editor").fill("$rev");

      const menuItem = await waitForComposerMenuItem("provider-skill:codex:codex:skill:review");
      menuItem.click();

      await vi.waitFor(() => {
        const composer = document.querySelector('[data-testid="composer-editor"]');
        expect(composer?.textContent).toContain("review");
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt).toBe(
          "@skill::review ",
        );
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
