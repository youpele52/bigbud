// Run with: node apps/mobile-web/tests/browser/baseline-matrix.mjs
// Captures the phase-5 mobile baseline screenshot matrix (widths × orientation × theme × state)
// into /tmp/bigbud-mobile-baseline/ and records horizontal-overflow and page-error checks in
// results.json. Fixture data only; no backend, credentials or network access.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { chromium } from "../../../web/node_modules/playwright/index.mjs";
import { installMobileWsStub } from "./mobileWsStub.fixture.mjs";
import { presentationStates } from "./presentation-states.fixture.mjs";
import { session, snapshot, thread } from "./recovery.fixture.mjs";
import { launchMatrixElectron } from "./baseline-matrix.electron.mjs";

const OUT = process.env.MOBILE_MATRIX_OUTPUT_DIR ?? "/tmp/bigbud-mobile-baseline";
const PORT = 15746;
const root = fileURLToPath(new URL("../../", import.meta.url));
const sizes = [
  { name: "360-portrait", width: 360, height: 780 },
  { name: "390-portrait", width: 390, height: 844 },
  { name: "430-portrait", width: 430, height: 932 },
  { name: "360-landscape", width: 780, height: 360 },
  { name: "430-landscape", width: 932, height: 430 },
  { name: "360-keyboard", width: 360, height: 420 },
  { name: "430-keyboard", width: 430, height: 500 },
  { name: "390-landscape", width: 844, height: 390 },
  { name: "390-keyboard", width: 390, height: 460 },
];
const approvalThread = {
  ...thread,
  activities: [
    {
      id: "approval-matrix",
      tone: "approval",
      kind: "approval.requested",
      summary: "Approval requested",
      turnId: null,
      createdAt: thread.createdAt,
      payload: {
        requestId: "approval-matrix",
        requestType: "exec_command_approval",
        detail: "Review the proposed command before continuing. ".repeat(12),
      },
    },
  ],
};
const pairing = "/mobile/pair/pairing-fixture?backend=https://desk.tail1.ts.net#secret=fixture";
const states = [
  ...presentationStates,
  {
    name: "chats",
    path: "/mobile",
    ready: (page) => page.getByText("New chat").waitFor({ timeout: 60_000 }),
  },
  {
    name: "thread",
    path: `/mobile/thread/${thread.id}`,
    ready: (page) =>
      page.getByText("Cached conversation survives suspension").waitFor({ timeout: 60_000 }),
  },
  {
    name: "approval",
    path: `/mobile/thread/${thread.id}`,
    thread: approvalThread,
    ready: (page) =>
      page.getByRole("button", { name: "Approve", exact: true }).waitFor({ timeout: 60_000 }),
  },
  {
    name: "still-connecting",
    path: "/mobile",
    desktopUnreachable: true,
    ready: async (page, trace) => {
      const notice = page.getByText(/Still trying to reach the selected host/);
      // Keep the real refused WebSocket and retry policy, but don't let host load
      // consume the transient state before Playwright can observe it.
      for (let step = 0; step < 80 && !(await notice.isVisible()); step += 1) {
        await page.clock.runFor(500);
        await page.waitForTimeout(100);
        trace.push(
          await page.evaluate(() => ({
            time: Date.now(),
            ticks: performance.now(),
            body: document.body.innerText.slice(0, 200),
          })),
        );
      }
      await notice.waitFor({ timeout: 5_000 });
      await page.getByText("Connection details").click();
    },
  },
  {
    name: "pairing-unreachable",
    path: pairing,
    blockBackend: true,
    withoutSession: true,
    ready: async (page) => {
      await page.getByText("Connection details").waitFor({ timeout: 30_000 });
      await page.getByText("Connection details").click();
    },
  },
];

mkdirSync(OUT, { recursive: true });
const workspaceAliases = process.env.MOBILE_PARITY_ALIASES_PATH
  ? JSON.parse(readFileSync(process.env.MOBILE_PARITY_ALIASES_PATH, "utf8"))
  : [];
