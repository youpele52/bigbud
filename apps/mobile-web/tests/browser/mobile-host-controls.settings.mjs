import {
  CONTROL_DIRECTORY,
  CONTROL_ORIGINS,
  controlGeometry,
  inspectGeometry,
} from "./mobile-host-controls.fixture.mjs";

export async function captureHostSettingsControls({ page, data, size, capture, check }) {
  await page.getByRole("link", { name: "Projects", exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: /Open Chats/ }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const drawer = page.getByRole("dialog");
  await drawer.waitFor();
  const frame = await drawer.boundingBox();
  check(
    "settings-fit-visible-height",
    frame.height <= (size.visibleHeight ?? size.height) + 1 &&
      frame.y >= -1 &&
      frame.y + frame.height <= (size.visibleHeight ?? size.height) + 1,
    frame,
  );
  const field = page.getByRole("textbox", { name: "Private HTTPS origin", exact: true });
  await field.scrollIntoViewIfNeeded();
  await field.fill("not-an-origin");
  const remember = page.getByRole("button", { name: "Remember host link", exact: true });
  await remember.click();
  await page
    .getByText("Enter an HTTPS origin without a path, query or credentials.", { exact: true })
    .waitFor();
  const extra = `https://${"e".repeat(63)}.example.invalid`;
  await field.fill(extra);
  await field.focus();
  await page.keyboard.press("Tab");
  check(
    "directory-keyboard-order",
    await remember.evaluate((element) => element === document.activeElement),
  );
  await page.keyboard.press("Space");
  await page.locator(`section[aria-label="Host links"] a[href="${extra}/mobile/"]`).waitFor();
  check("directory-input-cleared-after-save", (await field.inputValue()) === "");
  check(
    "directory-stores-no-credentials",
    await page.evaluate(
      () =>
        !/token|secret|session|draft/i.test(
          localStorage.getItem("bigbud:mobile-web:host-directory:v1"),
        ),
    ),
  );
  for (const entry of CONTROL_DIRECTORY) {
    const link = page.locator(
      `section[aria-label="Host links"] a[href="${entry.backendOrigin}/mobile/"]`,
    );
    check(
      "directory-settings-destination-visible",
      (await link.innerText()).includes(entry.backendOrigin),
      { origin: entry.backendOrigin },
    );
  }
  const drawerWidth = await drawer.locator('[data-slot="drawer-content"]').evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
    tracks: [...element.querySelectorAll("dl, dl > div")].map((node) => ({
      tag: node.tagName,
      width: node.getBoundingClientRect().width,
      client: node.clientWidth,
      scroll: node.scrollWidth,
      minWidth: getComputedStyle(node).minWidth,
      columns: getComputedStyle(node).gridTemplateColumns,
    })),
  }));
  check(
    "settings-drawer-no-horizontal-scroll",
    drawerWidth.scroll <= drawerWidth.client + 1,
    drawerWidth,
  );
  const directoryGeometry = await controlGeometry(page, size, 'section[aria-label="Host links"]');
  for (const issue of inspectGeometry(directoryGeometry)) check(issue, false);
  await capture("host-directory");

  const verify = page.getByRole("button", { name: "Verify current backend", exact: true });
  await verify.scrollIntoViewIfNeeded();
  await verify.click();
  const consent = page.getByRole("checkbox", {
    name: "I confirm this existing backend identity.",
    exact: true,
  });
  await consent.waitFor();
  const save = page.getByRole("button", { name: "Save current host", exact: true });
  check("legacy-upgrade-explicit-consent", await save.isDisabled());
  const panel = page.locator('section[aria-label="Save current backend identity"]');
  check(
    "legacy-upgrade-full-target-and-authority",
    (await panel.innerText()).includes(CONTROL_ORIGINS.A) &&
      (await panel.innerText()).includes(data.hostAccessDescriptors.A.authority.authorityId),
  );
  await consent.focus();
  await page.keyboard.press("Space");
  check("legacy-consent-keyboard", (await consent.isChecked()) && (await save.isEnabled()));
  const legacyGeometry = await controlGeometry(
    page,
    size,
    'section[aria-label="Save current backend identity"]',
  );
  for (const issue of inspectGeometry(legacyGeometry)) check(issue, false);
  await capture("legacy-upgrade");
  await save.scrollIntoViewIfNeeded();
  const reachable = await save.boundingBox();
  check(
    "legacy-save-reachable",
    reachable.y >= -1 && reachable.y + reachable.height <= (size.visibleHeight ?? size.height) + 1,
    reachable,
  );
  await save.click();
  await page.waitForFunction((authority) => {
    const value = JSON.parse(localStorage.getItem("bigbud:mobile-web:hosts:v2"));
    return value?.selectedAuthorityId === authority && value.entries.length === 1;
  }, data.hostAccessDescriptors.A.authority.authorityId);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await drawer.waitFor({ state: "hidden" });
  return { directoryGeometry, legacyGeometry, reachable, drawerWidth };
}
