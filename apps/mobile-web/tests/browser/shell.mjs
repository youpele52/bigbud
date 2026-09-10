// Run with: node apps/mobile-web/tests/browser/shell.mjs
// Direct mobile route, router-owned sheet history, and mounted conversation smoke check.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "../../../web/node_modules/playwright/index.mjs";
import { session, snapshot, thread } from "./recovery.fixture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const server = await createServer({
  root,
  configFile: `${root}vite.config.ts`,
  server: { host: "127.0.0.1", port: 15744, strictPort: true },
});
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

function sendExit(ws, request, value) {
  ws.send(
    JSON.stringify({ _tag: "Exit", requestId: request.id, exit: { _tag: "Success", value } }),
  );
}

await page.routeWebSocket("**/mobile-ws?*", (ws) => {
  ws.onMessage((message) => {
    const request = JSON.parse(String(message));
    if (request._tag !== "Request") return;
    if (request.tag === "mobile.recovery.getBaseline") {
      sendExit(ws, request, {
        version: 1,
        recoveryAttemptId: request.payload.recoveryAttemptId,
        serverEpoch: "shell-epoch",
        snapshotSequence: 0,
        snapshot,
        selectedThread: { status: "present", thread },
      });
    } else if (request.tag === "mobile.recovery.subscribe") {
      ws.send(
        JSON.stringify({
          _tag: "Chunk",
          requestId: request.id,
          values: [
            {
              version: 1,
              route: "direct-unmanaged",
              serverEpoch: "shell-epoch",
              recoveryAttemptId: request.payload.recoveryAttemptId,
              type: "caught-up",
              throughSequence: 0,
            },
          ],
        }),
      );
    }
  });
});

await page.addInitScript(
  (value) => localStorage.setItem("bigbud:mobile-web:session:v1", JSON.stringify(value)),
  session,
);

try {
  await page.goto("http://127.0.0.1:15744/mobile/thread/thread-recovery");
  const textarea = page.locator("textarea");
  await textarea.waitFor({ timeout: 60_000 });
  assert.equal(await page.evaluate(() => location.pathname), "/mobile/thread/thread-recovery");
  await textarea.fill("draft remains mounted");

  const openChats = page.getByRole("button", { name: /Open Chats/ });
  const transcript = page.locator('[data-mobile-transcript="true"]');
  const composer = page.locator('[data-mobile-composer="true"]');
  assert.equal(await composer.evaluate((element) => getComputedStyle(element).position), "static");
  assert.equal(await transcript.evaluate((element) => getComputedStyle(element).minHeight), "0px");
  await page.setViewportSize({ width: 390, height: 520 });
  await textarea.scrollIntoViewIfNeeded();
  const textareaBox = await textarea.boundingBox();
  assert.ok(textareaBox && textareaBox.y + textareaBox.height <= 520);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.match((await openChats.getAttribute("aria-label")) ?? "", /Connection current/);
  await openChats.click();
  await page.getByRole("dialog").waitFor();
  assert.equal(
    await page.getByRole("dialog").evaluate((element) => element.contains(document.activeElement)),
    true,
  );
  assert.equal(
    await page.getByText("Cached conversation survives suspension", { exact: true }).count(),
    1,
  );
  assert.equal(await textarea.inputValue(), "draft remains mounted");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  await page.getByRole("combobox", { name: /Theme/ }).selectOption("dark");
  assert.equal(
    await page.locator("html").evaluate((element) => element.classList.contains("dark")),
    true,
  );
  assert.equal(await textarea.inputValue(), "draft remains mounted");

  await page.getByRole("button", { name: "Back to Chats", exact: true }).click();
  await page.getByRole("heading", { name: "Chats", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector('[role="dialog"]') === null);
  assert.equal(await openChats.evaluate((element) => document.activeElement === element), true);
  assert.equal(await textarea.inputValue(), "draft remains mounted");

  await openChats.click();
  await page.getByRole("dialog").waitFor();
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('[role="dialog"]') === null);
  assert.equal(await page.evaluate(() => location.pathname), "/mobile/thread/thread-recovery");
  await page.goForward();
  await page.getByRole("dialog").waitFor();
  assert.equal(await page.getByRole("heading", { name: "Chats", exact: true }).count(), 1);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ mountedConversationPreserved: true, overlayBackDismissed: true, errors }),
  );
} finally {
  await browser.close();
  await server.close();
}
