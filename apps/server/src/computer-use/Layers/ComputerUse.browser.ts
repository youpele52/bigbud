import type {
  ComputerUseAction,
  ComputerUsePageInfo,
  ComputerUseResult,
  ComputerUseScreenshot,
  ThreadId,
} from "@bigbud/contracts";
import type {
  BrowserClickInput,
  BrowserManagerShape,
  BrowserScrollInput,
} from "../../browser/Services/BrowserManager.ts";
import { Effect } from "effect";

import { ComputerUseError } from "../Services/ComputerUse.ts";
import { guardComputerUseTarget, isComputerUseMutatingAction } from "../computerUseSafety.ts";

function toBrowserClickInput(
  action: Extract<ComputerUseAction, { action: "click" }>,
): BrowserClickInput {
  return {
    x: action.x,
    y: action.y,
    ...(action.button ? { button: action.button } : {}),
  };
}

function toBrowserScrollInput(
  action: Extract<ComputerUseAction, { action: "scroll" }>,
): BrowserScrollInput {
  return {
    ...(action.deltaX === undefined ? {} : { deltaX: action.deltaX }),
    ...(action.deltaY === undefined ? {} : { deltaY: action.deltaY }),
    ...(action.x === undefined ? {} : { x: action.x }),
    ...(action.y === undefined ? {} : { y: action.y }),
  };
}

function summarizeAction(action: ComputerUseAction, page: ComputerUsePageInfo): string {
  switch (action.action) {
    case "capture":
      return `Captured the current page at ${page.url}.`;
    case "navigate":
      return `Navigated the browser to ${page.url}.`;
    case "click":
      return `Clicked ${action.button ?? "left"} at (${Math.round(action.x)}, ${Math.round(action.y)}).`;
    case "drag":
      return `Dragged from (${Math.round(action.startX)}, ${Math.round(action.startY)}) to (${Math.round(action.endX)}, ${Math.round(action.endY)}).`;
    case "scroll":
      return `Scrolled the page by (${Math.round(action.deltaX ?? 0)}, ${Math.round(action.deltaY ?? 0)}).`;
    case "type":
      return `Typed ${JSON.stringify(action.text)} into the active page.`;
    case "key":
      return `Pressed ${action.key}.`;
    case "wait":
      return `Waited ${action.durationMs}ms.`;
    case "get_page_info":
      return `Read the current page info for ${page.url}.`;
    default:
      return `Executed ${action.action} on the browser surface.`;
  }
}

const withBrowserPage = (
  browser: BrowserManagerShape,
  threadId: ThreadId,
  action: ComputerUseAction,
): Effect.Effect<
  {
    readonly page: ComputerUsePageInfo;
    readonly screenshot?: ComputerUseScreenshot;
  },
  ComputerUseError
> =>
  Effect.gen(function* () {
    yield* browser.launch(threadId).pipe(Effect.mapError((cause) => new ComputerUseError(cause)));

    if (action.action !== "navigate" && isComputerUseMutatingAction(action)) {
      const currentPageInfo = yield* browser
        .getPageInfo(threadId)
        .pipe(Effect.mapError((cause) => new ComputerUseError(cause)));
      const safetyViolation = guardComputerUseTarget({
        action,
        surface: "browser",
        url: currentPageInfo.url,
      });
      if (safetyViolation) {
        return yield* new ComputerUseError({ message: safetyViolation });
      }
    }

    switch (action.action) {
      case "capture":
        break;
      case "navigate":
        yield* browser
          .navigate(threadId, action.url)
          .pipe(Effect.mapError((cause) => new ComputerUseError(cause)));
        break;
      case "click":
        yield* browser
          .click(threadId, toBrowserClickInput(action))
          .pipe(Effect.mapError((cause) => new ComputerUseError(cause)));
        break;
      case "drag":
        yield* browser
          .drag(threadId, action)
          .pipe(Effect.mapError((cause) => new ComputerUseError(cause)));
        break;
      case "scroll":
        yield* browser
          .scroll(threadId, toBrowserScrollInput(action))
          .pipe(Effect.mapError((cause) => new ComputerUseError(cause)));
        break;
      case "type":
        yield* browser
          .typeText(threadId, action.text)
          .pipe(Effect.mapError((cause) => new ComputerUseError(cause)));
        break;
      case "key":
        yield* browser
          .keyPress(threadId, action.key)
          .pipe(Effect.mapError((cause) => new ComputerUseError(cause)));
        break;
      case "wait":
        yield* browser
          .wait(threadId, action.durationMs)
          .pipe(Effect.mapError((cause) => new ComputerUseError(cause)));
        break;
      case "get_page_info":
        break;
      default:
        return yield* new ComputerUseError({
          message: `Action '${action.action}' is not supported on the browser surface.`,
        });
    }

    const pageInfo = yield* browser
      .getPageInfo(threadId)
      .pipe(Effect.mapError((cause) => new ComputerUseError(cause)));
    const shouldCapture =
      action.action === "capture" ||
      (action.action !== "get_page_info" &&
        "captureAfter" in action &&
        action.captureAfter === true);
    if (!shouldCapture) {
      return {
        page: {
          url: pageInfo.url,
          title: pageInfo.title,
        },
      };
    }

    const screenshot = yield* browser
      .screenshot(threadId)
      .pipe(Effect.mapError((cause) => new ComputerUseError(cause)));
    return {
      page: {
        url: pageInfo.url,
        title: pageInfo.title,
      },
      screenshot: {
        mimeType: screenshot.mimeType,
        dataBase64: Buffer.from(screenshot.data).toString("base64"),
      },
    };
  });

export const executeBrowserComputerUse = (
  browser: BrowserManagerShape,
  threadId: ThreadId,
  action: ComputerUseAction,
): Effect.Effect<ComputerUseResult, ComputerUseError> =>
  Effect.gen(function* () {
    const result = yield* withBrowserPage(browser, threadId, action);
    return {
      surface: "browser",
      action: action.action,
      summary: summarizeAction(action, result.page),
      page: result.page,
      ...(result.screenshot ? { screenshot: result.screenshot } : {}),
    } satisfies ComputerUseResult;
  });
