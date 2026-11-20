const ACTIVE_BROWSER_SCOPE_SELECTOR = '[data-active-browser-focus-scope="true"]';
const BROWSER_OMNIBOX_SELECTOR = 'input[data-browser-omnibox="true"]';
const CHAT_SCOPE_SELECTOR = '[data-chat-focus-scope="true"]';
const DEFAULT_CHAT_SCOPE_SELECTOR = '[data-default-chat-focus-scope="true"]';
const COMPOSER_EDITOR_SELECTOR = '[data-testid="composer-editor"]';
const MODAL_SELECTOR = '[data-slot="dialog-popup"], [data-slot="alert-dialog-popup"]';
const TEXT_ENTRY_SELECTOR = "input, textarea, select";

function focusElement(documentRef: Document, element: HTMLElement | null): boolean {
  if (!element || !element.isConnected) return false;
  element.focus();
  return documentRef.activeElement === element;
}

function focusComposerInScope(documentRef: Document, scope: Element | null): boolean {
  const editor = scope?.querySelector<HTMLElement>(COMPOSER_EDITOR_SELECTOR) ?? null;
  return focusElement(documentRef, editor);
}

export function focusActiveBrowserLocation(documentRef: Document = document): boolean {
  const browserScope = documentRef.querySelector<HTMLElement>(ACTIVE_BROWSER_SCOPE_SELECTOR);
  const omnibox = browserScope?.querySelector<HTMLInputElement>(BROWSER_OMNIBOX_SELECTOR) ?? null;
  if (!focusElement(documentRef, omnibox)) return false;
  omnibox?.select();
  return true;
}

export function focusContextualChatTarget(documentRef: Document = document): boolean {
  const activeElement = documentRef.activeElement;
  const activeBrowserScope = activeElement?.closest(ACTIVE_BROWSER_SCOPE_SELECTOR) ?? null;
  if (activeBrowserScope) {
    const omnibox = activeBrowserScope.querySelector<HTMLInputElement>(BROWSER_OMNIBOX_SELECTOR);
    if (!focusElement(documentRef, omnibox)) return false;
    omnibox?.select();
    return true;
  }

  const focusedChatScope = activeElement?.closest(CHAT_SCOPE_SELECTOR) ?? null;
  if (focusedChatScope && focusComposerInScope(documentRef, focusedChatScope)) return true;

  const defaultChatScope = documentRef.querySelector(DEFAULT_CHAT_SCOPE_SELECTOR);
  return focusComposerInScope(documentRef, defaultChatScope);
}

export function hasOpenChatModal(documentRef: Document = document): boolean {
  return documentRef.querySelector(MODAL_SELECTOR) !== null;
}

/** The chat focus scope that contains `element`, if any. */
export function closestChatScope(element: Element | null): Element | null {
  return element?.closest(CHAT_SCOPE_SELECTOR) ?? null;
}

/**
 * The chat scope a keyboard shortcut acts on: the focused chat scope, otherwise the default chat
 * scope unless the user is typing into an unrelated field elsewhere.
 */
export function resolveKeyboardChatScope(documentRef: Document = document): Element | null {
  const activeElement = documentRef.activeElement;
  const focusedChatScope = closestChatScope(activeElement);
  if (focusedChatScope) return focusedChatScope;
  if (
    activeElement instanceof HTMLElement &&
    (activeElement.isContentEditable || activeElement.matches(TEXT_ENTRY_SELECTOR))
  ) {
    return null;
  }
  return documentRef.querySelector(DEFAULT_CHAT_SCOPE_SELECTOR);
}
