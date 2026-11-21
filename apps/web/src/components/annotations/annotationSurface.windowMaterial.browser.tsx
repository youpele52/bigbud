import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { MessagesTimelineAnnotations } from "../chat/messages/MessagesTimeline.annotations";
import { StructuredAnnotationPreviews } from "../chat/composer/StructuredAnnotationPreviews";
import { AnnotationComposerPanel } from "./AnnotationComposerPanel";

const html = document.documentElement;
const MATERIALS = ["solid", "translucent"] as const;
const THEMES = ["light", "dark"] as const;

function setMaterial(material: (typeof MATERIALS)[number], theme: (typeof THEMES)[number]) {
  html.dataset.desktopShell = "macos";
  html.dataset.windowMaterial = material;
  html.classList.toggle("dark", theme === "dark");
}

/** Alpha of a computed background such as `rgba(…, 0.4)` or `color(srgb … / 0.4)`. */
function backgroundAlpha(element: Element): number {
  const color = getComputedStyle(element).backgroundColor;
  const alpha =
    /\/\s*([\d.]+)\)$/.exec(color)?.[1] ?? /rgba\([^)]*,\s*([\d.]+)\)$/.exec(color)?.[1];
  return alpha === undefined ? 1 : Number(alpha);
}

const CODE_ANNOTATION = {
  kind: "code",
  text: "annotation-1",
  comment: "Explain this reshape",
  projectName: "analysis",
  workspace: "/workspace",
  path: "notebook.ipynb",
  lineLabel: "Line 3",
  selectedCode: "arr.reshape(2, 3)",
} as const;

describe("annotation surfaces stay opaque in every window material", () => {
  afterEach(() => {
    delete html.dataset.desktopShell;
    delete html.dataset.windowMaterial;
    html.classList.remove("dark");
    document.body.innerHTML = "";
  });

  for (const material of MATERIALS) {
    for (const theme of THEMES) {
      it(`paints the comment composer opaque (${material}, ${theme})`, async () => {
        setMaterial(material, theme);
        const mounted = await render(
          <AnnotationComposerPanel
            targetLabel="Line 3"
            selectionPreview="arr.reshape(2, 3)"
            onCancel={vi.fn()}
            onSubmit={vi.fn()}
          />,
        );
        try {
          const composer = document.querySelector("[data-annotation-composer]")!;
          expect(backgroundAlpha(composer)).toBe(1);
          expect(backgroundAlpha(composer.querySelector("textarea")!)).toBe(1);
        } finally {
          await mounted.unmount();
        }
      });

      it(`paints saved annotation cards opaque (${material}, ${theme})`, async () => {
        setMaterial(material, theme);
        const mounted = await render(
          <MessagesTimelineAnnotations annotations={[CODE_ANNOTATION]} />,
        );
        try {
          await page.getByText("1 annotation").click();
          const summary = document.querySelector("summary")!;
          const card = page.getByText(CODE_ANNOTATION.comment).element().closest(".rounded-lg")!;
          await expect.element(page.getByText(CODE_ANNOTATION.comment)).toBeVisible();
          expect(backgroundAlpha(summary)).toBe(1);
          expect(backgroundAlpha(card)).toBe(1);
        } finally {
          await mounted.unmount();
        }
      });

      it(`paints composer annotation chips and their popover opaque (${material}, ${theme})`, async () => {
        setMaterial(material, theme);
        const mounted = await render(
          <StructuredAnnotationPreviews
            triggerIcon={null}
            label="1 annotation"
            clearLabel="Remove annotation"
            items={[
              {
                id: "annotation-1",
                title: CODE_ANNOTATION.comment,
                badge: null,
                subtitle: CODE_ANNOTATION.path,
                detail: CODE_ANNOTATION.lineLabel,
                removeLabel: "Remove annotation 1",
              },
            ]}
            onRemoveItem={vi.fn()}
            onClear={vi.fn()}
          />,
        );
        try {
          const trigger = page.getByRole("button", { name: "Show 1 annotation" });
          expect(backgroundAlpha(trigger.element().parentElement!)).toBe(1);
          await trigger.click();
          await expect.element(page.getByText(CODE_ANNOTATION.comment)).toBeVisible();
          const item = page.getByText(CODE_ANNOTATION.comment).element().closest(".grid")!;
          const popup = document.querySelector('[data-slot="popover-popup"]')!;
          expect(backgroundAlpha(item)).toBe(1);
          expect(backgroundAlpha(popup)).toBe(1);
        } finally {
          await mounted.unmount();
        }
      });
    }
  }
});
