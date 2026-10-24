import "../../../index.css";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ActivityAccordion } from "./ActivityAccordion";

function headerParts(summary: HTMLElement) {
  return {
    icon: summary.querySelector("svg")!,
    text: [
      summary.querySelector<HTMLElement>("[data-slot=activity-accordion-title]")!,
      summary.querySelector<HTMLElement>("[data-slot=activity-accordion-meta]")!,
    ],
  };
}

/** Compare the icon to cap-height-trimmed text, not an untrimmed line box or a fixed offset. */
function expectOpticallyAlignedHeader(summary: HTMLElement) {
  const { icon: iconElement, text: textElements } = headerParts(summary);
  const icon = iconElement.getBoundingClientRect();
  const fontSize = Number.parseFloat(getComputedStyle(summary).fontSize);
  const iconStyle = getComputedStyle(iconElement);
  expect(Number.parseFloat(iconStyle.fontSize)).toBe(fontSize);
  expect(Number.parseFloat(iconStyle.width)).toBeCloseTo(Number.parseFloat(iconStyle.height), 1);
  for (const element of textElements) {
    const text = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    expect(style.getPropertyValue("text-box-trim")).toBe("trim-both");
    expect(style.getPropertyValue("text-box-edge")).toBe("cap alphabetic");
    expect(Number.parseFloat(style.height)).toBeLessThan(Number.parseFloat(style.fontSize));
    // The icon hangs a whole 2px below the baseline so it snaps to pixels with the glyphs.
    expect(getComputedStyle(summary).alignItems).toBe("baseline");
    expect(iconStyle.top).toBe("2px");
    expect(Number.parseFloat(iconStyle.height) - Number.parseFloat(style.height)).toBeCloseTo(4, 1);
    expect(Math.abs(icon.top + icon.height / 2 - (text.top + text.height / 2))).toBeLessThanOrEqual(
      0.5,
    );
  }
}

it("renders a muted uppercase header whose chevron stays centered on the capitals", async () => {
  const screen = await render(
    <div data-testid="accordion-surface" className="dark bg-background p-6 text-foreground">
      <ActivityAccordion title="Question" meta={<time dateTime="2026-10-24T18:03">6:03 PM</time>}>
        <p>Panel body</p>
      </ActivityAccordion>
    </div>,
  );
  const title = screen.getByText("Question", { exact: true });
  await expect.element(title).toBeVisible();
  await expect.element(screen.getByText("Panel body")).not.toBeVisible();
  const summary = title.element().closest("summary")!;
  const summaryStyle = getComputedStyle(summary);
  expect(summaryStyle.fontSize).toBe("10px");
  expect(summaryStyle.letterSpacing).toBe("1.4px");
  expect(summaryStyle.textTransform).toBe("uppercase");
  for (const element of headerParts(summary).text) {
    const style = getComputedStyle(element);
    expect(style.fontSize).toBe(summaryStyle.fontSize);
    expect(style.fontWeight).toBe(summaryStyle.fontWeight);
    expect(style.letterSpacing).toBe(summaryStyle.letterSpacing);
    expect(style.textTransform).toBe(summaryStyle.textTransform);
    expect(style.color).toBe(summaryStyle.color);
  }
  expectOpticallyAlignedHeader(summary);
  for (const fontFamily of ["Arial", "Georgia", "monospace"]) {
    for (const zoom of ["0.8", "1", "1.25", "1.5"]) {
      summary.style.fontFamily = fontFamily;
      summary.style.zoom = zoom;
      expectOpticallyAlignedHeader(summary);
    }
  }
  summary.style.fontFamily = "";
  summary.style.zoom = "";
  await title.click();
  await expect.element(screen.getByText("Panel body")).toBeVisible();
  expectOpticallyAlignedHeader(summary);
  await title.click();
  await expect.element(screen.getByText("Panel body")).not.toBeVisible();
  const screenshotDirectory = import.meta.env.VITE_ACTIVITY_ACCORDION_SCREENSHOT_DIR;
  if (screenshotDirectory) {
    await expect.poll(() => getComputedStyle(headerParts(summary).icon).rotate).toBe("-90deg");
    await screen
      .getByTestId("accordion-surface")
      .screenshot({ path: `${screenshotDirectory}/activity-accordion-chevron.png` });
  }
});

it("omits the meta slot when no meta is given", async () => {
  const screen = await render(<ActivityAccordion title="Work log">Body</ActivityAccordion>);
  const summary = screen.getByText("Work log", { exact: true }).element().closest("summary")!;
  expect(summary.querySelector("[data-slot=activity-accordion-meta]")).toBeNull();
});

