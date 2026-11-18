import assert from "node:assert/strict";
import { shouldCaptureHostCase } from "./mobile-host-access.selection.mjs";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HOSTS, HOSTED, installHostAccessRoutes } from "./mobile-host-access.routes.mjs";
import {
  COLLECTION_KEY,
  LEGACY_KEY,
  assertNoOverflow,
  composerValue,
  confirmPair,
  enterMessage,
  holdCommand,
  openThread,
  readyHost,
  readDraftMetadata,
  switchHost,
  waitForRecorded,
} from "./mobile-host-access.actions.mjs";

const hash = (value) =>
  createHash("sha256")
    .update(value ?? "")
    .digest("hex");
function summary(state) {
  return {
    draftSnapshots: state.draftSnapshots,
    http: state.http,
    rpc: state.rpc,
    sockets: state.sockets,
    errors: state.errors,
    rejected: state.rejected,
    hmr: state.hmr,
    navigations: state.navigations,
  };
}
function assertClean(state) {
  assert.deepEqual(state.errors, []);
  assert.deepEqual(state.rejected, []);
  assert.deepEqual(state.hmr, []);
}
export async function captureMobileHostAccess(browser, localOrigin, data) {
  const directory = process.env.MOBILE_HOST_ACCESS_OUTPUT_DIR ?? "/parity/results/host-access";
  await mkdir(directory, { recursive: true });
  const results = [];
  async function run(name, appOrigin, action) {
    if (!shouldCaptureHostCase(name)) return;
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      colorScheme: "light",
      hasTouch: true,
    });
    const state = await installHostAccessRoutes(page, {
      localOrigin,
      appOrigin,
      config: data.hostAccessConfig,
      descriptors: data.hostAccessDescriptors,
      sessions: data.hostAccessSessions,
    });
    try {
      const checks = await action(page, state);
      assertClean(state);
      await page.screenshot({ path: join(directory, `${name}.png`), animations: "disabled" });
      const result = { name, status: "passed", checks, ...summary(state) };
      results.push(result);
      await writeFile(join(directory, `${name}.json`), JSON.stringify(result, null, 2));
    } catch (error) {
      await page
        .screenshot({ path: join(directory, `${name}-failure.png`), animations: "disabled" })
        .catch(() => undefined);
      state.draftSnapshots = [
        ...(state.draftSnapshots ?? []),
        { phase: "failure", drafts: await readDraftMetadata(page).catch(() => []) },
      ];
      const failure = {
        name,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        body: (
          await page
            .locator("body")
            .innerText()
            .catch(() => "")
        ).slice(0, 5000),
        ...summary(state),
      };
      await writeFile(join(directory, `${name}-failure.json`), JSON.stringify(failure, null, 2));
      throw error;
    } finally {
      await page.close();
    }
  }

  for (const preexisting of [false, true])
    await run(
      `host-served-${preexisting ? "preserved-foreign-data" : "foreign-pair-link"}`,
      HOSTS.A,
      async (page, state) => {
        const foreign = data.hostAccessSessions.B;
        const legacyRaw = JSON.stringify(foreign);
        const collectionRaw = JSON.stringify({
          version: 2,
          entries: [
            {
              backendOrigin: HOSTS.B,
              pin: {
                authority: data.hostAccessDescriptors.B.authority,
                installationFingerprint: data.hostAccessDescriptors.B.installationFingerprint,
              },
              session: {
                sessionId: foreign.sessionId,
                sessionToken: foreign.sessionToken,
                backendBaseUrl: HOSTS.B,
                scope: foreign.scope,
                expiresAt: foreign.expiresAt,
              },
            },
          ],
          selectedAuthorityId: data.hostAccessDescriptors.B.authority.authorityId,
        });
        if (preexisting)
          await page.addInitScript(
            ({ appOrigin, legacyRaw, collectionRaw, legacyKey, collectionKey }) => {
              if (location.origin !== appOrigin) return;
              localStorage.setItem(legacyKey, legacyRaw);
              localStorage.setItem(collectionKey, collectionRaw);
            },
            {
              appOrigin: HOSTS.A,
              legacyRaw,
              collectionRaw,
              legacyKey: LEGACY_KEY,
              collectionKey: COLLECTION_KEY,
            },
          );
        await page.goto(
          preexisting
            ? `${HOSTS.A}/mobile`
            : `${HOSTS.A}/mobile/pair/fixture-pair-B?backend=${encodeURIComponent(HOSTS.B)}#secret=fixture-secret-B`,
        );
        await page
          .getByRole("heading", { name: "Open the host's own mobile app", exact: true })
          .waitFor({ timeout: 30_000 });
        assert.equal(state.http.length, 0);
        assert.equal(state.sockets.length, 0);
        const link = page.getByRole("link", { name: "Open host mobile app", exact: true });
        assert.equal(await link.getAttribute("href"), `${HOSTS.B}/mobile/`);
        await page.getByRole("button", { name: "Remember host link", exact: true }).click();
        const saved = await page.evaluate(
          ({ legacyKey, collectionKey }) => ({
            legacy: localStorage.getItem(legacyKey),
            collection: localStorage.getItem(collectionKey),
            directory: localStorage.getItem("bigbud:mobile-web:host-directory:v1"),
          }),
          { legacyKey: LEGACY_KEY, collectionKey: COLLECTION_KEY },
        );
        assert.equal(saved.legacy, preexisting ? legacyRaw : null);
        assert.equal(saved.collection, preexisting ? collectionRaw : null);
        assert.ok(saved.directory?.includes(HOSTS.B));
        assert.doesNotMatch(saved.directory, /token|secret|session|draft/i);
        await link.click();
        await page
          .getByRole("heading", { name: "Destination host fixture", exact: true })
          .waitFor();
        assert.equal(page.url(), `${HOSTS.B}/mobile/`);
        assert.equal(
          await page.evaluate(() => localStorage.length),
          0,
          "destination origin must not inherit A storage",
        );
        return {
          zeroForeignCredentialRequests: true,
          cleanTopNavigation: true,
          directoryCredentialFree: true,
          originalLegacyHash: hash(saved.legacy),
          originalCollectionHash: hash(saved.collection),
          destinationStorageEmpty: true,
        };
      },
    );

  for (const strict of [false, true])
    await run(`hosted-pair-switch-${strict ? "strict" : "normal"}`, HOSTED, async (page, state) => {
      await confirmPair(page, "A", state, strict);
      await confirmPair(page, "B", state, strict);
      const count = await page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)).entries.length,
        COLLECTION_KEY,
      );
      assert.equal(count, 2);
      await switchHost(page, "A");
      await openThread(page, "A");
      await enterMessage(page, "A-only retained draft");
      const commandId = await holdCommand(page, state);
      const held = state.held.find((entry) => entry.request.payload.commandId === commandId);
      assert.ok(held);
      await switchHost(page, "B");
      await waitForRecorded(
        page,
        () => held.record.closed,
        "old A socket must retire during replacement",
      );
      await openThread(page, "B");
      assert.equal(await composerValue(page), "");
      assert.ok(
        (await page.locator("body").innerText()).includes("Host B private fixture content"),
      );
      assert.ok(
        !(await page.locator("body").innerText()).includes("Host A private fixture content"),
      );
      await enterMessage(page, "B-only retained draft");
      await page.setViewportSize({ width: 390, height: 320 });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 320,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const shortViewport = await assertNoOverflow(page);
      await page.screenshot({
        path: join(directory, `hosted-${strict ? "strict" : "normal"}-short.png`),
        animations: "disabled",
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await switchHost(page, "A");
      await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
      assert.equal(
        new URL(page.url()).pathname,
        "/mobile/thread/thread-recovery",
        "A selection is restored only from A authority",
      );
      assert.equal(await composerValue(page), "A-only retained draft");
      await waitForRecorded(
        page,
        () =>
          state.rpc.some(
            (request) =>
              request.host === "A" &&
              request.tag === "mobile.recovery.getCommandOutcome" &&
              request.commandId === commandId,
          ),
        "original command receipt must be checked at original authority",
      );
      assert.equal(
        state.rpc.filter((request) => request.tag === "orchestration.dispatchCommand").length,
        1,
      );
      assert.ok(
        !state.rpc.some((request) => request.host === "B" && request.commandId === commandId),
      );
      await switchHost(page, "B");
      await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
      assert.equal(await composerValue(page), "B-only retained draft");
      const socketsBefore = state.sockets.filter((socket) => socket.host === "B").length;
      state.descriptors.B = {
        ...data.hostAccessDescriptors.B,
        authority: { ...data.hostAccessDescriptors.B.authority, authorityId: "d".repeat(32) },
      };
      const activeB = state.socketControls.findLast(
        (entry) => entry.host === "B" && !entry.record.closed,
      );
      assert.ok(activeB);
      activeB.socket.close({ code: 1013, reason: "fixture backend replacement" });
      await page
        .getByRole("heading", { name: "Cannot connect to this host", exact: true })
        .waitFor({ timeout: 30_000 });
      await page.getByText(/This address now belongs to a different backend/).waitFor();
      assert.equal(
        state.sockets.filter((socket) => socket.host === "B").length,
        socketsBefore,
        "retry pin failure cannot dial another credential socket",
      );
      state.descriptors.B = structuredClone(data.hostAccessDescriptors.B);
      await page.getByRole("button", { name: "Retry identity verification", exact: true }).click();
      await readyHost(page, "B");
      await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
      assert.equal(await composerValue(page), "B-only retained draft");
      assert.equal(
        state.rpc.filter((request) => request.tag === "orchestration.dispatchCommand").length,
        1,
      );
      return {
        firstSeenConsentRequired: true,
        exactTwoAuthorityEntries: count,
        privateDraftsAndCaches: true,
        commandId,
        dispatches: 1,
        originalReceiptAuthority: "A",
        selectionsRestored: true,
        retryIdentityRefusedBeforeSocket: true,
        compatibleRetryRetainsDraft: true,
        shortViewport,
      };
    });

  await run("host-served-existing-session-upgrade", HOSTS.A, async (page, state) => {
    const original = JSON.stringify(data.hostAccessSessions.A);
    await page.addInitScript(
      ({ origin, raw, key }) => {
        if (location.origin === origin) localStorage.setItem(key, raw);
      },
      { origin: HOSTS.A, raw: original, key: LEGACY_KEY },
    );
    await page.goto(`${HOSTS.A}/mobile?fixtureStrict=1`);
    await page.getByRole("link", { name: "Projects", exact: true }).waitFor({ timeout: 30_000 });
    await openThread(page, "A");
    await enterMessage(page, "Legacy A retained draft");
    const commandId = await holdCommand(page, state);
    await page.getByRole("button", { name: /Open Chats/ }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Verify current backend", exact: true }).click();
    const consent = page.getByRole("checkbox", {
      name: "I confirm this existing backend identity.",
      exact: true,
    });
    await consent.waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Save current host", exact: true }).isDisabled(),
      true,
    );
    await consent.check();
    await page.getByRole("button", { name: "Save current host", exact: true }).click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[aria-label^="Selected backend"]')].some((element) =>
        element.getAttribute("aria-label")?.includes("Connected and current"),
      ),
    );
    if (await page.getByRole("button", { name: "Close navigation", exact: true }).count())
      await page.getByRole("button", { name: "Close navigation", exact: true }).click();
    await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
    assert.equal(await composerValue(page), "Legacy A retained draft");
    const stored = await page.evaluate(
      ({ key, legacyKey }) => ({
        collection: JSON.parse(localStorage.getItem(key)),
        original: localStorage.getItem(legacyKey),
        drafts: Array.from({ length: sessionStorage.length }, (_, index) =>
          sessionStorage.key(index),
        )
          .filter((key) => key?.includes("mobile-composition"))
          .map((key) => ({ key, raw: sessionStorage.getItem(key) })),
      }),
      { key: COLLECTION_KEY, legacyKey: LEGACY_KEY },
    );
    assert.equal(stored.original, original);
    assert.equal(stored.collection.entries.length, 1);
    assert.equal(
      stored.collection.entries[0].session.sessionId,
      data.hostAccessSessions.A.sessionId,
    );
    const records = stored.drafts
      .filter((entry) => entry.raw.startsWith("{"))
      .map((entry) => ({ key: entry.key, value: JSON.parse(entry.raw) }));
    for (const version of ["v1", "v2"])
      assert.ok(
        records.some(
          (entry) =>
            entry.key.startsWith(encodeURIComponent(`bigbud:mobile-composition:${version}`)) &&
            entry.value.prompt === "Legacy A retained draft" &&
            entry.value.submitted?.command.commandId === commandId,
        ),
        "migration retains original draft and uncertain ID in both namespaces",
      );
    assert.equal(state.http.filter((item) => item.kind === "exchange").length, 0);
    assert.equal(
      state.rpc.filter((item) => item.tag === "orchestration.dispatchCommand").length,
      1,
    );
    return {
      sameSessionMigration: true,
      originalV1CredentialHash: hash(stored.original),
      originalDraftRetained: true,
      authorityDraftRetained: true,
      originalCommandId: commandId,
      noExchangeOrReplay: true,
    };
  });
  const result = {
    directory,
    results,
    qualification:
      "Synthetic Linux Electron HTTPS document/RPC routes; no real TLS/tailnet/VPS/phone/provider qualification",
  };
  await writeFile(join(directory, "results.json"), JSON.stringify(result, null, 2));
  return result;
}
