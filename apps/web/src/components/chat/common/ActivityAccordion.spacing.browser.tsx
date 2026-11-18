import "../../../index.css";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ActivityAccordion } from "./ActivityAccordion";

it.each([280, 640])(
  "keeps persistent actions accessible without overlap or hover jumps at %ipx",
  async (width) => {
    const onCopy = vi.fn();
    const screen = await render(
      <div style={{ width }}>
        <button type="button">Outside</button>
        <ActivityAccordion
          title="Thinking through a particularly long process label at narrow widths"
          meta="12:34 PM"
          persistentActions={
            <button type="button" onClick={onCopy}>
              Copy result
            </button>
          }
          actions={<button type="button">Show more</button>}
        >
          <ActivityAccordion variant="compact" title="Details">
            Payload
          </ActivityAccordion>
        </ActivityAccordion>
      </div>,
    );
    const title = screen.getByText(
      "Thinking through a particularly long process label at narrow widths",
    );
    const details = title.element().closest("details")!;
    const summary = details.querySelector("summary")!;
    const copy = screen.getByRole("button", { name: "Copy result" });
    await expect.element(copy).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Show more", includeHidden: true }))
      .not.toBeVisible();
    const height = details.getBoundingClientRect().height;
    await title.hover();
    expect(details.getBoundingClientRect().height).toBe(height);
    await screen.getByRole("button", { name: "Outside" }).hover();
    (copy.element() as HTMLButtonElement).focus();
    expect(document.activeElement).toBe(copy.element());
    expect(details.getBoundingClientRect().height).toBe(height);
    await copy.click();
    expect(onCopy).toHaveBeenCalledOnce();
    expect(details.open).toBe(false);
    const actionBox = copy.element().getBoundingClientRect();
    for (const element of summary.children) {
      expect(element.getBoundingClientRect().right).toBeLessThanOrEqual(actionBox.left);
    }
    expect(actionBox.right).toBeLessThanOrEqual(details.getBoundingClientRect().right);
    await title.click();
    await expect.element(screen.getByRole("button", { name: "Show more" })).toBeVisible();
    const nested = screen.getByText("Details", { exact: true }).element().closest("details")!;
    expect(getComputedStyle(nested).marginTop).toBe("8px");
    await screen.getByText("Details", { exact: true }).click();
    const panel = nested.querySelector<HTMLElement>('[data-slot="activity-accordion-panel"]')!;
    expect(getComputedStyle(panel).paddingTop).toBe("6px");
  },
);
