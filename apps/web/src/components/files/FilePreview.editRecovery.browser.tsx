import "../../index.css";

import { beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { hash, mocks, preview } from "./FilePreview.edit.fixtures";

beforeEach(() => {
  mocks.read
    .mockReset()
    .mockResolvedValue({ contents: "small", sizeBytes: 5, sha256: hash, truncated: false });
  mocks.write.mockReset().mockResolvedValue(undefined);
});

it("keeps an open draft visible after disk grows and returns to a read-only large preview on discard", async () => {
  mocks.write.mockRejectedValueOnce(
    Object.assign(new Error("Conflict"), { conflict: true, writeDisposition: "terminal" }),
  );
  const mounted = await render(preview("large-disk.txt"));
  try {
    await vi.waitFor(() => expect(page.getByRole("button", { name: "Edit file" })).toBeVisible());
    document.querySelector<HTMLButtonElement>('[aria-label="Edit file"]')!.click();
    await page.getByRole("textbox", { name: "large-disk.txt" }).click();
    await userEvent.keyboard("{End}!");
    const contents = `external large file ${"x".repeat(512 * 1024)}`;
    mocks.read.mockResolvedValue({
      contents,
      sizeBytes: contents.length,
      sha256: "b".repeat(64),
      truncated: false,
    });
    await vi.waitFor(() => expect(document.body.textContent).toContain("File changed on disk"), {
      timeout: 5000,
    });
    expect(page.getByRole("textbox", { name: "large-disk.txt" })).toBeVisible();
    expect(document.querySelector("diffs-container")?.shadowRoot?.textContent).toContain("small!");
    document.querySelector<HTMLButtonElement>('[aria-label="Preview file"]')!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Discard draft"));
    expect(document.querySelector(".file-preview-code")?.textContent).toContain("small!");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      (page.getByRole("button", { name: "Discard draft" }).element() as HTMLButtonElement).click();
      await vi.waitFor(() =>
        expect(document.querySelector(".file-preview-code")?.textContent).toContain(
          "external large file",
        ),
      );
      expect(document.querySelector('[aria-label="Edit file"]')).toBeNull();
      expect(document.querySelector("[data-file-preview-editor]")).toBeNull();
      expect(document.querySelector('[role="alert"]')).toBeNull();
      expect(mocks.write).toHaveBeenCalledOnce();
    } finally {
      confirm.mockRestore();
    }
  } finally {
    await mounted.unmount();
  }
});
