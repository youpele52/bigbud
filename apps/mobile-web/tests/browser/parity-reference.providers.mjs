import assert from "node:assert/strict";
import { join } from "node:path";

export async function inspectUnlockedProviders(page, panel, client, width, theme, directory) {
  await panel.getByRole("button").first().click();
  const codex = page.getByRole("menuitem", { name: "Codex", exact: true });
  await codex.waitFor();
  const providerRows = await page.locator('[role="menuitem"]:visible').evaluateAll((rows) =>
    rows
      .filter((row) => row.getAttribute("aria-disabled") !== "true")
      .map((row) => ({
        label: row.textContent?.trim(),
        height: row.getBoundingClientRect().height,
        fontSize: getComputedStyle(row).fontSize,
      })),
  );
  const providerScreenshot = join(directory, `providers-${client}-${theme}-${width}.png`);
  await page.screenshot({ path: providerScreenshot });
  await codex.click();
  const search = page.getByPlaceholder("Search models", { exact: true });
  await search.waitFor();
  const rows = page.locator('[role="menuitemradio"]:visible');
  assert.equal(await rows.count(), 2, "fixture needs two independently filterable models");
  const modelRows = await rows.evaluateAll((items) =>
    items.map((row) => ({
      label: row.textContent?.trim(),
      height: row.getBoundingClientRect().height,
      fontSize: getComputedStyle(row).fontSize,
    })),
  );
  const searchBox = await search.evaluate((input) => ({
    height: input.getBoundingClientRect().height,
    fontSize: getComputedStyle(input).fontSize,
  }));
  const menus = await page.getByRole("menu").evaluateAll((items) =>
    items
      .filter((menu) => menu.getBoundingClientRect().width > 0)
      .map((menu) => {
        const { left, right } = menu.getBoundingClientRect();
        return { left, right, viewportWidth: window.innerWidth };
      }),
  );
  for (const menu of menus)
    assert.ok(
      menu.left >= -1 && menu.right <= menu.viewportWidth + 1,
      `actual provider/submenu must fit phone viewport: ${JSON.stringify(menu)}`,
    );
  if (client === "mobile")
    for (const target of [...providerRows, ...modelRows, searchBox]) {
      assert.ok(target.height >= 44, "unlocked picker targets must be44px");
      assert.equal(target.fontSize, "14px");
    }
  const submenuScreenshot = join(directory, `provider-models-${client}-${theme}-${width}.png`);
  await page.screenshot({ path: submenuScreenshot });
  await search.fill("beta");
  assert.equal(await rows.count(), 1);
  assert.ok((await rows.first().innerText()).includes("Fixture Beta"));
  await search.fill("unmatched-fixture-query");
  assert.equal(await rows.count(), 0, "nonmatching query must actually remove both models");
  const clear = page.getByRole("button", { name: "Clear search", exact: true });
  await clear.click();
  assert.equal(await rows.count(), 2);
  assert.equal(await search.evaluate((input) => input === document.activeElement), true);
  await page.getByRole("menuitemradio", { name: "Fixture Beta", exact: true }).click();
  const selection = panel.locator("[data-provider-selection]");
  await page.waitForFunction(
    () => document.querySelector("[data-provider-selection]")?.textContent === "codex:fixture-beta",
  );
  assert.equal(
    await selection.getAttribute("data-updates"),
    "1",
    "one user choice must update exactly once",
  );
  return {
    providerRows,
    modelRows,
    searchBox,
    menus,
    providerScreenshot,
    submenuScreenshot,
    filtering: true,
    selection: await selection.innerText(),
    updates: 1,
  };
}
