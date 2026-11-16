import assert from "node:assert/strict";

export async function assertMobileOutlineLifecycle(page, firstAnchorId) {
  const trigger = page.getByRole("button", { name: "Open transcript outline", exact: true });
  await trigger.waitFor();
  await trigger.click();
  const menu = page.getByRole("menu");
  await menu.waitFor();
  const geometry = await menu.evaluate((element) => {
    const menu = element.getBoundingClientRect();
    const item = element.querySelector('[role="menuitem"]').getBoundingClientRect();
    return {
      menuHeight: menu.height,
      menuTop: menu.top,
      menuBottom: menu.bottom,
      firstTop: item.top,
      firstBottom: item.bottom,
    };
  });
  const failures = [];
  if (geometry.firstTop < geometry.menuTop || geometry.firstBottom > geometry.menuBottom)
    failures.push({ clippedFirstItem: geometry });
  await page.keyboard.press("Escape");
  try {
    await menu.waitFor({ state: "hidden", timeout: 1_500 });
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "Open transcript outline",
      undefined,
      { timeout: 1_500 },
    );
  } catch {
    failures.push({ escapeDidNotCloseOrRestoreFocus: true });
  }
  if (failures.length === 0) {
    const waitForItemFocus = (edge) =>
      page.waitForFunction(
        (edge) => {
          const items = document.querySelectorAll('[role="menuitem"]');
          return document.activeElement === items[edge === "last" ? items.length - 1 : 0];
        },
        edge,
        { timeout: 1_500 },
      );
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    await menu.waitFor();
    const items = page.getByRole("menuitem");
    assert.ok((await items.count()) >= 2);
    await waitForItemFocus("first");
    await page.keyboard.press("End");
    await waitForItemFocus("last");
    await page.keyboard.press("Home");
    await waitForItemFocus("first");
    await page.keyboard.press("Enter");
    await menu.waitFor({ state: "hidden" });
    await page.waitForFunction((firstAnchorId) => {
      const first = document.querySelector(`[data-message-id="${CSS.escape(firstAnchorId)}"]`);
      const viewport = document.querySelector('[data-mobile-transcript="true"]');
      return (
        first &&
        viewport &&
        Math.abs(first.getBoundingClientRect().top - viewport.getBoundingClientRect().top) < 50
      );
    }, firstAnchorId);
    await trigger.click();
    await menu.waitFor();
    await page.touchscreen.tap(20, 80);
    await menu.waitFor({ state: "hidden" });
  }
  assert.deepEqual(failures, [], "outline geometry and keyboard dismissal failures");
}
