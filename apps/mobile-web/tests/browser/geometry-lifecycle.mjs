// Run with: node apps/mobile-web/tests/browser/geometry-lifecycle.mjs
// Exercise reader control, transcript geometry, and short-viewport decision reachability.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "../../../web/node_modules/playwright/index.mjs";
import { session, snapshot, thread } from "./recovery.fixture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const server = await createServer({
  root,
  configFile: `${root}vite.config.ts`,
  server: { host: "127.0.0.1", port: 15748, strictPort: true },
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

const longMessages = Array.from({ length: 36 }, (_, index) => ({
  id: `geometry-message-${index}`,
  role: index % 2 === 0 ? "assistant" : "user",
  text: `${index % 2 === 0 ? "Streaming response" : "Reader prompt"} ${index} `.repeat(12),
  turnId: null,
  streaming: false,
  createdAt: `2026-09-09T00:${String(index).padStart(2, "0")}:00.000Z`,
  updatedAt: `2026-09-09T00:${String(index).padStart(2, "0")}:00.000Z`,
}));
const longThread = { ...thread, id: "thread-geometry", messages: longMessages, activities: [] };
const emptyThread = { ...longThread, id: "thread-geometry-empty", messages: [] };
const approvalThread = {
  ...emptyThread,
  id: "thread-geometry-approval",
  activities: [
    {
      id: "geometry-approval",
      threadId: "thread-geometry-approval",
      kind: "approval.requested",
      tone: "approval",
      summary: "Approval required",
      turnId: null,
      payload: {
        requestId: "geometry-approval-request",
        requestType: "command_execution_approval",
        command: "echo this is a deliberately long approval detail ".repeat(60),
      },
      createdAt: "2026-09-09T00:00:00.000Z",
      sequence: 1,
    },
  ],
};
let selectedThread = longThread;

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
        serverEpoch: "geometry-epoch",
        snapshotSequence: 0,
        snapshot: { ...snapshot, threads: [selectedThread] },
        selectedThread: { status: "present", thread: selectedThread },
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
              serverEpoch: "geometry-epoch",
              recoveryAttemptId: request.payload.recoveryAttemptId,
              type: "caught-up",
              throughSequence: 0,
            },
          ],
        }),
      );
    } else if (request.tag === "orchestration.getSnapshot") {
      sendExit(ws, request, { ...snapshot, threads: [selectedThread] });
    } else if (request.tag === "orchestration.getMobileThread") {
      sendExit(ws, request, selectedThread);
    }
  });
});

await page.addInitScript(
  (value) => localStorage.setItem("bigbud:mobile-web:session:v1", JSON.stringify(value)),
  { ...session, backendBaseUrl: "http://127.0.0.1:15748" },
);

async function openThread() {
  await page.goto(`http://127.0.0.1:15748/mobile/thread/${selectedThread.id}`);
  try {
    await page.locator('[data-mobile-transcript="true"]').waitFor({ timeout: 15_000 });
  } catch (error) {
    console.error({
      selectedThread: selectedThread.id,
      errors,
      body: (await page.locator("body").innerText()).slice(0, 3000),
    });
    throw error;
  }
}

try {
  await openThread();
  const transcript = page.locator('[data-mobile-transcript="true"]');
  await page.waitForFunction(() => document.querySelectorAll("[data-message-id]").length >= 30);
  const longGeometry = await transcript.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  assert.ok(longGeometry.scrollHeight > longGeometry.clientHeight + 100);

  await transcript.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  const beforeGrowth = await transcript.evaluate((element) => element.scrollTop);
  await transcript.evaluate((element) => {
    const late = document.createElement("p");
    late.textContent = "Late streaming content".repeat(80);
    late.dataset.geometryLateContent = "true";
    element.querySelector('[data-mobile-transcript-content="true"]')?.append(late);
  });
  await page.waitForTimeout(120);
  const afterGrowth = await transcript.evaluate((element) => element.scrollTop);
  assert.ok(
    Math.abs(afterGrowth - beforeGrowth) <= 2,
    `reader position must survive content growth (${beforeGrowth} -> ${afterGrowth})`,
  );
  await page.getByRole("button", { name: "Scroll to latest", exact: true }).click();
  await page.waitForFunction(
    () => {
      const element = document.querySelector('[data-mobile-transcript="true"]');
      return element ? element.scrollTop + element.clientHeight >= element.scrollHeight - 2 : false;
    },
    { timeout: 1_000 },
  );

  selectedThread = emptyThread;
  await openThread();
  const emptyTranscript = page.locator('[data-mobile-transcript="true"]');
  const emptyLogo = page.locator('[data-mobile-empty-state="true"] svg');
  await emptyLogo.waitFor();
  const emptyCentering = await emptyTranscript.evaluate((transcriptElement) => {
    const logo = transcriptElement.querySelector('[data-mobile-empty-state="true"] svg');
    const transcriptBox = transcriptElement.getBoundingClientRect();
    const style = getComputedStyle(transcriptElement);
    const logoBox = logo.getBoundingClientRect();
    const top = transcriptBox.top + Number.parseFloat(style.paddingTop);
    const bottom = transcriptBox.bottom - Number.parseFloat(style.paddingBottom);
    return Math.abs((top + bottom) / 2 - (logoBox.top + logoBox.height / 2));
  });
  assert.ok(emptyCentering <= 4, `idle logo must be centered in transcript: ${emptyCentering}`);

  selectedThread = approvalThread;
  await page.setViewportSize({ width: 390, height: 320 });
  await openThread();
  await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
  assert.equal(
    await page.locator("textarea").count(),
    0,
    "approval must not reserve a prompt editor",
  );
  for (const name of ["Approve", "Deny"]) {
    const box = await page.getByRole("button", { name, exact: true }).boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= 320, `${name} must be reachable`);
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        readerPositionSurvivesGrowth: true,
        latestRestoresFollowing: true,
        idleLogoCenteredInTranscript: true,
        approvalControlsReachableAt390x320: true,
        consoleErrors: errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await server.close();
}
