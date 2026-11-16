import assert from "node:assert/strict";

export async function inspectWorkEntryDetails(page, panel, client) {
  const details = panel.locator("[data-work-entry-details]").first();
  if ((await details.count()) === 0) return { missing: true, blocks: [], target: null };
  const summary = details.locator("summary");
  await summary.focus();
  await page.keyboard.press("Space");
  await page.waitForFunction((element) => element.open, await details.elementHandle());
  await details.locator("pre").first().waitFor();
  const blocks = await details.locator("pre").allTextContents();
  assert.equal(blocks.length, 2, "full raw command and output must remain locally readable");
  assert.ok(blocks[0].startsWith("sh -lc"));
  assert.ok(blocks[1].includes("Fixture output line two"));
  await page.keyboard.press("Enter");
  await page.waitForFunction((element) => !element.open, await details.elementHandle());
  await page.keyboard.press("Space");
  await page.waitForFunction((element) => element.open, await details.elementHandle());
  const target = await summary.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
    fontSize: getComputedStyle(element).fontSize,
  }));
  if (client === "mobile") {
    assert.ok(
      target.height >= 44 && target.width >= 44,
      "detail disclosure needs a44px touch target",
    );
    assert.equal(target.fontSize, "14px");
  }
  return { missing: false, blocks, target };
}
