import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ResourceListLimitWarning } from "./ResourceListLimitWarning";

describe("ResourceListLimitWarning", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows a warning alert that stays dismissed when remounted", async () => {
    const firstMount = await render(<ResourceListLimitWarning />);
    await expect.element(page.getByRole("alert")).toBeInTheDocument();
    await expect
      .element(page.getByText("Some resource lists were capped by the monitor"))
      .toBeInTheDocument();
    await expect.element(page.getByText("Values shown below are partial.")).toBeInTheDocument();

    await page.getByRole("button", { name: "Dismiss resource list warning" }).click();
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    await firstMount.unmount();

    await render(<ResourceListLimitWarning />);
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  });
});
