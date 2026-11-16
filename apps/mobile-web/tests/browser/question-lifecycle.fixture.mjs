import assert from "node:assert/strict";

export function questionLifecycleThread(emptyThread, longPrompt = true) {
  const id = longPrompt ? "thread-geometry-question" : "thread-geometry-question-standard";
  return {
    ...emptyThread,
    id,
    activities: [
      {
        id: "geometry-question",
        threadId: id,
        kind: "user-input.requested",
        tone: "info",
        summary: "Input required",
        turnId: null,
        payload: {
          requestId: "geometry-question-request",
          questions: [
            {
              id: "geometry-choice",
              header: "Branch",
              question: "Which branch should be used? ".repeat(longPrompt ? 10 : 1),
              multiSelect: false,
              options: [
                { label: "main", description: "Keep the current branch" },
                { label: "feature", description: "Use the feature branch" },
              ],
            },
            {
              id: "geometry-note",
              header: "Release note",
              question: "What should the release note say?",
              multiSelect: false,
              options: [],
            },
          ],
        },
        createdAt: "2026-09-09T00:00:00.000Z",
        sequence: 1,
      },
    ],
  };
}

async function assertTouchTarget(locator, name) {
  await locator.evaluate((element) => {
    const target = element instanceof HTMLInputElement ? (element.labels?.[0] ?? element) : element;
    target.scrollIntoView({ block: "nearest" });
  });
  const box = await locator.evaluate((element) => {
    const target = element instanceof HTMLInputElement ? (element.labels?.[0] ?? element) : element;
    const { x, y, width, height } = target.getBoundingClientRect();
    return { x, y, width, height };
  });
  assert.ok(box && box.height >= 44 && box.width >= 44, `${name} needs a 44px target`);
  assert.ok(box.y >= 0 && box.y + box.height <= 320, `${name} must remain reachable`);
}

async function assertQuestionFocus(page, id) {
  await page.waitForFunction((id) => document.activeElement?.id === id, id, { timeout: 2000 });
  const detailId = await page.locator(`[id="${id}"]`).getAttribute("aria-describedby");
  assert.ok(detailId, "focused question title must reference its full prompt");
  assert.ok((await page.locator(`[id="${detailId}"]`).innerText()).length > 0);
}

async function isChoiceChecked(locator) {
  return locator.evaluate((element) =>
    element instanceof HTMLInputElement
      ? element.checked
      : element.getAttribute("aria-checked") === "true",
  );
}

export async function assertMobileQuestionLifecycle(page) {
  await page.getByText("Needs you", { exact: true }).waitFor();
  await assertQuestionFocus(page, "mobile-question-geometry-choice");
  const main = page.getByRole("radio", { name: /main/ });
  const feature = page.getByRole("radio", { name: /feature/ });
  for (const [name, option] of [
    ["main", main],
    ["feature", feature],
  ]) {
    await assertTouchTarget(option, name);
  }
  await main.focus();
  await page.keyboard.press("Space");
  assert.equal(await isChoiceChecked(main), true);
  assert.equal(await isChoiceChecked(feature), false);
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await feature.evaluate((element) => element === document.activeElement),
    true,
    "ArrowDown should move native radio focus to the next choice",
  );
  assert.equal(await isChoiceChecked(feature), true);
  assert.equal(await isChoiceChecked(main), false);
  await page.keyboard.press("ArrowUp");
  assert.equal(
    await main.evaluate((element) => element === document.activeElement),
    true,
    "ArrowUp should restore native radio focus to the previous choice",
  );
  assert.equal(await isChoiceChecked(main), true);
  assert.equal(await isChoiceChecked(feature), false);
  await page.keyboard.press("Space");
  assert.equal(await isChoiceChecked(main), true, "native checked-radio Space retains selection");
  // Native radio Space keeps an existing selection; preserve the desktop pointer deselection.
  await main.locator("..").click();
  assert.equal(await isChoiceChecked(main), false, "selected-radio pointer activation deselects");
  await main.locator("..").click();
  assert.equal(await isChoiceChecked(main), true);
  const next = page.getByRole("button", { name: "Next", exact: true });
  await next.waitFor();
  await assertTouchTarget(next, "Next");
  await next.click();
  await assertQuestionFocus(page, "mobile-question-geometry-note");
  await page.getByText("Type your answer in the message box and send.", { exact: true }).waitFor();
  const answer = page.getByRole("textbox", { name: "Your answer", exact: true });
  await answer.fill("The draft stays local until I submit it.");
  const send = page.getByRole("button", { name: "Send message", exact: true });
  await send.waitFor();
  assert.equal(await send.isEnabled(), true);
  await assertTouchTarget(send, "Send answer");
  await page.getByRole("button", { name: "Previous question", exact: true }).click();
  await assertQuestionFocus(page, "mobile-question-geometry-choice");
  assert.equal(await isChoiceChecked(main), true, "selection must survive navigation");
  await next.click();
  await assertQuestionFocus(page, "mobile-question-geometry-note");
  assert.equal(await answer.inputValue(), "The draft stays local until I submit it.");
  // Do not submit: this verifies local answer/progress preservation, not remote delivery.
}
