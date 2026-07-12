import type { BrowserAction, BrowserResult } from "@bigbud/contracts";

import type { ElectronWebview } from "./BrowserPanel.viewport.types";

const PAGE_TEXT_LIMIT = 40_000;

function pageInfo(webview: ElectronWebview) {
  return { url: webview.getURL(), title: webview.getTitle() };
}

function screenshotResult(webview: ElectronWebview): Promise<BrowserResult["screenshot"]> {
  return webview.capturePage().then((image) => {
    const dataUrl = image.toDataURL();
    const match = /^data:(?<mimeType>[^;]+);base64,(?<dataBase64>.+)$/u.exec(dataUrl);
    if (!match?.groups?.mimeType || !match.groups.dataBase64) {
      throw new Error("Failed to encode the visible browser screenshot.");
    }
    return { mimeType: match.groups.mimeType, dataBase64: match.groups.dataBase64 };
  });
}

async function runScript<T>(webview: ElectronWebview, source: string): Promise<T> {
  return webview.executeJavaScript<T>(source, true);
}

export async function executeWebviewAgentAction(
  webview: ElectronWebview,
  action: BrowserAction,
): Promise<BrowserResult> {
  switch (action.action) {
    case "navigate":
      webview.setAttribute("src", action.url);
      return { action: action.action, summary: `Navigating visible browser to ${action.url}.` };
    case "capture":
      return {
        action: action.action,
        summary: "Captured visible browser.",
        page: pageInfo(webview),
        screenshot: await screenshotResult(webview),
      };
    case "click":
      await runScript(
        webview,
        `(() => {
          const element = document.elementFromPoint(${JSON.stringify(action.x)}, ${JSON.stringify(action.y)});
          if (!(element instanceof HTMLElement)) throw new Error("No clickable element at that position.");
          element.click();
        })()`,
      );
      break;
    case "drag":
      await runScript(
        webview,
        `(() => {
          const start = document.elementFromPoint(${JSON.stringify(action.startX)}, ${JSON.stringify(action.startY)});
          const end = document.elementFromPoint(${JSON.stringify(action.endX)}, ${JSON.stringify(action.endY)});
          if (!(start instanceof HTMLElement) || !(end instanceof HTMLElement)) throw new Error("Unable to drag at those positions.");
          start.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: ${JSON.stringify(action.startX)}, clientY: ${JSON.stringify(action.startY)} }));
          end.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: ${JSON.stringify(action.endX)}, clientY: ${JSON.stringify(action.endY)} }));
          end.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: ${JSON.stringify(action.endX)}, clientY: ${JSON.stringify(action.endY)} }));
        })()`,
      );
      break;
    case "scroll":
      await runScript(
        webview,
        `window.scrollBy(${JSON.stringify(action.deltaX ?? 0)}, ${JSON.stringify(action.deltaY ?? 0)});`,
      );
      break;
    case "type":
      await runScript(
        webview,
        `(() => {
          const element = document.activeElement;
          if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLElement && element.isContentEditable)) throw new Error("No editable element is focused.");
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            element.setRangeText(${JSON.stringify(action.text)}, element.selectionStart ?? element.value.length, element.selectionEnd ?? element.value.length, "end");
          } else {
            document.execCommand("insertText", false, ${JSON.stringify(action.text)});
          }
          element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(action.text)} }));
        })()`,
      );
      break;
    case "key":
      await runScript(
        webview,
        `(() => {
          const element = document.activeElement;
          if (!(element instanceof HTMLElement)) throw new Error("No element is focused.");
          element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: ${JSON.stringify(action.key)} }));
          element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: ${JSON.stringify(action.key)} }));
        })()`,
      );
      break;
    case "wait":
      await new Promise<void>((resolve) => setTimeout(resolve, action.durationMs));
      break;
    case "get_page_info":
      return {
        action: action.action,
        summary: "Read visible browser page information.",
        page: pageInfo(webview),
      };
    case "get_page_text": {
      const text = await runScript<string>(
        webview,
        `String(document.body?.innerText ?? "").slice(0, ${PAGE_TEXT_LIMIT})`,
      );
      return { action: action.action, summary: "Read visible browser page text.", text };
    }
    case "go_back":
      webview.goBack();
      break;
    case "go_forward":
      webview.goForward();
      break;
    case "reload":
      webview.reload();
      break;
    case "release_tab":
      return { action: action.action, summary: "Released visible browser tab." };
    case "close_tab":
      return { action: action.action, summary: "Closed visible browser tab." };
  }

  const screenshot = action.captureAfter ? await screenshotResult(webview) : undefined;
  return {
    action: action.action,
    summary: `Executed ${action.action} in visible browser.`,
    page: pageInfo(webview),
    ...(screenshot ? { screenshot } : {}),
  };
}