for (const alias of workspaceAliases) {
  if (
    typeof alias.find !== "string" ||
    !alias.find.startsWith("@bigbud/") ||
    typeof alias.replacement !== "string" ||
    !alias.replacement.startsWith("/parity/src/packages/") ||
    alias.replacement.includes("..")
  )
    throw new Error("Invalid fixture workspace alias");
}
const server = await createServer({
  root,
  configFile: `${root}vite.config.ts`,
  configLoader: "runner",
  cacheDir: mkdtempSync(join(tmpdir(), "bigbud-mobile-matrix-vite-")),
  resolve: { alias: workspaceAliases, dedupe: ["react", "react-dom", "@tanstack/react-query"] },
  server: { host: "127.0.0.1", port: PORT, strictPort: true, hmr: false },
});
await server.listen();
// Reuse the already typed disposable config fixture; never fetch a real host or profile.
const { parityShellServerConfig: serverConfig } = await server.ssrLoadModule(
  "/tests/browser/desktop-shell-reference/DesktopShellReference.data.ts",
);
const browser =
  process.env.MOBILE_MATRIX_ELECTRON === "1"
    ? await launchMatrixElectron()
    : await chromium.launch({ headless: true });
const results = [];
try {
  for (const theme of ["light", "dark"]) {
    for (const state of states.filter(
      (entry) =>
        !process.env.MOBILE_MATRIX_STATES ||
        process.env.MOBILE_MATRIX_STATES.split(",").includes(entry.name),
    )) {
      for (const size of sizes.filter(
        (entry) =>
          !process.env.MOBILE_MATRIX_SIZES ||
          process.env.MOBILE_MATRIX_SIZES.split(",").includes(entry.name),
      )) {
        const page = await browser.newPage({
          viewport: { width: size.width, height: size.height },
          isMobile: true,
          hasTouch: true,
          colorScheme: theme,
        });
        if (state.name === "empty-thread") {
          await page.clock.setFixedTime("2026-11-15T18:00:00.000Z");
          await page.addInitScript(() => {
            Math.random = () => 0.5;
          });
        }
        if (state.desktopUnreachable) {
          // This scenario is an online phone with an unreachable desktop. Docker has
          // no external network, so model only the browser signal; the WS still fails for real.
          await page.addInitScript(() => {
            Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
          });
        }
        const errors = [];
        const consoleErrors = [];
        const rpcTags = [];
        const socketPaths = [];
        const failedRequests = [];
        page.on("console", (message) => {
          if (message.type() === "error")
            consoleErrors.push(
              message
                .text()
                .replace(/([?&]token=)[^\s"']+/g, "$1[redacted]")
                .slice(0, 300),
            );
        });
        page.on("websocket", (socket) => socketPaths.push(new URL(socket.url()).pathname));
        page.on("requestfailed", (request) => {
          const url = new URL(request.url());
          failedRequests.push({
            origin: url.origin,
            path: url.pathname,
            error: request.failure()?.errorText,
          });
        });
        await page.route("**/*", (route) => {
          const url = new URL(route.request().url());
          if (url.origin === `http://127.0.0.1:${PORT}`) return route.continue();
          // Match the prior deterministic reference: no external font dependency.
          if (!["fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname))
            errors.push(`unexpected HTTP origin: ${url.origin}`);
          return route.abort();
        });
        page.on("pageerror", (error) => errors.push(error.message));
        if (state.desktopUnreachable || state.holdBaseline) {
          await page.clock.install();
          await page.clock.pauseAt(new Date(Date.now() + 1_000));
        }
        if (state.holdBaseline) await page.routeWebSocket("**/mobile-ws?*", () => {});
        if (!state.desktopUnreachable && !state.holdBaseline)
          await installMobileWsStub(page, {
            snapshot,
            thread: state.thread ?? thread,
            serverConfig,
            onRequest: (tag) => rpcTags.push(tag),
          });
        if (state.blockBackend) {
          await page.route("https://desk.tail1.ts.net/**", (route) => route.abort("failed"));
        }
        await page.addInitScript(
          ({ value, theme: chosen, withoutSession }) => {
            localStorage.setItem("bigbud:theme", chosen);
            if (!withoutSession) {
              localStorage.setItem("bigbud:mobile-web:session:v1", JSON.stringify(value));
            }
          },
          {
            // Offline states point at a closed loopback port: a real refused connection.
            value: state.desktopUnreachable
              ? { ...session, backendBaseUrl: "http://127.0.0.1:15799" }
              : session,
            theme,
            withoutSession: state.withoutSession === true,
          },
        );
        await page.goto(`http://127.0.0.1:${PORT}${state.path}`);
        let timerProgress = null;
        let readyEvidence = null;
        const readyTrace = [];
        try {
          if (!state.desktopUnreachable && !state.holdBaseline) {
            let timeout;
            try {
              timerProgress = await Promise.race([
                page.evaluate(() => new Promise((resolve) => setTimeout(() => resolve(true), 0))),
                new Promise((_, reject) => {
                  timeout = setTimeout(
                    () => reject(new Error("fixture timers stayed paused")),
                    2000,
                  );
                }),
              ]);
            } finally {
              clearTimeout(timeout);
            }
          }
          readyEvidence = (await state.ready(page, readyTrace)) ?? null;
          if (state.name === "empty-thread") {
            await page.locator('[data-chat-greeting-copy="true"]').waitFor();
          }
          if (["thread", "approval"].includes(state.name)) {
            if (state.name === "thread" && size.name.endsWith("keyboard")) {
              await page.locator("textarea").focus();
            }
            const label = state.name === "approval" ? "Approve" : "Send message";
            const control = page.getByRole("button", { name: label, exact: true });
            const bounds = await control.boundingBox();
            if (
              !bounds ||
              bounds.x < 0 ||
              bounds.y < 0 ||
              bounds.x + bounds.width > size.width ||
              bounds.y + bounds.height > size.height
            ) {
              errors.push(`${label} control is outside the viewport`);
            }
          }
        } catch (error) {
          const text = (await page.locator("body").innerText()).slice(0, 300);
          errors.push(`not ready: ${error.message.split("\n")[0]} | body: ${text}`);
        }
        await page.waitForTimeout(150);
        const actualViewport = await page.evaluate(() => ({
          width: window.innerWidth,
          documentWidth: document.documentElement.clientWidth,
          maxTouchPoints: navigator.maxTouchPoints,
          browserOnline: navigator.onLine,
        }));
        if (actualViewport.width !== size.width || actualViewport.documentWidth !== size.width)
          errors.push(`fixture CSS viewport differs: ${JSON.stringify(actualViewport)}`);
        if (actualViewport.maxTouchPoints < 1) errors.push("fixture must expose touch input");
        if (state.desktopUnreachable && !actualViewport.browserOnline)
          errors.push("unreachable-desktop fixture requires the browser online signal");
        const overflow = await page.evaluate(
          () => document.scrollingElement.scrollWidth - window.innerWidth,
        );
        const file = `${OUT}/${state.name}-${size.name}-${theme}.png`;
        await page.screenshot({
          animations: "disabled",
          caret: "hide",
          path: file,
          fullPage: false,
        });
        results.push({
          state: state.name,
          size: size.name,
          theme,
          overflowPx: overflow,
          actualViewport,
          timerProgress,
          readyEvidence,
          readyTrace,
          rpcTags,
          socketPaths,
          consoleErrors,
          failedRequests,
          errors,
          file,
        });
        await page.close();
        writeFileSync(
          `${OUT}/progress.json`,
          JSON.stringify({ complete: false, results }, null, 2),
        );
        if (process.env.MOBILE_MATRIX_FAIL_FAST === "1" && (overflow > 0 || errors.length > 0))
          throw new Error(`Matrix fixture failed at ${state.name}/${size.name}/${theme}`);
      }
    }
  }
} finally {
  await browser.close();
  await server.close();
}
const failures = results.filter((entry) => entry.overflowPx > 0 || entry.errors.length > 0);
writeFileSync(
  `${OUT}/results.json`,
  JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      results,
      failures,
      qualification:
        process.env.MOBILE_MATRIX_ELECTRON === "1"
          ? "Linux Electron Chromium CDP mobile/touch fixture; synthetic viewport sizes, external fonts blocked, no physical phone or backend qualification"
          : "Headless Chromium mobile fixture; synthetic viewport sizes and blocked external fonts",
    },
    null,
    2,
  ),
);
console.log(`captured ${results.length} screenshots; ${failures.length} with overflow or errors`);
if (failures.length > 0) process.exitCode = 1;
