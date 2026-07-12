import type { BrowserAction, BrowserResult, ThreadId } from "@bigbud/contracts";
import { Effect } from "effect";

import type { BrowserManagerShape } from "../browser/Services/BrowserManager.ts";

function summarize(action: BrowserAction): string {
  switch (action.action) {
    case "capture":
      return "Captured the in-app browser.";
    case "navigate":
      return `Navigated the in-app browser to ${action.url}.`;
    case "click":
      return `Clicked the in-app browser at (${Math.round(action.x)}, ${Math.round(action.y)}).`;
    case "drag":
      return "Dragged in the in-app browser.";
    case "scroll":
      return "Scrolled the in-app browser.";
    case "type":
      return "Typed in the in-app browser.";
    case "key":
      return `Pressed ${action.key} in the in-app browser.`;
    case "wait":
      return `Waited ${action.durationMs}ms for the in-app browser.`;
    case "get_page_info":
      return "Read in-app browser page info.";
    case "get_page_text":
      return "Read in-app browser page text.";
    case "go_back":
      return "Went back in the in-app browser.";
    case "go_forward":
      return "Went forward in the in-app browser.";
    case "reload":
      return "Reloaded the in-app browser.";
    case "release_tab":
      return "Released the in-app browser tab.";
    case "close_tab":
      return "Closed the in-app browser tab.";
  }
}

const toScreenshot = (screenshot: { readonly data: Uint8Array; readonly mimeType: string }) => ({
  dataBase64: Buffer.from(screenshot.data).toString("base64"),
  mimeType: screenshot.mimeType,
});

export const browserViaOrchestration = Effect.fn("browserViaOrchestration")(function* (input: {
  readonly browser: BrowserManagerShape;
  readonly threadId: ThreadId;
  readonly action: BrowserAction;
}) {
  yield* input.browser.launch(input.threadId);

  let page: BrowserResult["page"];
  switch (input.action.action) {
    case "navigate":
      page = yield* input.browser.navigate(input.threadId, input.action.url);
      break;
    case "click":
      yield* input.browser.click(input.threadId, {
        x: input.action.x,
        y: input.action.y,
        ...(input.action.button ? { button: input.action.button } : {}),
      });
      break;
    case "drag":
      yield* input.browser.drag(input.threadId, input.action);
      break;
    case "scroll":
      yield* input.browser.scroll(input.threadId, {
        ...(input.action.deltaX !== undefined ? { deltaX: input.action.deltaX } : {}),
        ...(input.action.deltaY !== undefined ? { deltaY: input.action.deltaY } : {}),
        ...(input.action.x !== undefined ? { x: input.action.x } : {}),
        ...(input.action.y !== undefined ? { y: input.action.y } : {}),
      });
      break;
    case "type":
      yield* input.browser.typeText(input.threadId, input.action.text);
      break;
    case "key":
      yield* input.browser.keyPress(input.threadId, input.action.key);
      break;
    case "wait":
      yield* input.browser.wait(input.threadId, input.action.durationMs);
      break;
    case "get_page_info":
      page = yield* input.browser.getPageInfo(input.threadId);
      break;
    case "get_page_text":
      return {
        action: input.action.action,
        summary: summarize(input.action),
        text: yield* input.browser.getPageText(input.threadId),
        target: "background",
      } satisfies BrowserResult;
    case "go_back":
      page = yield* input.browser.goBack(input.threadId);
      break;
    case "go_forward":
      page = yield* input.browser.goForward(input.threadId);
      break;
    case "reload":
      page = yield* input.browser.reload(input.threadId);
      break;
    case "release_tab":
    case "close_tab":
      return {
        action: input.action.action,
        summary: summarize(input.action),
        target: "background",
      } satisfies BrowserResult;
  }

  const shouldCapture =
    input.action.action === "capture" ||
    ("captureAfter" in input.action && input.action.captureAfter === true);
  const screenshot = shouldCapture
    ? toScreenshot(yield* input.browser.screenshot(input.threadId))
    : undefined;
  return {
    action: input.action.action,
    summary: summarize(input.action),
    ...(page ? { page } : {}),
    ...(screenshot ? { screenshot } : {}),
    target: "background",
  } satisfies BrowserResult;
});
