// Run with: node apps/mobile-web/tests/browser/visual-parity.mjs
// Capture deterministic mobile conversation states for visual comparison with the floating chat.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "../../../web/node_modules/playwright/index.mjs";
import { session, snapshot, thread } from "./recovery.fixture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const server = await createServer({
  root,
  configFile: `${root}vite.config.ts`,
  server: { host: "127.0.0.1", port: 15746, strictPort: true },
});
await server.listen();

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 1,
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
});

const emptyThread = {
  ...thread,
  id: "thread-visual-empty",
  title: "New thread",
  messages: [],
  latestTurn: null,
  session: null,
};
const emptySnapshot = {
  ...snapshot,
  threads: [emptyThread],
};

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
        serverEpoch: "visual-parity-epoch",
        snapshotSequence: 0,
        snapshot: emptySnapshot,
        selectedThread: { status: "present", thread: emptyThread },
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
              serverEpoch: "visual-parity-epoch",
              recoveryAttemptId: request.payload.recoveryAttemptId,
              type: "caught-up",
              throughSequence: 0,
            },
          ],
        }),
      );
    } else if (request.tag === "orchestration.getSnapshot") {
      sendExit(ws, request, emptySnapshot);
    } else if (request.tag === "orchestration.getMobileThread") {
      sendExit(ws, request, emptyThread);
    }
  });
});

await page.addInitScript(
  (value) => localStorage.setItem("bigbud:mobile-web:session:v1", JSON.stringify(value)),
  { ...session, backendBaseUrl: "http://127.0.0.1:15746" },
);

const screenshotPaths = {
  idle: "/tmp/bigbud-mobile-visual-parity-idle.png",
  composer: "/tmp/bigbud-mobile-visual-parity-composer.png",
};

try {
  await page.goto("http://127.0.0.1:15746/mobile/thread/thread-visual-empty");
  const textarea = page.locator("textarea");
  const emptyState = page.locator('[data-mobile-empty-state="true"]');
  const transcript = page.locator('[data-mobile-transcript="true"]');
  await textarea.waitFor({ timeout: 60_000 });
  await emptyState.waitFor();
  const composerSurface = page.locator('[data-mobile-composer-surface="true"]');
  const composerSurfaceMetrics = await composerSurface.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      borderRadius: styles.borderRadius,
      backgroundColor: styles.backgroundColor,
    };
  });
  assert.match(await composerSurface.getAttribute("class"), /rounded-\[20px\]/);
  assert.notEqual(composerSurfaceMetrics.backgroundColor, "rgba(0, 0, 0, 0)");

  const centering = await transcript.evaluate((transcriptElement) => {
    const element = transcriptElement.querySelector('[data-mobile-empty-state="true"]');
    const logo = element.querySelector("svg");
    if (!logo) return null;
    const transcriptBox = transcriptElement.getBoundingClientRect();
    const styles = getComputedStyle(transcriptElement);
    const usableBox = {
      left: transcriptBox.left + Number.parseFloat(styles.paddingLeft),
      right: transcriptBox.right - Number.parseFloat(styles.paddingRight),
      top: transcriptBox.top + Number.parseFloat(styles.paddingTop),
      bottom: transcriptBox.bottom - Number.parseFloat(styles.paddingBottom),
    };
    const logoBox = logo.getBoundingClientRect();
    return {
      horizontalOffset: Math.abs(
        (usableBox.left + usableBox.right) / 2 - (logoBox.left + logoBox.width / 2),
      ),
      verticalOffset: Math.abs(
        (usableBox.top + usableBox.bottom) / 2 - (logoBox.top + logoBox.height / 2),
      ),
      transcriptHeight: transcriptElement.clientHeight,
      transcriptScrollHeight: transcriptElement.scrollHeight,
    };
  });
  assert.ok(centering, "idle state must render a logo");
  assert.ok(centering.horizontalOffset <= 4, "idle logo must be horizontally centered");
  assert.ok(centering.verticalOffset <= 4, "idle logo must be vertically centered");
  await page.screenshot({ animations: "disabled", caret: "hide", path: screenshotPaths.idle });

  await textarea.fill("What are we working on?");
  assert.equal(await textarea.inputValue(), "What are we working on?");
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    path: screenshotPaths.composer,
  });

  const floatingReferenceCount = await page
    .locator("[data-floating-assistant-mascot], [data-floating-assistant-compact-chat]")
    .count();
  const result = {
    browser: await browser.version(),
    viewport: { width: 390, height: 844, deviceScaleFactor: 1 },
    screenshots: screenshotPaths,
    idleCentering: centering,
    idleLogoCentered: true,
    typedComposerPlaceholder: "What are we working on?",
    floatingReferenceCaptured: floatingReferenceCount > 0,
    floatingReferenceScreenshot: null,
    pageErrors: errors,
    limitations: [
      "The floating assistant is hosted by the desktop/web shell and is not mounted by the mobile Vite fixture.",
      "Comparison uses deterministic Chromium mobile emulation; physical device rendering is not covered.",
    ],
  };
  assert.deepEqual(errors, []);
  await writeFile("/tmp/bigbud-mobile-visual-parity-results.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
  await server.close();
}
