import { expect } from "vitest";
import { page } from "vitest/browser";

async function waitForToastMotion(card: HTMLElement) {
  await expect.poll(() => card.hasAttribute("data-starting-style")).toBe(false);
  // The starting flag clears before the CSS transition finishes. Inspect only
  // the card itself: a loading spinner below it intentionally never finishes.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await expect
    .poll(() =>
      card
        .getAnimations()
        .some((animation) => animation.pending || animation.playState === "running"),
    )
    .toBe(false);
}

/** Keep the real pointer on the card after entrance/expansion changes its bounds. */
export async function settleToastForPointer(card: HTMLElement) {
  await waitForToastMotion(card);
  await page.elementLocator(card).hover();
  await waitForToastMotion(card);
  await page.elementLocator(card).hover();
  await waitForToastMotion(card);
}
