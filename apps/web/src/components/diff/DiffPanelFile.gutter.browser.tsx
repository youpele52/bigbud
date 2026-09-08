import "../../index.css";

import { parsePatchFiles } from "@pierre/diffs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { DiffPanelFile } from "./DiffPanelFile";
import { DIFF_ANNOTATION_HEADER, type ResolvedDiffSelection } from "./diffSelection.logic";

const FILE_PATH = "src/example.ts";
const PATCH = [
  "diff --git a/src/example.ts b/src/example.ts",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,3 +1,3 @@",
  " const context = true;",
  "-const oldValue = true;",
  "+const newValue = true;",
  " const after = true;",
].join("\n");

async function renderDiff(
  mode: "stacked" | "split",
  onAnnotationRequest: (
    selection: ResolvedDiffSelection,
    position: { readonly clientX: number; readonly clientY: number },
  ) => void,
  activeAnnotationRange?: { readonly startLine: number; readonly endLine: number },
) {
  const fileDiff = parsePatchFiles(PATCH, `gutter-${mode}`)[0]!.files[0]!;
  await render(
    <DiffPanelFile
      fileDiff={fileDiff}
      filePath={FILE_PATH}
      themedFileKey={`gutter-${mode}`}
      diffRenderMode={mode}
      diffWordWrap={false}
      resolvedTheme="dark"
      canAnnotate
      activeAnnotationRange={activeAnnotationRange}
      selectionOwnerFilePath={FILE_PATH}
      onOpenInFilesPanel={() => {}}
      onPierreLineSelectionChange={() => {}}
      onAnnotationRequest={onAnnotationRequest}
    />,
  );
}

async function hoverDiffLine(text: string) {
  let line: HTMLElement | null = null;
  await vi.waitFor(() => {
    line =
      Array.from(
        document
          .querySelector("diffs-container")
          ?.shadowRoot?.querySelectorAll<HTMLElement>("[data-content] [data-line]") ?? [],
      ).find((candidate) => candidate.textContent?.includes(text)) ?? null;
    expect(line).not.toBeNull();
  });
  const target = line!.querySelector<HTMLElement>("span") ?? line!;
  const bounds = target.getBoundingClientRect();
  target.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      composed: true,
      pointerId: 1,
      pointerType: "mouse",
      clientX: bounds.left + Math.max(1, bounds.width / 2),
      clientY: bounds.top + bounds.height / 2,
    }),
  );
  await vi.waitFor(() =>
    expect(
      document
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelector("[data-gutter-utility-slot]"),
    ).not.toBeNull(),
  );
}

