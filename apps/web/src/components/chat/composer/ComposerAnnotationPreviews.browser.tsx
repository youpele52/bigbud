import "../../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ComposerAnnotationPreviews } from "./ComposerAnnotationPreviews";
import type {
  ComposerAnnotationAttachment,
  ComposerImageAttachment,
} from "../../../stores/composer";

const annotation: ComposerAnnotationAttachment = {
  id: "annotation-1",
  imageId: "image-1",
  comment: "Fix this button",
  page: {
    url: "https://example.com/dashboard",
    title: "Dashboard",
  },
  element: {
    selector: "#save",
    tag: "button",
    role: "button",
    text: "Save",
    ariaLabel: "Save changes",
    id: "save",
    className: "primary",
    rect: { x: 10, y: 20, width: 100, height: 32 },
  },
  viewport: {
    width: 1280,
    height: 720,
    devicePixelRatio: 2,
  },
  createdAt: "2026-05-02T00:00:00.000Z",
};

const image: ComposerImageAttachment = {
  type: "image",
  id: "image-1",
  name: "annotation.png",
  mimeType: "image/png",
  sizeBytes: 1234,
  previewUrl: "data:image/png;base64,abc",
  file: new File(["img"], "annotation.png", { type: "image/png" }),
};

describe("ComposerAnnotationPreviews", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("uses neutral attachment styling with a blue annotation icon", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <ComposerAnnotationPreviews
        annotations={[annotation]}
        images={[image]}
        onRemoveAnnotation={vi.fn()}
        onClearAnnotations={vi.fn()}
      />,
      { container: host },
    );

    try {
      const trigger = document.querySelector('[data-slot="popover-trigger"]');
      expect(trigger).toBeTruthy();
      if (!(trigger instanceof HTMLElement)) {
        throw new Error("Unable to find annotation popover trigger.");
      }
      const chip = trigger.parentElement;
      expect(chip).toBeTruthy();
      if (!(chip instanceof HTMLElement)) {
        throw new Error("Unable to find annotation chip wrapper.");
      }
      expect(chip.className).toContain("border-border/80");
      expect(chip.className).toContain("bg-background");
      expect(chip.className).not.toContain("bg-info/10");

      const icon = trigger.querySelector("svg");
      expect(icon).toBeTruthy();
      expect(icon?.getAttribute("class")).toContain("text-info");
    } finally {
      await screen.unmount();
    }
  });

  it("clears annotations from the inline remove button", async () => {
    const onClearAnnotations = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <ComposerAnnotationPreviews
        annotations={[annotation]}
        images={[image]}
        onRemoveAnnotation={vi.fn()}
        onClearAnnotations={onClearAnnotations}
      />,
      { container: host },
    );

    try {
      const removeButton = document.querySelector('button[aria-label="Remove annotation"]');
      expect(removeButton).toBeTruthy();
      if (!(removeButton instanceof HTMLButtonElement)) {
        throw new Error("Unable to find remove annotation button.");
      }
      removeButton.click();
      expect(onClearAnnotations).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });
});
