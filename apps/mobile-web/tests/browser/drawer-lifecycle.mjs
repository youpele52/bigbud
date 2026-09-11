// Run with: node apps/mobile-web/tests/browser/drawer-lifecycle.mjs
// Exercise controlled Drawer close/reopen, reduced motion, and forget-during-exit behavior.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "../../../web/node_modules/playwright/index.mjs";
import { session, snapshot, thread } from "./recovery.fixture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const server = await createServer({
  root,
  configFile: `${root}vite.config.ts`,
  server: { host: "127.0.0.1", port: 15747, strictPort: true },
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
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
});

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
        serverEpoch: "drawer-lifecycle-epoch",
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
              serverEpoch: "drawer-lifecycle-epoch",
              recoveryAttemptId: request.payload.recoveryAttemptId,
              type: "caught-up",
              throughSequence: 0,
            },
          ],
        }),
      );
    } else if (request.tag === "orchestration.getSnapshot") {
      sendExit(ws, request, snapshot);
    } else if (request.tag === "orchestration.getMobileThread") {
      sendExit(ws, request, thread);
    }
  });
});

await page.addInitScript(
  (value) => localStorage.setItem("bigbud:mobile-web:session:v1", JSON.stringify(value)),
  { ...session, backendBaseUrl: "http://127.0.0.1:15747" },
);

// Base UI marks the page behind an open modal inert, so role queries cannot see this trigger
// during the open phase. The stable trigger id still lets the harness inspect its state.
const openChats = page.locator("#mobile-navigation-trigger");

async function waitForClosed() {
  await page.waitForFunction(() => document.querySelector('[role="dialog"]') === null);
  assert.equal(await openChats.getAttribute("aria-expanded"), "false");
  assert.equal(await page.evaluate(() => location.pathname), "/mobile/thread/thread-recovery");
  assert.equal(await page.evaluate(() => history.state?.mobileOverlay), undefined);
  assert.equal(await page.evaluate(() => document.body.style.overflow), "");
  assert.equal(await page.evaluate(() => document.documentElement.style.overflow), "");
  assert.equal(await openChats.evaluate((element) => document.activeElement === element), true);
}

async function openDrawer() {
  await openChats.click();
  await page.getByRole("dialog").waitFor();
  assert.equal(await openChats.getAttribute("aria-expanded"), "true");
}

async function assertDrawerMotion() {
  const popup = page.locator('[data-slot="drawer-popup"]');
  const transition = await popup.evaluate((element) => {
    const style = getComputedStyle(element);
    return { property: style.transitionProperty, duration: style.transitionDuration };
  });
  assert.match(transition.property, /translate/);
  assert.match(transition.duration, /0\.28s|280ms/);

  await page.getByRole("button", { name: "Close navigation", exact: true }).click();
  await page.waitForFunction(() =>
    Boolean(document.querySelector('[data-slot="drawer-popup"][data-ending-style]')),
  );
  const duringExit = await popup.boundingBox();
  await page.waitForTimeout(70);
  const afterExitStarted = await popup.boundingBox();
  assert.ok(duringExit && afterExitStarted && afterExitStarted.y > duringExit.y + 1);
  return popup;
}

try {
  await page.goto("http://127.0.0.1:15747/mobile/thread/thread-recovery");
  await page.locator("textarea").waitFor({ timeout: 60_000 });

  // Start the exit transition, then reopen through the still-mounted trigger before completion.
  await openDrawer();
  const handle = page.locator('[data-slot="drawer-handle"]');
  const handleBox = await handle.boundingBox();
  assert.ok(handleBox && handleBox.height <= 20, "drawer grip must not add a tall empty row");
  const closeBox = await page
    .getByRole("button", { name: "Close navigation", exact: true })
    .boundingBox();
  assert.ok(closeBox && closeBox.height >= 44, "header buttons must retain touch-sized targets");
  await assertDrawerMotion();
  await openChats.evaluate((element) => (element instanceof HTMLElement ? element.click() : null));
  await page.getByRole("dialog").waitFor();
  assert.equal(await page.getByRole("heading", { name: "Chats", exact: true }).count(), 1);
  await page.waitForTimeout(400);
  assert.equal(await page.getByRole("dialog").count(), 1);
  assert.equal(await page.evaluate(() => history.state?.mobileOverlay?.kind), "chats");
  await page.getByRole("button", { name: "Close navigation", exact: true }).click();
  await waitForClosed();

  // Base UI should complete closure without requiring a transition when reduced motion is enabled.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openDrawer();
  const reducedMotionStartedAt = Date.now();
  await page.keyboard.press("Escape");
  await waitForClosed();
  assert.ok(Date.now() - reducedMotionStartedAt < 250, "reduced motion should close promptly");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  // Forget while the settings drawer is in its exit transition; no retained drawer may return.
  await openDrawer();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  await page.getByRole("button", { name: "Forget this connection", exact: true }).click();
  await page.getByRole("heading", { name: "Forget this connection?", exact: true }).waitFor();
  await page.locator("textarea").fill("sensitive pending command");
  await page.getByRole("button", { name: "Close navigation", exact: true }).click();
  await page.getByRole("button", { name: "Forget connection", exact: true }).evaluate((element) => {
    if (element instanceof HTMLElement) element.click();
  });
  await page.waitForURL("**/mobile");
  await page.waitForFunction(() => document.querySelector('[role="dialog"]') === null);
  assert.equal(await page.evaluate(() => history.state?.mobileOverlay), undefined);
  assert.equal(await page.evaluate(() => document.body.style.overflow), "");
  assert.equal(await page.evaluate(() => document.documentElement.style.overflow), "");
  assert.equal(
    await page.getByRole("button", { name: /Open Chats/ }).getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(
    await page
      .getByText("Open a pairing link from the desktop app to authorize this phone.", {
        exact: true,
      })
      .count(),
    1,
  );
  assert.equal(await page.getByText("sensitive pending command", { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  const result = {
    rapidCloseReopen: true,
    reducedMotionClose: true,
    forgetDuringExit: true,
    routeAfterForget: "/mobile",
    focusRestoredAfterClose: true,
    routerStateCleaned: true,
    bodyScrollUnlocked: true,
    motionProperty: "translate",
    compactGripRow: true,
    headerTouchTargetsAtLeast44px: true,
    sensitiveContentAbsentAfterForget: true,
    pageErrors: errors,
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  await server.close();
}
