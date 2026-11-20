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
  waitForRecorded,
} from "./mobile-host-access.actions.mjs";
import {
  setupHostRenewal,
  retainRenewalSocket,
  navigateRenewal,
  deliverRetiredRenewalExit,
  assertRenewalClean,
} from "./mobile-host-renewal.fixture.mjs";

export async function captureMobileHostRenewal(browser, localOrigin, data) {
  const directory = process.env.MOBILE_HOST_ACCESS_OUTPUT_DIR ?? "/parity/results/host-renewal";
  await mkdir(directory, { recursive: true });
  const results = [];
  for (const { strict, readOnly } of [
    { strict: false, readOnly: false },
    { strict: true, readOnly: false },
    { strict: false, readOnly: true },
    { strict: true, readOnly: true },
  ]) {
    const name = `same-host-renewal-${strict ? "strict" : "normal"}${readOnly ? "-read-only" : ""}`;
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      colorScheme: "light",
      hasTouch: true,
    });
    const owned = await setupHostRenewal(page, localOrigin, data);
    let stage = "initial-pair";
    try {
      await confirmPair(page, "A", owned.state, strict);
      await openThread(page, "A");
      const prompt = "Retain this same-host uncertain draft";
      await enterMessage(page, prompt);
      const commandId = await holdCommand(page, owned.state);
      const held = owned.state.held.find((entry) => entry.request.payload.commandId === commandId);
      assert.ok(held);
      await retainRenewalSocket(page);
      const before = await readDraftMetadata(page);
      const old = { ...owned.sessions.A };
      owned.sessions.A = {
        ...old,
        sessionId: "renewed-session-A",
        sessionToken: "fixture-host-a-renewed",
        ...(readOnly ? { scope: "read-only" } : {}),
      };
      stage = "explicit-authenticated-renewal";
      await navigateRenewal(page, strict);
      const confirm = page.getByRole("button", { name: "Confirm pairing", exact: true });
      await page.waitForFunction(
        () =>
          ![...document.querySelectorAll("button")].find(
            (button) => button.textContent === "Confirm pairing",
          )?.disabled,
      );
      await confirm.click();
      await readyHost(page, "A");
      await waitForRecorded(
        page,
        () => owned.state.sockets.some((record) => record.sessionId === "renewed-session-A"),
        "replacement must actually use its new session/runtime",
      );
      await waitForRecorded(page, () => held.record.closed, "old session transport must retire");
      // The shared fixture's onClose observer disables Playwright's automatic close forwarding.
      // Acknowledge the already-observed client retirement; never initiate it for the application.
      held.socket.close({ code: 1000, reason: "fixture acknowledges client retirement" });
      if (readOnly) {
        await page.getByRole("link", { name: "Projects", exact: true }).click();
        await page.getByRole("link", { name: /Host A project/ }).click();
        await page.getByRole("link", { name: /Host A thread/ }).click();
        await page
          .getByRole("textbox", { name: "Retained draft from previous authorization", exact: true })
          .waitFor();
      } else await openThread(page, "A");
      const draftValue = () =>
        readOnly
          ? page
              .getByRole("textbox", {
                name: "Retained draft from previous authorization",
                exact: true,
              })
              .inputValue()
          : composerValue(page);
      stage = "retained-draft-visible";
      const visible = await draftValue();
      const after = await readDraftMetadata(page);
      await writeFile(
        join(directory, `${name}-before-assert.json`),
        JSON.stringify({ before, after, visible, rpcOwners: owned.rpcOwners }, null, 2),
      );
      assert.equal(visible, prompt, "same verified host renewal must retain its visible draft");
      await page
        .getByText("This message was sent under the previous authorization.", { exact: false })
        .waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Check delivery", exact: true }).count(),
        0,
      );
      assert.equal(await page.getByRole("button", { name: "Send again", exact: true }).count(), 0);
      if (readOnly) {
        assert.equal(
          await page.getByRole("button", { name: "Send message", exact: true }).count(),
          0,
        );
        assert.equal(
          await page
            .getByRole("textbox", {
              name: "Retained draft from previous authorization",
              exact: true,
            })
            .getAttribute("readonly"),
          "",
        );
      }
      const provenance = await page.evaluate(() =>
        Object.keys(sessionStorage)
          .filter(
            (key) =>
              key.startsWith("bigbud%3Amobile-composition%3Av2:") &&
              key.includes("renewed-session-A"),
          )
          .map((key) => {
            const draft = JSON.parse(sessionStorage.getItem(key));
            return {
              version: draft.version,
              source: draft.submitted?.receiptSource,
              commandId: draft.submitted?.command.commandId,
            };
          }),
      );
      assert.ok(
        provenance.some(
          (draft) =>
            draft.version === 2 &&
            draft.source?.sessionId === old.sessionId &&
            draft.commandId === commandId,
        ),
      );
      stage = "late-retired-callback";
      const late = await deliverRetiredRenewalExit(page, held);
      await page.waitForTimeout(50);
      assert.equal(await draftValue(), prompt);
      assert.equal(
        owned.state.rpc.filter((entry) => entry.tag === "orchestration.dispatchCommand").length,
        1,
        "renewal/late callback must never redispatch an uncertain command",
      );
      assert.ok(
        (await readDraftMetadata(page)).some(
          (draft) =>
            draft.submitted?.commandId === commandId ||
            draft.decisionSubmitted?.commandId === commandId,
        ),
      );
      assert.equal(
        owned.rpcOwners.filter(
          (rpc) =>
            rpc.sessionId === "renewed-session-A" &&
            rpc.tag === "mobile.recovery.getCommandOutcome",
        ).length,
        0,
        "a replacement authorization cannot query the old grant's receipt",
      );
      assertRenewalClean(owned);
      const result = {
        name,
        status: "passed",
        commandId,
        before,
        after,
        late,
        provenance,
        rpcOwners: owned.rpcOwners,
        sockets: owned.state.sockets,
      };
      results.push(result);
      await page.screenshot({ path: join(directory, `${name}.png`), animations: "disabled" });
      await writeFile(join(directory, `${name}.json`), JSON.stringify(result, null, 2));
      stage = "explicit-forget-after-renewal";
      await page.getByRole("button", { name: /Open Chats/ }).click();
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Forget this connection", exact: true }).click();
      await page.getByRole("button", { name: "Forget connection", exact: true }).click();
      await page.waitForFunction(
        () => JSON.parse(localStorage.getItem("bigbud:mobile-web:hosts:v2")).entries.length === 0,
        undefined,
        { timeout: 5000 },
      );
      const forgottenDrafts = await readDraftMetadata(page);
      assert.equal(
        forgottenDrafts.filter(
          (draft) =>
            draft.key.includes("renewed-session-A") ||
            draft.key.includes(encodeURIComponent(old.sessionId)),
        ).length,
        0,
        "explicit Forget must clear the selected and completed-renewal source namespaces",
      );
      await writeFile(
        join(directory, `${name}-forget.json`),
        JSON.stringify({ status: "passed", forgottenDrafts }, null, 2),
      );
    } catch (error) {
      const failure = {
        name,
        stage,
        status: "failed",
        error: String(error),
        body: (await page.locator("body").innerText()).slice(0, 6000),
        drafts: await readDraftMetadata(page),
        rpcOwners: owned.rpcOwners,
        sockets: owned.state.sockets,
        errors: owned.state.errors,
        rejected: owned.state.rejected,
      };
      await page
        .screenshot({ path: join(directory, `${name}-failure.png`), animations: "disabled" })
        .catch(() => {});
      await writeFile(join(directory, `${name}-failure.json`), JSON.stringify(failure, null, 2));
      throw error;
    } finally {
      await page.close();
    }
  }
  return {
    directory,
    results,
    qualification:
      "Actual App with fictional HTTPS full-pin renewal; StrictMode; queued retired callback simulation, no real gateway/phone/provider.",
  };
}
