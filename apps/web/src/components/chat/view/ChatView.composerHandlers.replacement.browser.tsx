import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { ReplacementFixture } from "./ChatView.composerHandlers.replacement.fixture";

it("real prompt replacement preserves exact selected IDs with a custom JSON array and satisfies minItems", async () => {
  const screen = await render(<ReplacementFixture />);
  await expect.element(screen.getByText("null", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Replace answer" }).click();
  await expect
    .element(screen.getByText('{"tags":["exact","custom"]}', { exact: true }))
    .toBeVisible();
});
