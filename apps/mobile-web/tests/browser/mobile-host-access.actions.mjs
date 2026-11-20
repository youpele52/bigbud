import assert from "node:assert/strict";
import { HOSTS, HOSTED } from "./mobile-host-access.routes.mjs";

export const COLLECTION_KEY = "bigbud:mobile-web:hosts:v2";
export const LEGACY_KEY = "bigbud:mobile-web:session:v1";
export async function waitForRecorded(page, predicate, message) {
  const deadline = Date.now() + 15_000;
  while (!predicate() && Date.now() < deadline) await page.waitForTimeout(30);
  assert.ok(predicate(), message);
}
export async function readyHost(page, host) {
  await page
    .getByRole("button", {
      name: new RegExp(
        `Selected backend ${HOSTS[host].replaceAll(".", "\\.")}. Connected and current`,
      ),
    })
    .waitFor({ timeout: 30_000 });
}
export async function switchHost(page, host) {
  await page.getByRole("button", { name: /Selected backend .*Change host/ }).click();
  await page
    .getByRole("menuitem", { name: new RegExp(HOSTS[host].replaceAll(".", "\\.")) })
    .click();
  await readyHost(page, host);
  assert.equal(new URL(page.url()).origin, HOSTED, "hosted compatibility switches in place");
}
export async function openThread(page, host) {
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await page.getByRole("link", { name: new RegExp(`Host ${host} project`) }).click();
  await page.getByRole("link", { name: new RegExp(`Host ${host} thread`) }).click();
  await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
  await page.getByRole("heading", { name: `Host ${host} thread`, exact: true }).waitFor();
}
export async function confirmPair(page, host, state, strict) {
  const before = state.http.filter((item) => item.kind === "exchange").length;
  await page.goto(
    `${HOSTED}/mobile/pair/fixture-pair-${host}?backend=${encodeURIComponent(HOSTS[host])}&fixtureStrict=${strict ? "1" : "0"}#secret=fixture-secret-${host}`,
  );
  const checkbox = page.getByRole("checkbox", {
    name: "I confirm this backend identity and pairing target.",
    exact: true,
  });
  await checkbox.waitFor({ timeout: 30_000 });
  const confirm = page.getByRole("button", { name: "Confirm pairing", exact: true });
  assert.equal(
    await confirm.isDisabled(),
    true,
    "first contact cannot send a pairing secret before consent",
  );
  assert.equal(state.http.filter((item) => item.kind === "exchange").length, before);
  await checkbox.check();
  await confirm.click();
  await readyHost(page, host);
  assert.equal(state.http.filter((item) => item.kind === "exchange").length, before + 1);
}
export async function enterMessage(page, text) {
  const field = page.getByRole("textbox", { name: "Message", exact: true });
  await field.fill(text);
  await page.waitForFunction(
    (expected) =>
      [...Array(sessionStorage.length)].some((_, index) => {
        const key = sessionStorage.key(index);
        if (!key?.includes("mobile-composition")) return false;
        try {
          return JSON.parse(sessionStorage.getItem(key) ?? "null")?.prompt === expected;
        } catch {
          return false;
        }
      }),
    text,
  );
}
export async function holdCommand(page, state) {
  const before = state.rpc.filter((item) => item.tag === "orchestration.dispatchCommand").length;
  const send = page.getByRole("button", { name: "Send message", exact: true });
  await page.waitForFunction(
    () => !document.querySelector('button[aria-label="Send message"]')?.disabled,
  );
  await send.click();
  await waitForRecorded(
    page,
    () =>
      state.rpc.filter((item) => item.tag === "orchestration.dispatchCommand").length ===
      before + 1,
    "the held command must actually reach RPC before replacement",
  );
  const command = state.rpc.findLast((item) => item.tag === "orchestration.dispatchCommand");
  assert.equal(command?.host, "A");
  assert.ok(command?.commandId);
  state.draftSnapshots = [{ phase: "after-real-dispatch", drafts: await readDraftMetadata(page) }];
  return command.commandId;
}
export async function composerValue(page) {
  return page.getByRole("textbox", { name: "Message", exact: true }).inputValue();
}
export async function assertNoOverflow(page) {
  const result = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    send: document
      .querySelector('button[aria-label="Send message"]')
      ?.getBoundingClientRect()
      .toJSON(),
  }));
  assert.ok(result.scroll <= result.width, "selected-host UI must not cause horizontal overflow");
  if (result.send)
    assert.ok(
      result.send.height >= 44 && result.send.width >= 44 && result.send.bottom <= 320 + 1,
      "short viewport keeps send target reachable",
    );
  return result;
}

/** Fixture-only durable operation metadata; session tokens and pairing secrets are excluded. */
export async function readDraftMetadata(page) {
  return page.evaluate(() =>
    Object.keys(sessionStorage)
      .filter(
        (key) =>
          key.startsWith("bigbud%3Amobile-composition%3Av2:") ||
          key.startsWith("bigbud%3Amobile-composition%3Av1:"),
      )
      .map((key) => {
        const draft = JSON.parse(sessionStorage.getItem(key));
        return {
          key,
          prompt: draft.prompt,
          revision: draft.revision,
          submitted: draft.submitted && {
            commandId: draft.submitted.command?.commandId,
            status: draft.submitted.status,
          },
          decisionSubmitted: draft.decisionSubmitted && {
            commandId: draft.decisionSubmitted.command?.commandId,
            status: draft.decisionSubmitted.status,
          },
        };
      }),
  );
}
