import "@vitest/browser-playwright";
import type { BrowserCommand } from "vitest/node";

/**
 * Chromium only retargets drag selections inside shadow roots for trusted input,
 * so a synthetic Range cannot reproduce the real diff-selection shape. Drive the
 * test page with Playwright's mouse instead.
 */
export const dragSelectDiffLines: BrowserCommand<
  [startText: string, endText: string, rightClick: boolean]
> = async ({ page, frame: getFrame }, startText, endText, rightClick) => {
  const frame = await getFrame();
  const lines = frame.locator("[data-content] [data-line]");
  const startLine = lines.filter({ hasText: startText }).first();
  const endLine = lines.filter({ hasText: endText }).first();
  const startBox = await startLine.boundingBox();
  const endBox = await endLine.boundingBox();
  if (!startBox || !endBox) throw new Error("Diff line boxes are unavailable");

  const startX = startBox.x + Math.max(2, Math.min(startBox.width * 0.4, 48));
  const startY = startBox.y + startBox.height / 2;
  const endX = endBox.x + Math.max(2, Math.min(endBox.width * 0.6, 72));
  const endY = endBox.y + endBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 8 });
  await page.mouse.up();
  if (rightClick) await page.mouse.click(endX, endY, { button: "right" });

  return frame.evaluate(() => window.getSelection()?.toString() ?? "");
};
