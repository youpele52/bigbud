import { afterEach, describe, expect, it, vi } from "vitest";

import { focusActiveBrowserLocation, focusContextualChatTarget } from "~/lib/chatFocus";

function addComposer(scope: HTMLElement): HTMLElement {
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  editor.tabIndex = 0;
  editor.dataset.testid = "composer-editor";
  scope.append(editor);
  return editor;
}

function addChatScope(options: { defaultScope?: boolean } = {}): {
  editor: HTMLElement;
  scope: HTMLElement;
} {
  const scope = document.createElement("section");
  scope.dataset.chatFocusScope = "true";
  if (options.defaultScope) scope.dataset.defaultChatFocusScope = "true";
  const editor = addComposer(scope);
  document.body.append(scope);
  return { editor, scope };
}

function addBrowserScope(active: boolean): { input: HTMLInputElement; scope: HTMLElement } {
  const scope = document.createElement("section");
  if (active) scope.dataset.activeBrowserFocusScope = "true";
  const input = document.createElement("input");
  input.dataset.browserOmnibox = "true";
  input.value = "https://bigbud.ai/docs";
  scope.append(input);
  document.body.append(scope);
  return { input, scope };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("contextual chat focus", () => {
  it("focuses the marked default main or compact composer", () => {
    const main = addChatScope({ defaultScope: true });
    expect(focusContextualChatTarget()).toBe(true);
    expect(document.activeElement).toBe(main.editor);

    document.body.innerHTML = "";
    const compact = addChatScope({ defaultScope: true });
    expect(focusContextualChatTarget()).toBe(true);
    expect(document.activeElement).toBe(compact.editor);
  });

  it("focuses the nearest side-chat composer", () => {
    const main = addChatScope({ defaultScope: true });
    const side = addChatScope();
    const sideButton = document.createElement("button");
    side.scope.append(sideButton);
    sideButton.focus();

    expect(focusContextualChatTarget()).toBe(true);
    expect(document.activeElement).toBe(side.editor);
    expect(document.activeElement).not.toBe(main.editor);
  });

  it("keeps chat behavior when the browser is merely open", () => {
    const main = addChatScope({ defaultScope: true });
    addBrowserScope(true);
    const chatButton = document.createElement("button");
    main.scope.append(chatButton);
    chatButton.focus();

    expect(focusContextualChatTarget()).toBe(true);
    expect(document.activeElement).toBe(main.editor);
  });

  it("focuses and selects the active browser omnibox from its focus scope", () => {
    addChatScope({ defaultScope: true });
    const browser = addBrowserScope(true);
    const browserButton = document.createElement("button");
    browser.scope.append(browserButton);
    const selectSpy = vi.spyOn(browser.input, "select");
    browserButton.focus();

    expect(focusContextualChatTarget()).toBe(true);
    expect(document.activeElement).toBe(browser.input);
    expect(selectSpy).toHaveBeenCalledOnce();
  });

  it("excludes hidden browser scopes and targets only the active browser on forwarding", () => {
    const main = addChatScope({ defaultScope: true });
    const hiddenBrowser = addBrowserScope(false);
    hiddenBrowser.input.focus();

    expect(focusContextualChatTarget()).toBe(true);
    expect(document.activeElement).toBe(main.editor);

    const activeBrowser = addBrowserScope(true);
    const selectSpy = vi.spyOn(activeBrowser.input, "select");
    expect(focusActiveBrowserLocation()).toBe(true);
    expect(document.activeElement).toBe(activeBrowser.input);
    expect(selectSpy).toHaveBeenCalledOnce();
  });
});
