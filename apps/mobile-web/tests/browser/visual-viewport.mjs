// Focused actual-app keyboard geometry fixture; no physical-device claim.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "../../../web/node_modules/playwright/index.mjs";
import { session, snapshot, thread } from "./recovery.fixture.mjs";
import { installMobileWsStub } from "./mobileWsStub.fixture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const server = await createServer({
  root,
  configFile: `${root}vite.config.ts`,
  server: { host: "127.0.0.1", port: 15749, strictPort: true },
});
let browser;
const errors = [];
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await installMobileWsStub(page, { snapshot, thread });
  await page.addInitScript(
    (value) => {
      localStorage.setItem("bigbud:mobile-web:session:v1", JSON.stringify(value));
      const viewport = Object.assign(new EventTarget(), {
        height: 844,
        width: 390,
        offsetTop: 0,
        offsetLeft: 0,
        scale: 1,
      });
      Object.defineProperty(window, "visualViewport", { value: viewport });
      window.setTestViewport = (height, offsetTop = 0, scale = 1) => {
        Object.assign(viewport, { height, offsetTop, scale });
        viewport.dispatchEvent(new Event("resize"));
        viewport.dispatchEvent(new Event("scroll"));
      };
    },
    { ...session, backendBaseUrl: "http://127.0.0.1:15749" },
  );
  await page.goto(`http://127.0.0.1:15749/mobile/thread/${thread.id}`);
  const textarea = page.getByRole("textbox", { name: "Message", exact: true });
  await textarea.fill("Keep this draft through keyboard changes");
  await textarea.evaluate((element) => {
    element.focus();
    element.setSelectionRange(5, 15);
  });
  await page.evaluate(() => window.setTestViewport(460, 32));
  await page.waitForTimeout(100);
  const geometry = await page.evaluate(() => {
    const box = document.querySelector('[data-mobile-composer="true"]').getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, innerHeight: window.innerHeight };
  });
  assert.equal(geometry.innerHeight, 844, "fixture must not shrink the layout viewport");
  assert.ok(
    geometry.bottom <= 493,
    `composer must fit above keyboard: ${JSON.stringify(geometry)}`,
  );
  assert.ok(geometry.top >= 32, "composer must stay inside the visible area");
  assert.equal(await textarea.inputValue(), "Keep this draft through keyboard changes");
  assert.deepEqual(
    await textarea.evaluate((e) => [
      e.selectionStart,
      e.selectionEnd,
      e === document.activeElement,
    ]),
    [5, 15, true],
  );
  const beforeZoom = await page.locator('[data-mobile-composer="true"]').boundingBox();
  await page.evaluate(() => window.setTestViewport(230, 100, 2));
  await page.waitForTimeout(100);
  assert.deepEqual(await page.locator('[data-mobile-composer="true"]').boundingBox(), beforeZoom);
  assert.equal(
    await page.evaluate(() =>
      document.documentElement.style.getPropertyValue("--mobile-viewport-height"),
    ),
    "460px",
    "pinch zoom must not reflow the shell",
  );
  await page.evaluate(() => window.setTestViewport(460, 32));
  await page.getByRole("button", { name: /^Open Chats/ }).click();
  const drawer = page.getByRole("dialog");
  await drawer.waitFor();
  const drawerBox = await drawer.boundingBox();
  assert.ok(
    drawerBox.y >= 32 && drawerBox.y + drawerBox.height <= 493,
    "navigation must fit the same visual viewport",
  );
  await page.getByRole("button", { name: "Close navigation", exact: true }).click();
  await drawer.waitFor({ state: "hidden" });
  await page.evaluate(() => window.setTestViewport(844));
  await page.waitForTimeout(100);
  const restored = await page.locator('[data-mobile-composer="true"]').boundingBox();
  assert.ok(restored.y + restored.height > 800 && restored.y + restored.height <= 845);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      visualViewportOnlyKeyboardReachability: true,
      offsetHandled: true,
      draftFocusSelectionPreserved: true,
      pinchZoomDoesNotReflow: true,
      keyboardNavigationReachable: true,
      keyboardDismissRestoresHeight: true,
      errors,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}
