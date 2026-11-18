import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  composerValue,
  confirmPair,
  enterMessage,
  holdCommand,
  openThread,
  readDraftMetadata,
  readyHost,
  switchHost,
  waitForRecorded,
} from "./mobile-host-access.actions.mjs";
import {
  closeResumeTransport,
  deliverRetiredRecoveryCallback,
  RESUME_SEQUENCES,
  setupHostResume,
  signalHostResume,
} from "./mobile-host-resume.fixture.mjs";

/** Actual App normal/StrictMode recovery; no physical-suspension or live-host claim. */
export async function captureMobileHostResume(browser, localOrigin, data) {
  const directory = process.env.MOBILE_HOST_ACCESS_OUTPUT_DIR ?? "/parity/results/host-resume";
  await mkdir(directory, { recursive: true });
  const results = [];
  for (const strict of [false, true]) {
    const name = `host-resume-${strict ? "strict" : "normal"}`;
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      colorScheme: "light",
      hasTouch: true,
    });
    const owned = await setupHostResume(page, localOrigin, data);
    const { state, unavailable, recoveryRequests, subscriptions, accepted, outcomes } = owned;
    const phases = [];
    const snapshot = async (phase) => {
      const record = { phase, drafts: await readDraftMetadata(page), rpcCount: state.rpc.length };
      phases.push(record);
      return record;
    };
    try {
      await confirmPair(page, "A", state, strict);
      await confirmPair(page, "B", state, strict);
      await switchHost(page, "A");
      await openThread(page, "A");
      await enterMessage(page, "A original uncertain prompt");
      const commandId = await holdCommand(page, state);
      const retiredSubscription = subscriptions.findLast((entry) => entry.host === "A");
      await snapshot("A-dispatched-before-loss");
      const hidden = await signalHostResume(page, { visible: false, online: false });
      assert.deepEqual(hidden, { visibility: "hidden", online: false });
      unavailable.add("A");
      closeResumeTransport(owned, "A");
      await waitForRecorded(
        page,
        () =>
          state.socketControls
            .filter((entry) => entry.host === "A")
            .every((entry) => entry.record.closed),
        "A transport must actually close",
      );
      const suspended = await snapshot("A-hidden-offline");
      assert.ok(
        suspended.drafts.some((draft) => draft.submitted?.commandId === commandId),
        "Original uncertain command must survive transport loss",
      );
      // Wall-clock jump models elapsed sleep without running thirty minutes of timers.
      // This is synthetic elapsed-time evidence, not a physical suspension test.
      await page.clock.install();
      const elapsedStart = await page.evaluate(() => Date.now());
      await page.clock.setSystemTime(new Date(elapsedStart + 30 * 60_000));
      const simulatedElapsedMs = await page.evaluate((start) => Date.now() - start, elapsedStart);
      assert.ok(
        simulatedElapsedMs >= 30 * 60_000,
        "Measure elapsed wall-clock jump without claiming physical suspension",
      );
      const resumed = await signalHostResume(page, { visible: true, online: true });
      assert.deepEqual(resumed, { visibility: "visible", online: true });
      await switchHost(page, "B");
      await openThread(page, "B");
      await enterMessage(page, "B-only resumed draft");
      const bBeforeLate = recoveryRequests.filter((request) => request.host === "B").length;
      const retired = await deliverRetiredRecoveryCallback(page, retiredSubscription);
      assert.equal(retired.retiredSocket, true);
      assert.equal(retired.delivered, true);
      await page.waitForTimeout(100);
      assert.equal(await composerValue(page), "B-only resumed draft");
      assert.equal(
        recoveryRequests.filter((request) => request.host === "B").length,
        bBeforeLate,
        "A queued callback cannot restart B recovery",
      );
      assert.ok(
        !(await page.locator("body").innerText()).includes("Host A private fixture content"),
      );
      await snapshot("B-after-retired-A-callback");

      const aRequestsWhileB = state.rpc.filter((request) => request.host === "A").length;
      const bRecoveryStart = recoveryRequests.length;
      await signalHostResume(page, { visible: false, online: false });
      unavailable.add("B");
      closeResumeTransport(owned, "B");
      await waitForRecorded(
        page,
        () =>
          state.socketControls
            .filter((entry) => entry.host === "B")
            .every((entry) => entry.record.closed),
        "B transport must actually close before resume",
      );
      unavailable.delete("B");
      await signalHostResume(page, { visible: true, online: true });
      await readyHost(page, "B");
      assert.equal(await composerValue(page), "B-only resumed draft");
      const bRecovery = recoveryRequests.slice(bRecoveryStart);
      assert.ok(bRecovery.some((request) => request.tag === "mobile.recovery.getBaseline"));
      assert.ok(bRecovery.every((request) => request.host === "B"));
      const bSubscriptions = bRecovery.filter((item) => item.tag === "mobile.recovery.subscribe");
      assert.ok(
        bSubscriptions.length > 0,
        "B must actually subscribe using its own recovered cursor",
      );
      for (const request of bSubscriptions) {
        assert.equal(request.serverEpoch, "host-B");
        assert.equal(request.baselineSequence, RESUME_SEQUENCES.B);
      }
      assert.ok(
        bRecovery.filter((request) => request.tag === "mobile.recovery.getBaseline").length <= 4,
        "Resume must keep baseline refresh bounded",
      );
      assert.equal(
        state.rpc.filter((request) => request.host === "A").length,
        aRequestsWhileB,
        "Resume cannot wake retired A subscriptions",
      );
      assert.ok(
        !state.rpc.some((request) => request.host === "B" && request.commandId === commandId),
      );
      await snapshot("B-current-after-own-resume");

      unavailable.delete("A");
      accepted.add(commandId);
      await switchHost(page, "A");
      await waitForRecorded(
        page,
        () =>
          outcomes.some(
            (entry) => entry.host === "A" && entry.commandId === commandId && entry.accepted,
          ),
        "Returning A must reconcile accepted receipt for its original command ID",
      );
      await page.waitForFunction(
        (id) =>
          Object.keys(sessionStorage)
            .filter(
              (key) =>
                key.startsWith("bigbud%3Amobile-composition%3Av2:") ||
                key.startsWith("bigbud%3Amobile-composition%3Av1:"),
            )
            .every((key) => {
              const draft = JSON.parse(sessionStorage.getItem(key));
              return (
                draft.submitted?.command?.commandId !== id || draft.submitted.status === "accepted"
              );
            }),
        commandId,
      );
      await snapshot("A-original-receipt-settled");
      await switchHost(page, "B");
      assert.equal(await composerValue(page), "B-only resumed draft");
      assert.equal(
        state.rpc.filter((request) => request.tag === "orchestration.dispatchCommand").length,
        1,
        "No resume, host switch or receipt check may redispatch the turn",
      );
      assert.deepEqual(state.errors, []);
      assert.deepEqual(state.rejected, []);
      assert.deepEqual(state.hmr, []);
      await page.screenshot({ path: join(directory, `${name}.png`), animations: "disabled" });
      const result = {
        name,
        status: "passed",
        commandId,
        dispatches: 1,
        retired,
        simulatedElapsedMs,
        phases,
        recoveryRequests,
        outcomes,
        sockets: state.sockets,
      };
      results.push(result);
      await writeFile(join(directory, `${name}.json`), JSON.stringify(result, null, 2));
    } catch (error) {
      const failure = {
        name,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        body: (await page.locator("body").innerText()).slice(0, 5000),
        phases,
        recoveryRequests,
        outcomes,
        rpc: state.rpc,
        sockets: state.sockets,
        errors: state.errors,
        rejected: state.rejected,
        hmr: state.hmr,
      };
      await writeFile(join(directory, `${name}-failure.json`), JSON.stringify(failure, null, 2));
      await page
        .screenshot({ path: join(directory, `${name}-failure.png`), animations: "disabled" })
        .catch(() => undefined);
      throw error;
    } finally {
      await page.clock.resume().catch(() => undefined);
      await page.close();
    }
  }
  const result = {
    directory,
    results,
    qualification:
      "Synthetic Linux Electron actual App; fictional HTTPS/RPC, real resume event handlers and closed native-WebSocket queued MessageEvent; elapsed30min clock jump is not physical suspension/cellular qualification",
  };
  await writeFile(join(directory, "results.json"), JSON.stringify(result, null, 2));
  return result;
}
