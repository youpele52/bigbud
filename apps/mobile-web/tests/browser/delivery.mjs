// Run with: node apps/mobile-web/tests/browser/delivery.mjs
// Real mobile route and RPC codec; the WebSocket server is deterministic.
import assert from "node:assert/strict";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { chromium } from "../../../web/node_modules/playwright/index.mjs";
import { session, snapshot, thread } from "./recovery.fixture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const server = await createServer({
  root,
  configFile: `${root}vite.config.ts`,
  server: { host: "127.0.0.1", port: 15745, strictPort: true, hmr: false },
});
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const errors = [];
const requests = [];
let heldDispatch = null;
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
    requests.push(request);
    if (request.tag === "mobile.recovery.getBaseline") {
      sendExit(ws, request, {
        version: 1,
        recoveryAttemptId: request.payload.recoveryAttemptId,
        serverEpoch: "delivery-epoch",
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
              serverEpoch: "delivery-epoch",
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
    } else if (request.tag === "orchestration.dispatchCommand") {
      heldDispatch ??= { request, ws };
    }
  });
});

await page.addInitScript(
  (value) => localStorage.setItem("bigbud:mobile-web:session:v1", JSON.stringify(value)),
  { ...session, backendBaseUrl: "http://127.0.0.1:15745" },
);

try {
  await page.goto("http://127.0.0.1:15745/mobile/thread/thread-recovery");
  const textarea = page.locator("textarea");
  await textarea.waitFor({ timeout: 60_000 });
  await page.getByText("Gpt 5.4", { exact: true }).waitFor();
  await textarea.fill("first delivery");

  const send = page.getByRole("button", { name: "Send message", exact: true });
  await send.click();
  await page.waitForFunction(
    () => document.querySelectorAll('[aria-label="Send message"]').length === 1,
  );
  await send.dispatchEvent("click");
  assert.equal(await textarea.inputValue(), "first delivery");

  const dispatches = requests.filter((request) => request.tag === "orchestration.dispatchCommand");
  assert.equal(dispatches.length, 1, "rapid activation must dispatch one command");
  assert.equal(dispatches[0].payload.type, "thread.turn.start");
  assert.deepEqual(dispatches[0].payload.modelSelection, thread.modelSelection);
  assert.equal(dispatches[0].payload.runtimeMode, thread.runtimeMode);
  assert.equal(dispatches[0].payload.interactionMode, thread.interactionMode);
  assert.equal("bootstrap" in dispatches[0].payload, false);

  await textarea.fill("newer typing");
  assert.equal(
    await textarea.inputValue(),
    "newer typing",
    "typing must remain available while pending",
  );
  assert.ok(heldDispatch, "the deterministic server should hold the acknowledgement");
  sendExit(heldDispatch.ws, heldDispatch.request, { sequence: 1 });
  await page.waitForFunction(() => document.querySelector("textarea")?.value === "newer typing");
  assert.deepEqual(
    requests.filter((request) => request.tag === "orchestration.dispatchCommand").length,
    1,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      selectedModelExistingSend: true,
      duplicateActivationSuppressed: true,
      newerTypingPreserved: true,
      pageErrors: errors,
    }),
  );
} catch (error) {
  console.error({
    error,
    errors,
    requests: requests.map(({ tag, payload }) => ({ tag, payload })),
    value: await page
      .locator("textarea")
      .inputValue()
      .catch(() => null),
    body: (await page.locator("body").innerText()).slice(0, 3000),
  });
  throw error;
} finally {
  await browser.close();
  await server.close();
}
