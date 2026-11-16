import {
  CONTROL_DIRECTORY,
  CONTROL_ORIGINS,
  controlGeometry,
  controlFocusSettled,
  inspectGeometry,
} from "./mobile-host-controls.fixture.mjs";

export async function captureBlockedHostControls({
  page,
  state,
  release,
  data,
  size,
  capture,
  check,
}) {
  await page
    .getByRole("heading", { name: "Verifying backend identity", exact: true })
    .waitFor({ timeout: 30_000 });
  check("pending-no-credential-socket", state.sockets.length === 0);
  await capture("pending");
  release();
  await page.getByRole("heading", { name: "Cannot connect to this host", exact: true }).waitFor();
  const blocked = await controlGeometry(page, size);
  for (const issue of inspectGeometry(blocked)) check(issue, false);
  await capture("admission-error");

  const trigger = page.getByRole("button", {
    name: new RegExp(`^Selected backend ${CONTROL_ORIGINS.A.replaceAll(".", "\\.")}`),
  });
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  const menu = page.getByRole("menu");
  await menu.waitFor();
  const menuKeyboardFocus = await page
    .waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitem", null, {
      timeout: 500,
    })
    .then(
      () => true,
      () => false,
    );
  check("keyboard-menu-focus", menuKeyboardFocus);
  const menuGeometry = await controlGeometry(page, size);
  for (const issue of inspectGeometry(menuGeometry)) check(issue, false);
  for (const entry of CONTROL_DIRECTORY) {
    const item = page.locator(`[role="menu"] a[href="${entry.backendOrigin}/mobile/"]`);
    check(
      "directory-menu-destination-visible",
      (await item.innerText()).includes(entry.backendOrigin),
      { origin: entry.backendOrigin },
    );
    check(
      "directory-menu-clean-top-link",
      (await item.getAttribute("referrerpolicy")) === "no-referrer",
    );
  }
  await capture("host-menu");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  const menuFocusReturned = await controlFocusSettled(trigger);
  const menuFocus = await trigger.evaluate((element) => ({
    connected: element.isConnected,
    triggerHTML: element.outerHTML,
    inertAncestor: element.closest("[inert]")?.outerHTML.slice(0, 400),
    tabIndex: element.tabIndex,
    activeTag: document.activeElement?.tagName,
    activeText: document.activeElement?.textContent?.slice(0, 250),
    activeRole: document.activeElement?.getAttribute("role"),
  }));
  check("menu-focus-return", menuFocusReturned, menuFocus);

  // Outside-click dismissal must preserve the user's deliberate next target.
  await trigger.click();
  await menu.waitFor();
  const outsideRetry = page.getByRole("button", {
    name: "Retry identity verification",
    exact: true,
  });
  const outsideBox = await outsideRetry.boundingBox();
  // The modal menu's backdrop intentionally consumes the first outside pointer
  // press. Use a real pointer press to dismiss, then activate the exposed target.
  await page.mouse.click(outsideBox.x + 2, outsideBox.y + 22);
  await menu.waitFor({ state: "hidden" });
  await outsideRetry.click();
  await page.getByRole("heading", { name: "Cannot connect to this host", exact: true }).waitFor();
  check("outside-click-focus-not-stolen", await controlFocusSettled(outsideRetry));

  // Real sequential keyboard/pointer input; deterministic dequeued-frame races
  // are covered independently by the focus owner's held-callback tests.
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await menu.waitFor();
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  await trigger.click();
  await menu.waitFor();
  const reopenedFocus = await page
    .waitForFunction(() => document.activeElement?.closest('[role="menu"]') !== null, null, {
      timeout: 500,
    })
    .then(
      () => true,
      () => false,
    );
  check("quick-reopen-keeps-menu-focus", reopenedFocus);
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  check("quick-reopen-escape-focus-return", await controlFocusSettled(trigger));

  const forget = page.getByRole("button", { name: "Forget host", exact: true });
  await forget.click();
  const keep = page.getByRole("button", { name: "Keep host", exact: true });
  check("forget-open-focuses-cancel", await controlFocusSettled(keep));
  await keep.click();
  await forget.waitFor();
  check("cancel-forget-focus-return", await controlFocusSettled(forget));
  await forget.click();
  await page.getByRole("button", { name: "Forget this host", exact: true }).waitFor();
  await page.evaluate((authority) => {
    const key = "bigbud:mobile-web:hosts:v2";
    const raw = JSON.parse(localStorage.getItem(key));
    raw.selectedAuthorityId = authority;
    const value = JSON.stringify(raw);
    localStorage.setItem(key, value);
    window.dispatchEvent(
      new StorageEvent("storage", { key, newValue: value, storageArea: localStorage }),
    );
  }, data.hostAccessDescriptors.B.authority.authorityId);
  await page
    .getByRole("button", {
      name: new RegExp(`^Selected backend ${CONTROL_ORIGINS.B.replaceAll(".", "\\.")}`),
    })
    .waitFor();
  await page.getByRole("heading", { name: "Cannot connect to this host", exact: true }).waitFor();
  check(
    "forget-confirmation-invalidated-by-target-change",
    (await page.getByRole("button", { name: "Forget this host", exact: true }).count()) === 0,
  );
  check(
    "changing-target-does-not-forget-either-host",
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("bigbud:mobile-web:hosts:v2")).entries.length === 2,
    ),
  );
  await capture("changed-target");

  const retry = page.getByRole("button", { name: "Retry identity verification", exact: true });
  const before = state.http.filter((entry) => entry.kind === "handshake").length;
  await retry.click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[role="alert"]')].some((element) =>
      element.textContent.includes("not enabled and ready"),
    ),
  );
  check(
    "retry-rechecks-identity-without-credentials",
    state.http.filter((entry) => entry.kind === "handshake").length > before &&
      state.sockets.length === 0,
  );
  check("retry-focus-return", await controlFocusSettled(retry));
  // Start a fresh, explicit confirmation for B even when the earlier target-invalidating RED failed.
  const priorKeep = page.getByRole("button", { name: "Keep host", exact: true });
  if (await priorKeep.count()) await priorKeep.click();
  await page.getByRole("button", { name: "Forget host", exact: true }).click();
  await page.getByRole("button", { name: "Forget this host", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => JSON.parse(localStorage.getItem("bigbud:mobile-web:hosts:v2")).entries.length === 1,
  );
  check(
    "explicit-forget-preserves-other-authority",
    await page.evaluate((authority) => {
      const value = JSON.parse(localStorage.getItem("bigbud:mobile-web:hosts:v2"));
      return (
        value.entries[0].pin.authority.authorityId === authority &&
        value.selectedAuthorityId === null
      );
    }, data.hostAccessDescriptors.A.authority.authorityId),
  );
  // Retiring the screen after real input must not return focus to its old menu.
  await page.evaluate((authority) => {
    const key = "bigbud:mobile-web:hosts:v2";
    const raw = JSON.parse(localStorage.getItem(key));
    raw.selectedAuthorityId = authority;
    const value = JSON.stringify(raw);
    localStorage.setItem(key, value);
    window.dispatchEvent(
      new StorageEvent("storage", { key, newValue: value, storageArea: localStorage }),
    );
  }, data.hostAccessDescriptors.A.authority.authorityId);
  await trigger.waitFor();
  await page.getByRole("heading", { name: "Cannot connect to this host", exact: true }).waitFor();
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await menu.waitFor();
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Leave selected host", exact: true }).click();
  await trigger.waitFor({ state: "hidden" });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  check(
    "unmounted-menu-does-not-reclaim-focus",
    await page.evaluate(
      () => !document.activeElement?.getAttribute("aria-label")?.startsWith("Selected backend"),
    ),
  );
  return { blocked, menuGeometry, credentialSockets: state.sockets.length };
}
