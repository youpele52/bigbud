const ACTIVE_BROWSER_SCOPE_SELECTOR = '[data-active-browser-focus-scope="true"]';
const BROWSER_OMNIBOX_SELECTOR = 'input[data-browser-omnibox="true"]';
const CHAT_SCOPE_SELECTOR = '[data-chat-focus-scope="true"]';
const DEFAULT_CHAT_SCOPE_SELECTOR = '[data-default-chat-focus-scope="true"]';
const COMPOSER_EDITOR_SELECTOR = '[data-testid="composer-editor"]';

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
