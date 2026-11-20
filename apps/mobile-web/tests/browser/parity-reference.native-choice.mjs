import assert from "node:assert/strict";

async function assertUpdates(page, expected) {
  await page.waitForFunction(
    (value) =>
      document.querySelector("[data-choice-updates]")?.dataset.choiceUpdates === String(value),
    expected,
    { timeout: 2000 },
  );
  assert.equal(
    await page.locator("[data-choice-updates]").getAttribute("data-choice-updates"),
    String(expected),
  );
}

async function openVariant(page, origin, client, theme, variant) {
  await page.goto(
    `${origin}/__mobile-parity-reference?client=${client}&surface=question&theme=${theme}&choiceVariant=${variant}`,
  );
  await page.locator(`[data-choice-variant="${variant}"]`).waitFor();
  await assertUpdates(page, 0);
}

/** Counters observe actual consumer callbacks, including accidental double activation. */
export async function assertNativeQuestionChoices(page, origin, { client, theme }) {
  const main = page.getByRole("radio", { name: /main/ });
  const feature = page.getByRole("radio", { name: /feature/ });
  assert.equal(await main.evaluate((input) => input.tagName), "INPUT");
  await assertUpdates(page, 0);
  await main.focus();
  await page.keyboard.press("Space");
  await assertUpdates(page, 1);
  assert.equal(await main.isChecked(), true);
  await page.keyboard.press("ArrowDown");
  await assertUpdates(page, 2);
  assert.equal(await feature.isChecked(), true);
  assert.equal(await main.isChecked(), false);
  assert.equal(await feature.evaluate((input) => input === document.activeElement), true);
  await page.keyboard.press("ArrowUp");
  await assertUpdates(page, 3);
  assert.equal(await main.isChecked(), true);
  assert.equal(await main.evaluate((input) => input === document.activeElement), true);
  await page.keyboard.press("Space");
  await assertUpdates(page, 3);
  assert.equal(await main.isChecked(), true, "native selected-radio Space retains selection");
  await main.locator("..").click();
  await assertUpdates(page, 4);
  assert.equal(await main.isChecked(), false, "pointer activation preserves desktop deselection");
  await main.locator("..").click();
  await assertUpdates(page, 5);
  assert.equal(await main.isChecked(), true);

  await openVariant(page, origin, client, theme, "multiple");
  const mainCheckbox = page.getByRole("checkbox", { name: /main/ });
  const featureCheckbox = page.getByRole("checkbox", { name: /feature/ });
  await mainCheckbox.focus();
  await page.keyboard.press("Space");
  await assertUpdates(page, 1);
  await featureCheckbox.focus();
  await page.keyboard.press("Space");
  await assertUpdates(page, 2);
  assert.equal(await mainCheckbox.isChecked(), true);
  assert.equal(await featureCheckbox.isChecked(), true);
  await mainCheckbox.locator("..").click();
  await assertUpdates(page, 3);
  assert.equal(await mainCheckbox.isChecked(), false);
  assert.equal(await featureCheckbox.isChecked(), true);

  await openVariant(page, origin, client, theme, "disabled");
  const disabled = page.getByRole("radio", { name: /main/ });
  assert.equal(await disabled.isDisabled(), true);
  await disabled.locator("..").click({ force: true });
  await page.keyboard.press("Space");
  await assertUpdates(page, 0);
  assert.equal(await disabled.isChecked(), false);
  return { radioUpdates: 5, checkboxUpdates: 3, disabledUpdates: 0 };
}