describe("DiffPanelFile annotation gutter", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("opens an exact unified addition from the hovered gutter utility", async () => {
    const onAnnotationRequest = vi.fn();
    await renderDiff("stacked", onAnnotationRequest);
    await hoverDiffLine("const newValue");

    const trigger = document.querySelector<HTMLButtonElement>(
      '[aria-label="Annotate hovered diff line"]',
    )!;
    expect(trigger.querySelector("svg")?.classList.contains("size-8")).toBe(true);
    trigger.click();

    expect(onAnnotationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        range: { startLine: 2, endLine: 2 },
        selectedText: [...DIFF_ANNOTATION_HEADER, "+const newValue = true;"].join("\n"),
      }),
      expect.objectContaining({ clientX: expect.any(Number), clientY: expect.any(Number) }),
    );
  });

  it("keeps the active 32px pointer blue on the highest annotation line", async () => {
    await renderDiff("stacked", vi.fn(), { startLine: 1, endLine: 2 });
    let additionLine: HTMLElement | null = null;
    await vi.waitFor(() => {
      additionLine =
        Array.from(
          document
            .querySelector("diffs-container")
            ?.shadowRoot?.querySelectorAll<HTMLElement>("[data-content] [data-line]") ?? [],
        ).find((line) => line.textContent?.includes("const newValue")) ?? null;
      expect(additionLine).not.toBeNull();
    });
    const shadowRoot = document.querySelector("diffs-container")!.shadowRoot!;
    const number = shadowRoot.querySelector<HTMLElement>(
      `[data-column-number="2"][data-line-index="${additionLine!.dataset.lineIndex}"]`,
    )!;
    number.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        composed: true,
        button: 0,
        pointerId: 4,
        pointerType: "mouse",
      }),
    );
    document.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        pointerId: 4,
        pointerType: "mouse",
      }),
    );

    const trigger = document.querySelector<HTMLButtonElement>(
      '[aria-label="Annotate hovered diff line"]',
    )!;
    await vi.waitFor(() => expect(trigger.classList.contains("text-info")).toBe(true));
    expect(trigger.classList.contains("fill-info")).toBe(true);
    expect(trigger.querySelector("svg")?.classList.contains("size-8")).toBe(true);
  });

  it("keeps deletion side identity in split mode", async () => {
    const onAnnotationRequest = vi.fn();
    await renderDiff("split", onAnnotationRequest);
    await hoverDiffLine("const oldValue");

    document.querySelector<HTMLButtonElement>('[aria-label="Annotate hovered diff line"]')!.click();

    expect(onAnnotationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        range: { startLine: 2, endLine: 2 },
        selectedText: [...DIFF_ANNOTATION_HEADER, "-const oldValue = true;"].join("\n"),
      }),
      expect.any(Object),
    );
  });

  it("opens annotation immediately when a line number selection completes", async () => {
    const onAnnotationRequest = vi.fn();
    await renderDiff("stacked", onAnnotationRequest);
    let additionLine: HTMLElement | null = null;
    await vi.waitFor(() => {
      additionLine =
        Array.from(
          document
            .querySelector("diffs-container")
            ?.shadowRoot?.querySelectorAll<HTMLElement>("[data-content] [data-line]") ?? [],
        ).find((line) => line.textContent?.includes("const newValue")) ?? null;
      expect(additionLine).not.toBeNull();
    });
    const shadowRoot = document.querySelector("diffs-container")!.shadowRoot!;
    const lineIndex = additionLine!.dataset.lineIndex;
    const number = shadowRoot.querySelector<HTMLElement>(
      `[data-column-number="2"][data-line-index="${lineIndex}"]`,
    )!;

    number.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        composed: true,
        button: 0,
        pointerId: 2,
        pointerType: "mouse",
        clientX: 20,
        clientY: 80,
      }),
    );
    document.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        pointerId: 2,
        pointerType: "mouse",
        clientX: 20,
        clientY: 80,
      }),
    );

    await vi.waitFor(() => expect(onAnnotationRequest).toHaveBeenCalledOnce());
    expect(onAnnotationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedText: [...DIFF_ANNOTATION_HEADER, "+const newValue = true;"].join("\n"),
      }),
      expect.any(Object),
    );
  });

  it("keeps the completed multi-line range authoritative over the post-drag gutter click", async () => {
    const onAnnotationRequest = vi.fn();
    await renderDiff("stacked", onAnnotationRequest);
    const shadowRoot = document.querySelector("diffs-container")!.shadowRoot!;
    let contextLine: HTMLElement | null = null;
    let additionLine: HTMLElement | null = null;
    await vi.waitFor(() => {
      const lines = Array.from(
        shadowRoot.querySelectorAll<HTMLElement>("[data-content] [data-line]"),
      );
      contextLine = lines.find((line) => line.textContent?.includes("const context")) ?? null;
      additionLine = lines.find((line) => line.textContent?.includes("const newValue")) ?? null;
      expect(contextLine).not.toBeNull();
      expect(additionLine).not.toBeNull();
    });
    const startNumber = shadowRoot.querySelector<HTMLElement>(
      `[data-column-number="1"][data-line-index="${contextLine!.dataset.lineIndex}"]`,
    )!;
    const endNumber = shadowRoot.querySelector<HTMLElement>(
      `[data-column-number="2"][data-line-index="${additionLine!.dataset.lineIndex}"]`,
    )!;
    const endBounds = endNumber.getBoundingClientRect();

    startNumber.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        composed: true,
        button: 0,
        pointerId: 3,
        pointerType: "mouse",
      }),
    );
    document.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        button: 0,
        pointerId: 3,
        pointerType: "mouse",
        clientX: endBounds.left + endBounds.width / 2,
        clientY: endBounds.top + endBounds.height / 2,
      }),
    );
    document.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        pointerId: 3,
        pointerType: "mouse",
        clientX: endBounds.left + endBounds.width / 2,
        clientY: endBounds.top + endBounds.height / 2,
      }),
    );

    await vi.waitFor(() => expect(onAnnotationRequest).toHaveBeenCalledOnce());
    expect(onAnnotationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        range: { startLine: 1, endLine: 2 },
        selectedText: [
          ...DIFF_ANNOTATION_HEADER,
          " const context = true;",
          "-const oldValue = true;",
          "+const newValue = true;",
        ].join("\n"),
      }),
      expect.any(Object),
    );

    document.querySelector<HTMLButtonElement>('[aria-label="Annotate hovered diff line"]')!.click();
    expect(onAnnotationRequest).toHaveBeenCalledOnce();
  });
});