it("rotates only the chevron of the accordion that is open when nested", async () => {
  const screen = await render(
    <ActivityAccordion title="Work log">
      <ActivityAccordion title="Terminal call">Output</ActivityAccordion>
    </ActivityAccordion>,
  );
  const chevronOf = (label: string) =>
    screen.getByText(label, { exact: true }).element().closest("summary")!.querySelector("svg")!;
  await screen.getByText("Work log", { exact: true }).click();
  await expect.element(screen.getByText("Terminal call", { exact: true })).toBeVisible();
  await expect.poll(() => getComputedStyle(chevronOf("Work log")).rotate).toBe("0deg");
  await expect.poll(() => getComputedStyle(chevronOf("Terminal call")).rotate).toBe("-90deg");
  await screen.getByText("Terminal call", { exact: true }).click();
  await expect.element(screen.getByText("Output")).toBeVisible();
  await expect.poll(() => getComputedStyle(chevronOf("Terminal call")).rotate).toBe("0deg");
});

it("passes native details props through for controlled or observed use", async () => {
  const onToggle = vi.fn();
  const screen = await render(
    <ActivityAccordion
      title="Tool call"
      open
      onToggle={(event) => onToggle(event.currentTarget.open)}
      className="extra-root"
      summaryClassName="extra-summary"
      panelClassName="extra-panel"
    >
      Result
    </ActivityAccordion>,
  );
  await expect.element(screen.getByText("Result")).toBeVisible();
  const details = screen.getByText("Result").element().closest("details")!;
  expect(details.classList).toContain("extra-root");
  expect(details.querySelector("summary")!.classList).toContain("extra-summary");
  expect(screen.getByText("Result").element().classList).toContain("extra-panel");
  await expect.poll(() => onToggle.mock.calls.at(-1)?.[0]).toBe(true);
});

it("renders the compact variant as a sentence-case text-xs toggle without a divider", async () => {
  const screen = await render(
    <div className="dark bg-background p-6 text-foreground">
      <ActivityAccordion variant="compact" title="Delegation details" meta="2 files">
        <ActivityAccordion variant="compact" title="Raw payload">
          Payload
        </ActivityAccordion>
      </ActivityAccordion>
    </div>,
  );
  const title = screen.getByText("Delegation details", { exact: true });
  const summary = title.element().closest("summary")!;
  const details = summary.closest("details")!;
  const summaryStyle = getComputedStyle(summary);
  expect(details.dataset.variant).toBe("compact");
  expect(summaryStyle.fontSize).toBe("12px");
  expect(summaryStyle.textTransform).toBe("none");
  expect(summaryStyle.letterSpacing).toBe("normal");
  expect(summaryStyle.paddingTop).toBe("0px");
  expect(summary.classList).toContain("text-muted-foreground/55");
  expect(summary.classList).toContain("hover:text-muted-foreground/75");
  const detailsStyle = getComputedStyle(details);
  expect(detailsStyle.borderBottomWidth).toBe("0px");
  expect(detailsStyle.paddingBottom).toBe("0px");
  expectOpticallyAlignedHeader(summary);
  for (const zoom of ["0.8", "1.25", "1.5"]) {
    summary.style.zoom = zoom;
    expectOpticallyAlignedHeader(summary);
  }
  summary.style.zoom = "";

  const chevronOf = (label: string) =>
    screen.getByText(label, { exact: true }).element().closest("summary")!.querySelector("svg")!;
  await title.click();
  await expect.element(screen.getByText("Raw payload", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Payload", { exact: true })).not.toBeVisible();
  await expect.poll(() => getComputedStyle(chevronOf("Delegation details")).rotate).toBe("0deg");
  await expect.poll(() => getComputedStyle(chevronOf("Raw payload")).rotate).toBe("-90deg");
  await screen.getByText("Raw payload", { exact: true }).click();
  await expect.element(screen.getByText("Payload", { exact: true })).toBeVisible();
});

it("pins header actions to the top right, only while open, without toggling the accordion", async () => {
  const onAction = vi.fn();
  const screen = await render(
    <div style={{ width: 480 }}>
      <ActivityAccordion
        title="Work log (3)"
        actions={
          <button type="button" onClick={onAction}>
            Show 2 more
          </button>
        }
      >
        Entries
      </ActivityAccordion>
    </div>,
  );
  const title = screen.getByText("Work log (3)", { exact: true });
  const details = title.element().closest("details")!;
  // Closed details content is outside the accessibility tree, so query the DOM directly.
  const actionElement = details.querySelector<HTMLButtonElement>(
    "[data-slot=activity-accordion-actions] button",
  )!;
  expect(actionElement.checkVisibility()).toBe(false);
  await title.click();
  const action = screen.getByRole("button", { name: "Show 2 more" });
  await expect.element(action).toBeVisible();
  const summary = details.querySelector("summary")!.getBoundingClientRect();
  const slot = details
    .querySelector<HTMLElement>("[data-slot=activity-accordion-actions]")!
    .getBoundingClientRect();
  const button = action.element().getBoundingClientRect();
  expect(slot.right).toBeCloseTo(details.getBoundingClientRect().right, 1);
  expect(slot.top).toBeCloseTo(summary.top, 1);
  expect(
    Math.abs(button.top + button.height / 2 - (summary.top + summary.height / 2)),
  ).toBeLessThanOrEqual(1);
  await action.click();
  expect(onAction).toHaveBeenCalledTimes(1);
  expect(details.open).toBe(true);
});
