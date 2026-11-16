// Actual providers/hooks with a synthetic permanent baseline rejection across client replacement.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "../../../web/node_modules/playwright/index.mjs";
import { session, snapshot, thread } from "./recovery.fixture.mjs";

const homeSnapshot = structuredClone(snapshot);
for (const item of homeSnapshot.threads) item.proposedPlans = [];

const root = fileURLToPath(new URL("../../", import.meta.url));
const origin = "http://127.0.0.1:15748";
const server = await createServer({
  root,
  configFile: `${root}vite.config.ts`,
  server: { host: "127.0.0.1", port: 15748, strictPort: true, hmr: false },
});
await server.listen();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
let sockets = 0;
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/src/main.tsx", async (route) => {
  const response = await route.fetch();
  await route.fulfill({
    response,
    body: `
    const { MobileRpcClient: FixtureClient } = await import('/src/lib/mobileRpc.ts');
    const { MobileRecoveryRejectedBaselineError: FixtureError } = await import('/src/lib/mobileRpc.errors.ts');
    window.baselineCalls = 0;
    window.baselineScopes = [];
    FixtureClient.prototype.getMobileRecoveryBaseline = async function (input) {
      window.baselineScopes.push(input.selectedThreadId ?? null);
      if (!input.selectedThreadId) return { version: 1, recoveryAttemptId: input.recoveryAttemptId,
        serverEpoch: "rejection-fixture", snapshotSequence: 0, snapshot: ${JSON.stringify(homeSnapshot)}, selectedThread: null };
      window.baselineCalls += 1;
      throw new FixtureError('Fixture baseline is permanently too large');
    };
    ${await response.text()}
  `,
  });
});
await page.routeWebSocket("**/mobile-ws?*", (ws) => {
  sockets += 1;
  // Allow each open event before a deterministic transport loss.
  setTimeout(() => ws.close({ code: 1012, reason: "fixture restart" }), 50);
});
await page.addInitScript(
  (value) => {
    localStorage.setItem("bigbud:mobile-web:session:v1", JSON.stringify(value));
    Math.random = () => 0;
  },
  { ...session, backendBaseUrl: origin },
);
await page.clock.install();
await page.clock.pauseAt(new Date(Date.now() + 1_000));

try {
  await page.goto(`${origin}/mobile/thread/${thread.id}`);
  await page.waitForFunction(() => window.baselineCalls === 1, null, { timeout: 60_000 });
  for (let step = 0; step < 45; step += 1) {
    await page.clock.runFor(1_000);
    await page.waitForTimeout(100);
  }
  assert.equal(sockets, 8, "the actual protocol exhausts after eight sockets including opens");
  assert.equal(await page.evaluate(() => window.baselineCalls), 1);
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
  await page.evaluate(() => dispatchEvent(new Event("focus")));
  await page.clock.runFor(100);
  await page.waitForTimeout(150);
  assert.ok(sockets > 8, "visible resume replaces the exhausted RPC client");
  await page.clock.runFor(1_000);
  await page.waitForTimeout(150);
  assert.equal(
    await page.evaluate(() => window.baselineCalls),
    1,
    "automatic replacement retains rejection",
  );
  for (let step = 0; step < 45; step += 1) {
    await page.clock.runFor(1_000);
    await page.waitForTimeout(100);
  }
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.clock.runFor(100);
  await page.waitForFunction(() => window.baselineCalls === 2);
  await page.evaluate(() => {
    history.pushState(null, "", "/mobile");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.clock.runFor(100);
  await page.waitForFunction(() => window.baselineScopes.at(-1) === null);
  await page.evaluate((id) => {
    history.pushState(null, "", `/mobile/thread/${id}`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, thread.id);
  await page.clock.runFor(100);
  await page.waitForFunction(() => window.baselineCalls === 3);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      selectedThread: true,
      genuineRouteDeselectionClearedScope: true,
      automaticReplacementPreservedRejection: true,
      explicitRetryRebuilt: true,
      pageErrors: errors,
    }),
  );
} finally {
  await browser.close();
  await server.close();
}
