import assert from "node:assert/strict";
import { thread } from "./recovery.fixture.mjs";

const path = `/mobile/thread/${thread.id}`;
const activity = (kind, tone, payload) => ({
  id: `matrix-${kind}`,
  kind,
  tone,
  payload,
  summary: "Fixture activity",
  turnId: null,
  createdAt: thread.createdAt,
});

export const presentationStates = [
  {
    name: "loading",
    path: "/mobile",
    holdBaseline: true,
    ready: (page) => page.getByText("Loading application", { exact: true }).waitFor(),
  },
  {
    name: "empty-thread",
    path,
    thread: { ...thread, messages: [] },
    ready: async (page) => {
      await page.getByRole("status", { name: "No messages yet" }).waitFor();
      await page.getByRole("textbox", { name: "Message", exact: true }).focus();
    },
  },
  {
    name: "question",
    path,
    thread: {
      ...thread,
      activities: [
        activity("user-input.requested", "info", {
          requestId: "matrix-question",
          questions: [
            {
              id: "branch",
              header: "Branch",
              question: "Which branch should be used?",
              options: [
                { label: "main", description: "Keep working on the current branch" },
                { label: "feature", description: "Use the feature branch" },
              ],
            },
          ],
        }),
      ],
    },
    ready: async (page) => {
      const option = page.getByRole("radio", { name: /main/ });
      await option.waitFor();
      const initiallyDisabled = await option.isDisabled();
      await page.waitForFunction(
        (input) => input instanceof HTMLInputElement && !input.disabled,
        await option.elementHandle(),
        { timeout: 30_000 },
      );
      await option.focus();
      await page.keyboard.press("Space");
      assert.equal(await option.isChecked(), true);
      return { initiallyDisabled, enabledAtActivation: await option.isEnabled() };
    },
  },
  {
    name: "work-log",
    path,
    thread: {
      ...thread,
      activities: [
        activity("tool.completed", "tool", {
          itemType: "command_execution",
          command: "printf 'fixture only'",
          detail: "Completed fixture command",
        }),
      ],
    },
    ready: async (page) => {
      const toggle = page.getByRole("button", { name: /Work log/ });
      await toggle.waitFor();
      await toggle.focus();
      assert.equal(await toggle.getAttribute("aria-expanded"), "true");
      await page.keyboard.press("Enter");
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      await page.keyboard.press("Enter");
      assert.equal(await toggle.getAttribute("aria-expanded"), "true");
      const box = await toggle.boundingBox();
      assert.ok(box && box.height >= 44);
    },
  },
  {
    name: "model-picker",
    path,
    ready: async (page) => {
      const trigger = page.getByRole("button", { name: /Gpt 5.4/ });
      await trigger.waitFor();
      await trigger.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("menu").first().waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("menu").first().waitFor({ state: "hidden" });
      assert.ok(await trigger.evaluate((element) => element === document.activeElement));
      await page.keyboard.press("Enter");
      await page.getByRole("menu").first().waitFor();
    },
  },
];
