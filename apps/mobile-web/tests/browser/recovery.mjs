// Run with: node apps/mobile-web/tests/browser/recovery.mjs
// Actual App/router/provider/controller/RPC codec; deterministic WebSocket server responses.
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
  server: { host: "127.0.0.1", port: 15743, strictPort: true },
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
const requests = [];
let mode = "current";
let socket;
let activeStream;
function chunk(ws, request, frame) {
  ws.send(JSON.stringify({ _tag: "Chunk", requestId: request.id, values: [frame] }));
}
function marker() {
  const { ws, request } = activeStream;
  chunk(ws, request, {
    version: 1,
    route: "direct-unmanaged",
    serverEpoch: "browser-epoch",
    recoveryAttemptId: request.payload.recoveryAttemptId,
    type: "caught-up",
    throughSequence: 0,
  });
}
await page.routeWebSocket("**/mobile-ws?*", (ws) => {
  socket = ws;
  ws.onMessage((message) => {
    const request = JSON.parse(String(message));
    if (request._tag !== "Request") return;
    requests.push(request);
    const reply = (value) =>
      ws.send(
        JSON.stringify({ _tag: "Exit", requestId: request.id, exit: { _tag: "Success", value } }),
      );
    if (request.tag.startsWith("mobile.recovery.") && mode === "legacy") {
      ws.send(JSON.stringify({ _tag: "Defect", defect: `Unknown request tag: ${request.tag}` }));
    } else if (request.tag === "mobile.recovery.getBaseline") {
      reply({
        version: 1,
        recoveryAttemptId: request.payload.recoveryAttemptId,
        serverEpoch: "browser-epoch",
        snapshotSequence: 0,
        snapshot,
        selectedThread: request.payload.selectedThreadId ? { status: "present", thread } : null,
      });
    } else if (request.tag === "mobile.recovery.subscribe") {
      activeStream = { ws, request };
      if (mode === "current") marker();
    } else if (request.tag === "orchestration.getSnapshot") reply(snapshot);
    else if (request.tag === "orchestration.getMobileThread") reply(thread);
  });
});
await page.addInitScript(
  (value) => localStorage.setItem("bigbud:mobile-web:session:v1", JSON.stringify(value)),
  session,
);
const draft = "draft survives network recovery";
try {
  await page.goto("http://127.0.0.1:15743/mobile/thread/thread-recovery");
  const textarea = page.locator("textarea");
  await textarea.waitFor({ timeout: 60_000 });
  assert.equal(
    requests.find((request) => request.tag === "mobile.recovery.getBaseline")?.payload
      .selectedThreadId,
    thread.id,
    "direct thread route must request selected history",
  );
  await textarea.fill(draft);
  await textarea.focus();
  await textarea.evaluate((el) => el.setSelectionRange(6, 14));
  const send = page.getByRole("button", { name: "Send message", exact: true });
  await send.waitFor();
  await page.waitForFunction(
    () => !document.querySelector('button[aria-label="Send message"]')?.disabled,
  );
  mode = "suspended";
  socket.close({ code: 1012, reason: "browser suspension fixture" });
  await page.getByRole("status").getByText("Showing last-known data", { exact: true }).waitFor();
  assert.equal(await send.isDisabled(), true);
  const preserve = async () => {
    assert.equal(await textarea.inputValue(), draft);
    assert.equal(await textarea.evaluate((el) => document.activeElement === el), true);
    assert.deepEqual(
      await textarea.evaluate((el) => [el.selectionStart, el.selectionEnd]),
      [6, 14],
    );
    assert.equal(await textarea.isEnabled(), true);
    assert.equal(
      await page.getByText("Cached conversation survives suspension", { exact: true }).count(),
      1,
    );
  };
  await preserve();
  const previous = activeStream;
  for (let i = 0; i < 100 && activeStream === previous; i++) await page.waitForTimeout(100);
  assert.notEqual(activeStream, previous, "reconnect must obtain baseline and new stream");
  assert.equal(await send.isDisabled(), true, "baseline alone must not enable Send");
  await preserve();
  marker();
  await page.waitForFunction(
    () => !document.querySelector('button[aria-label="Send message"]')?.disabled,
  );
  await preserve();
  mode = "legacy";
  socket.close({ code: 1012, reason: "legacy server replacement fixture" });
  await page.getByRole("status").getByText("Showing last-known data", { exact: true }).waitFor();
  await page.waitForTimeout(4_000);
  // A second rapid replacement may exhaust the deliberately shared automatic budget.
  if ((await page.getByText(/Live recovery markers are unavailable/).count()) === 0) {
    await page
      .getByRole("button", { name: "Retry", exact: true })
      .evaluate((button) => button.click());
  }
  await page
    .getByRole("status")
    .getByText("Live recovery markers unavailable", { exact: true })
    .waitFor({ timeout: 15_000 });
  assert.match(await page.getByRole("status").innerText(), /Last refreshed at/);
  assert.equal(await send.isEnabled(), true);
  await preserve();
  assert.equal(
    requests.filter((request) => request.tag === "orchestration.dispatchCommand").length,
    0,
  );
  // Plan 3.4: Stop remains an explicit thread-targeted action with stale data.
  thread.session = {
    threadId: thread.id,
    status: "running",
    providerName: "codex",
    activeTurnId: "turn-browser",
    lastError: null,
    updatedAt: thread.updatedAt,
  };
  mode = "current";
  await page
    .getByRole("button", { name: "Retry", exact: true })
    .evaluate((button) => button.click());
  const stop = page.getByRole("button", { name: "Stop generation", exact: true });
  await stop.waitFor();
  mode = "suspended";
  chunk(activeStream.ws, activeStream.request, {
    version: 1,
    route: "direct-unmanaged",
    serverEpoch: "browser-epoch",
    recoveryAttemptId: activeStream.request.payload.recoveryAttemptId,
    type: "resync-required",
    reason: "gap",
  });
  await page.getByRole("status").getByText("Showing last-known data", { exact: true }).waitFor();
  assert.equal(await stop.isEnabled(), true);
  await stop.click();
  for (
    let i = 0;
    i < 100 && !requests.some((request) => request.tag === "orchestration.dispatchCommand");
    i++
  )
    await page.waitForTimeout(20);
  const commands = requests.filter((request) => request.tag === "orchestration.dispatchCommand");
  assert.equal(commands.length, 1);
  assert.equal(commands[0].payload.type, "thread.turn.interrupt");
  assert.equal(commands[0].payload.threadId, thread.id);
  assert.equal(typeof commands[0].payload.commandId, "string");
  // With no server result, retain the last-known running state: no claim that Stop succeeded.
  assert.equal(await stop.isVisible(), true);
  assert.deepEqual(errors, []);
  const result = {
    browser: await browser.version(),
    actualRoute: "/mobile/thread/thread-recovery",
    realRpcCodec: true,
    freshBaselineAfterReconnect: true,
    markerGatesActions: true,
    cachedContentDraftFocusSelectionPreserved: true,
    typedLegacyFallback: true,
    legacyRefreshTimestamp: true,
    noAutomaticCommands: true,
    staleStopEnabledAndExplicitThreadTargetVerified: true,
    stopSuccessNotInferred: true,
    pageErrors: errors,
    requests: requests.map(({ tag }) => tag),
    limitations: [
      "Deterministic intercepted WebSocket responses, not an authenticated deployed server",
      "Chromium mobile emulation; physical iOS Safari and Android Chrome unavailable",
    ],
  };
  await writeFile(
    "/tmp/bigbud-mobile-route-recovery-results.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error({
    errors,
    requests: requests.map(({ tag }) => tag),
    body: (await page.locator("body").innerText()).slice(0, 4000),
  });
  throw error;
} finally {
  await browser.close();
  await server.close();
}
