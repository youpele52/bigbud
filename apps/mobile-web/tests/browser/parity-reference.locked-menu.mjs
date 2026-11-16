import assert from "node:assert/strict";

/** Existing locked-model checks, kept separate from other presentation captures. */
export async function inspectLockedModelMenu(page, panel, client, width, theme) {
  let menuRows = [];
  let menuSearch = [];
  let menuControls = [];
  const mobileMenuFindings = [];
  await panel.getByRole("button").first().click();
  await page.getByRole("menu").first().waitFor();
  menuRows = await page
    .locator('[role="menuitemradio"]:visible, [role="menuitem"]:visible')
    .evaluateAll((items) =>
      items
        .filter((item) => item.getAttribute("aria-disabled") !== "true")
        .map((item) => ({
          label: item.textContent?.trim(),
          height: item.getBoundingClientRect().height,
          fontSize: getComputedStyle(item).fontSize,
          minHeight: getComputedStyle(item).minHeight,
          className: item.className,
        })),
    );
  menuSearch = await page.locator('[role="menu"] input:visible').evaluateAll((inputs) =>
    inputs.map((input) => ({
      height: input.getBoundingClientRect().height,
      fontSize: getComputedStyle(input).fontSize,
      minHeight: getComputedStyle(input).minHeight,
      className: input.className,
    })),
  );
  assert.ok(menuSearch.length > 0, "the actual searchable menu input must be visible");
  assert.ok(menuRows.length > 0, "the fixture must expose actual selectable models");
  const search = page.getByPlaceholder("Search models", { exact: true });
  await search.fill("GPT");
  const clear = page.getByRole("button", { name: "Clear search", exact: true });
  await clear.waitFor();
  menuControls = await clear.evaluate((button) => [
    {
      label: button.getAttribute("aria-label"),
      height: button.getBoundingClientRect().height,
      width: button.getBoundingClientRect().width,
    },
  ]);
  await clear.click();
  assert.equal(await search.inputValue(), "", "clearing restores the model list");
  assert.equal(await search.evaluate((input) => input === document.activeElement), true);
  if (client === "mobile") {
    for (const control of menuControls) {
      if (control.height < 44 || control.width < 44)
        mobileMenuFindings.push({ width, theme, control: "clear", ...control });
    }
    for (const input of menuSearch) {
      if (input.height < 44 || input.fontSize !== "14px")
        mobileMenuFindings.push({ width, theme, control: "search", ...input });
    }
    for (const row of menuRows) {
      if (row.height < 44 || row.fontSize !== "14px")
        mobileMenuFindings.push({ width, theme, ...row });
    }
  }
  return { menuRows, menuSearch, menuControls, findings: mobileMenuFindings };
}
