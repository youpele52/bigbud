import { chromium, type Page } from "playwright";
import { expect, it } from "vitest";

import { renderDevSshOwnerPickerPage } from "./sshOwnerDevPicker.page.ts";

const origin = "http://127.0.0.1:31937";
const executionTargetId = "ssh://fixture@127.0.0.1:2222";
const displayTarget = "fixture@[127.0.0.1]:2222";
const token = "test-picker-token";
const fingerprint = "SHA256:FixtureFingerprint+/42";

async function servePage(page: Page, html: string) {
  await page.route(`${origin}/`, (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
}

it("waits for Connect, approves only the displayed challenge, browses, and confirms restart state", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await servePage(page, renderDevSshOwnerPickerPage("", executionTargetId, displayTarget));
    const requests: Array<{ action: string; method: string; token: string | null; body: unknown }> =
      [];
    let disconnected = true;
    let trusted = false;
    let listingPath: string;
    await page.route(`${origin}/api/*`, async (route) => {
      const request = route.request();
      const action = new URL(request.url()).pathname.slice("/api/".length);
      const body = request.postDataJSON();
      requests.push({
        action,
        method: request.method(),
        token: await request.headerValue("x-bigbud-picker-token"),
        body,
      });
      switch (action) {
        case "connect":
          disconnected = false;
          break;
        case "disconnect":
          disconnected = true;
          break;
        case "trust":
          trusted = true;
          await route.fulfill({ json: { ok: true, value: { message: "SSH host trusted." } } });
          return;
        case "list":
          if (!trusted) {
            await route.fulfill({
              status: 409,
              json: {
                ok: false,
                message: "Approval required",
                challenge: {
                  challengeId: "fixture-challenge",
                  host: displayTarget,
                  keyType: "ssh-ed25519",
                  fingerprint,
                },
              },
            });
            return;
          }
          listingPath = body.path === "~" ? "/fixture" : body.path;
          await route.fulfill({
            json: {
              ok: true,
              value: {
                path: listingPath,
                homePath: "/fixture",
                folders:
                  listingPath === "/fixture" ? [{ name: "nested & literal", isGitRepo: true }] : [],
                truncated: false,
              },
            },
          });
          return;
      }
      await route.fulfill({ json: { ok: true, value: { disconnected } } });
    });

    await page.goto(`${origin}/#${token}`);
    await page.getByText("Rust SSH owner", { exact: true }).waitFor();
    await page.getByText(displayTarget, { exact: true }).waitFor();
    expect(page.url()).toBe(`${origin}/`);
    expect(requests).toHaveLength(0);
    const verify = page.getByRole("button", { name: "Verify and list" });
    expect(await verify.isDisabled()).toBe(true);

    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByText("Connect confirmed. Target is enabled.").waitFor();
    await verify.click();
    await page.getByText(fingerprint, { exact: true }).waitFor();
    await page.getByText("ssh-ed25519", { exact: true }).waitFor();
    expect(requests.map(({ action }) => action)).toEqual(["connect", "list"]);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByText("Host fingerprint was not approved.").waitFor();
    expect(requests.map(({ action }) => action)).toEqual(["connect", "list"]);
    await verify.click();
    await page.getByText(fingerprint, { exact: true }).waitFor();
    await page.getByRole("button", { name: "Trust this exact fingerprint" }).click();
    await page.getByText("Fingerprint approved. Choose Verify and list to retry.").waitFor();
    expect(requests.map(({ action }) => action)).toEqual(["connect", "list", "list", "trust"]);

    await verify.click();
    await page.getByRole("button", { name: "nested & literal (Git repository)" }).click();
    await page.getByText("/fixture/nested & literal", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Up", exact: true }).click();
    await page.getByText("/fixture", { exact: true }).waitFor();

    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await page.getByText("Disconnect confirmed. Target is disconnected.").waitFor();
    expect(await verify.isDisabled()).toBe(true);
    await page.getByRole("button", { name: "Restart Rust owner" }).click();
    await page.getByText("Rust owner restarted. Target is disconnected.").waitFor();
    await page.getByRole("button", { name: "Check status" }).click();
    await page.getByText("Status confirmed. Target is disconnected.").waitFor();

    expect(requests).toEqual(
      [
        ["connect", {}],
        ["list", { path: "~" }],
        ["list", { path: "~" }],
        ["trust", { challengeId: "fixture-challenge" }],
        ["list", { path: "~" }],
        ["list", { path: "/fixture/nested & literal" }],
        ["list", { path: "/fixture" }],
        ["disconnect", {}],
        ["restart-owner", {}],
        ["status", {}],
      ].map(([action, input]) => ({
        action,
        method: "POST",
        token,
        body: { ...(typeof input === "object" ? input : {}), executionTargetId },
      })),
    );
  } finally {
    await browser.close();
  }
});

it("renders labels as text and reports a failed transition without another request", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const label = '</script><title id="injected">injected</title>';
    await servePage(page, renderDevSshOwnerPickerPage(token, executionTargetId, label));
    const apiRequests: string[] = [];
    await page.route(`${origin}/api/*`, async (route) => {
      apiRequests.push(route.request().url());
      await route.fulfill({
        status: 503,
        json: { ok: false, message: "Rust SSH owner unavailable." },
      });
    });

    await page.goto(`${origin}/`);
    await page.getByText(label, { exact: true }).waitFor();
    expect(await page.locator("#injected").count()).toBe(0);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByText("Rust SSH owner unavailable.").waitFor();
    await page.getByText(/^Connection state unconfirmed/).waitFor();
    expect(await page.getByRole("button", { name: "Verify and list" }).isDisabled()).toBe(true);
    expect(apiRequests).toEqual([`${origin}/api/connect`]);
  } finally {
    await browser.close();
  }
});
