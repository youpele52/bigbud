// Actual route transition with an unsettled decision: no reload and no cross-thread check.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";
import { chromium } from "../../../web/node_modules/playwright/index.mjs";
import { session, snapshot, thread } from "./recovery.fixture.mjs";
import { launchMatrixElectron } from "./baseline-matrix.electron.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const origin = "http://127.0.0.1:15747";
const second = { ...thread, id: "thread-second", title: "Second thread" };
const aliases = process.env.MOBILE_PARITY_ALIASES_PATH
  ? JSON.parse(readFileSync(process.env.MOBILE_PARITY_ALIASES_PATH, "utf8"))
  : [];
for (const alias of aliases) {
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
  cacheDir: mkdtempSync(join(tmpdir(), "bigbud-mobile-thread-isolation-vite-")),
  resolve: { alias: aliases, dedupe: ["react", "react-dom", "@tanstack/react-query"] },
  server: { host: "127.0.0.1", port: 15747, strictPort: true, hmr: false },
});
await server.listen();
const browser =
  process.env.MOBILE_TEST_ELECTRON === "1"
    ? await launchMatrixElectron()
    : await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  colorScheme: "light",
});
const checks = [];
const dispatches = [];
await page.route("https://fonts.googleapis.com/**", (route) => route.abort());
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.routeWebSocket("**/mobile-ws?*", (ws) => {
  const exit = (request, value) =>
    ws.send(
      JSON.stringify({ _tag: "Exit", requestId: request.id, exit: { _tag: "Success", value } }),
    );
  ws.onMessage((message) => {
    const request = JSON.parse(String(message));
    if (request._tag !== "Request") return;
    if (request.tag === "orchestration.dispatchCommand") dispatches.push(request.payload);
    if (request.tag === "mobile.recovery.getBaseline") {
      const selected = request.payload.selectedThreadId;
      exit(request, {
        version: 1,
        recoveryAttemptId: request.payload.recoveryAttemptId,
        serverEpoch: "isolation",
        snapshotSequence: 0,
        snapshot: { ...snapshot, threads: [thread, second] },
        selectedThread: selected
          ? { status: "present", thread: selected === second.id ? second : thread }
          : null,
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
              serverEpoch: "isolation",
              recoveryAttemptId: request.payload.recoveryAttemptId,
              type: "caught-up",
              throughSequence: 0,
            },
          ],
        }),
      );
    } else if (request.tag === "mobile.recovery.getCommandOutcome") {
      checks.push(request.payload);
      // Leave A uncertain; no reply is needed for checking B's independence.
    }
  });
});
await page.addInitScript(
  (value) => localStorage.setItem("bigbud:mobile-web:session:v1", JSON.stringify(value)),
  { ...session, backendBaseUrl: origin },
);
try {
  await page.goto(`${origin}/mobile`);
  await page.getByText("New chat", { exact: true }).waitFor({ timeout: 60_000 });
  await page.evaluate(
    async ({ origin, sessionId, threadId }) => {
      const drafts = await import("/src/lib/mobileComposerDraft.ts");
      const identity = drafts.makeMobileComposerDraftIdentity({
        backendBaseUrl: origin,
        sessionId,
        threadId,
      });
      drafts.writeMobileComposerDraft(identity, {
        ...drafts.createMobileComposerDraft({ threadId }),
        prompt: "draft A",
        decisionSubmitted: {
          command: {
            type: "thread.approval.respond",
            commandId: "decision-A",
            threadId,
            requestId: "approval-A",
            decision: "accept",
            createdAt: new Date().toISOString(),
          },
          submittedRevision: 1,
          submittedAt: new Date().toISOString(),
          deadlineAt: 0,
          status: "uncertain",
        },
      });
    },
    { origin, sessionId: session.sessionId, threadId: thread.id },
  );
  const navigate = async (id) =>
    page.evaluate((id) => {
      history.pushState(null, "", `/mobile/thread/${id}`);
      dispatchEvent(new PopStateEvent("popstate"));
    }, id);
  await page.evaluate(() => {
    window.routeIsolationDocument = "same-document";
  });
  await navigate(thread.id);
  await page.waitForFunction(() => document.querySelector("textarea")?.value === "draft A");
  const originalTextarea = await page.locator("textarea").elementHandle();
  assert.ok(originalTextarea);
  await page.waitForTimeout(100);
  await navigate(second.id);
  await page.waitForFunction(() => document.querySelector("textarea")?.value === "");
  assert.equal(
    await originalTextarea.evaluate((element) => element.isConnected),
    false,
    "actual keyed route must unmount A's hook tree before B",
  );
  const beforeB = await page.evaluate(
    async ({ origin, sessionId, threadId }) => {
      const drafts = await import("/src/lib/mobileComposerDraft.ts");
      return drafts.readMobileComposerDraft(
        drafts.makeMobileComposerDraftIdentity({
          backendBaseUrl: origin,
          sessionId,
          threadId,
        }),
      ).draft;
    },
    { origin, sessionId: session.sessionId, threadId: second.id },
  );
  assert.equal(beforeB?.prompt ?? "", "");
  assert.equal(beforeB?.submitted ?? null, null);
  assert.equal(beforeB?.decisionSubmitted ?? null, null);
  await page.locator("textarea").fill("draft B");
  await page.getByRole("button", { name: "Send message", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Send message", exact: true }).isEnabled(),
    true,
  );
  assert.equal(
    checks.some((check) => check.threadId === second.id && check.commandId === "decision-A"),
    false,
  );
  const bDraft = await page.evaluate(
    async ({ origin, sessionId, threadId }) => {
      const drafts = await import("/src/lib/mobileComposerDraft.ts");
      return drafts.readMobileComposerDraft(
        drafts.makeMobileComposerDraftIdentity({ backendBaseUrl: origin, sessionId, threadId }),
      ).draft;
    },
    { origin, sessionId: session.sessionId, threadId: second.id },
  );
  assert.equal(bDraft?.decisionSubmitted ?? null, null);
  assert.equal(bDraft?.submitted ?? null, null);
  assert.equal(bDraft?.prompt, "draft B");
  await navigate(thread.id);
  await page.waitForFunction(() => document.querySelector("textarea")?.value === "draft A");
  assert.equal(dispatches.length, 0, "route remounts must not replay the uncertain mutation");
  assert.equal(await page.evaluate(() => window.routeIsolationDocument), "same-document");
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      routeSwitchIsolated: true,
      keyedRouteRemount: true,
      draftsRetained: true,
      noMutationReplay: true,
      checks,
      pageErrors: errors,
    }),
  );
} finally {
  await browser.close();
  await server.close();
}
