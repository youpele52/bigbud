import "../../index.css";

import { beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { hash, mocks, preview } from "./FilePreview.edit.fixtures";
import { SAVE_DELAY_MS } from "./fileEditDrafts.state";

beforeEach(() => {
  mocks.read
    .mockReset()
    .mockResolvedValue({ contents: "small", sizeBytes: 5, sha256: hash, truncated: false });
  mocks.write.mockReset().mockResolvedValue(undefined);
});

async function guardedPreview(contents: string) {
  const bytes = new TextEncoder().encode(contents);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return {
    contents,
    sizeBytes: bytes.length,
    sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    truncated: false,
    edit: { mode: "guarded", maxBytes: 512 * 1024 },
  };
}

it.each([true, false])(
  "retains a guarded Direct SSH draft without replay when the app gets no acknowledgment (applied: %s)",
  async (applied) => {
    const target = "ssh:host=dev&transport=direct-ssh";
    const path = `guarded-unknown-${applied}.txt`;
    const base = await guardedPreview("small");
    const attempted = await guardedPreview("small!");
    let disk = base;
    mocks.read.mockResolvedValue(base);
    mocks.write.mockImplementationOnce(async () => {
      if (applied) disk = attempted;
      // Model a missing result at the app's projects.writeFile API, not on the wire.
      mocks.read.mockRejectedValue(new Error("Fixture read-back unavailable"));
      throw Object.assign(new Error("Fixture withheld save result"), {
        writeDisposition: "unknown",
      });
    });
    const mounted = await render(preview(path, target));
    try {
      await page.getByRole("button", { name: "Edit file" }).click();
      await page.getByRole("textbox", { name: path }).click();
      await userEvent.keyboard("{End}!");
      await expect.element(page.getByText(/Save outcome unknown; draft retained/)).toBeVisible();
      const retry = page.getByRole("button", { name: "Retry save" });
      await expect.element(retry).toBeDisabled();
      const firstWrite = mocks.write.mock.calls[0]?.[0];
      expect(firstWrite).toMatchObject({
        executionTargetId: target,
        relativePath: path,
        expectedSha256: base.sha256,
        contents: attempted.contents,
        operationId: expect.stringMatching(/^file-edit-/),
      });
      await page.getByRole("button", { name: "Preview file" }).click();
      await vi.waitFor(() =>
        expect(document.querySelector(".file-preview-code")?.textContent).toContain("small!"),
      );
      await new Promise((resolve) => setTimeout(resolve, SAVE_DELAY_MS + 100));
      expect(mocks.write).toHaveBeenCalledOnce();
      await expect.element(retry).toBeDisabled();

      mocks.read.mockResolvedValue(disk);
      await page.getByRole("button", { name: "Check disk" }).click();
      if (applied) {
        await expect.element(page.getByRole("status")).toHaveTextContent("Saved to host");
        expect(mocks.write).toHaveBeenCalledOnce();
      } else {
        await expect.element(retry).toBeEnabled();
        expect(mocks.write).toHaveBeenCalledOnce();
        mocks.write.mockResolvedValueOnce({ relativePath: path, resultSha256: attempted.sha256 });
        await retry.click();
        await expect.element(page.getByRole("status")).toHaveTextContent("Saved to host");
        expect(mocks.write).toHaveBeenCalledTimes(2);
        const retryWrite = mocks.write.mock.calls[1]?.[0];
        expect(retryWrite).toMatchObject({
          ...firstWrite,
          operationId: expect.stringMatching(/^file-edit-/),
        });
        expect(retryWrite.operationId).not.toBe(firstWrite.operationId);
      }
    } finally {
      await mounted.unmount();
    }
  },
);

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
    await vi.waitFor(() => expect(document.body.textContent).toContain("Compare"));
    expect(document.querySelector(".file-preview-code")?.textContent).toContain("small!");
    await page.getByRole("button", { name: "Compare" }).click();
    await page.getByRole("button", { name: "Use disk version" }).click();
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
    await mounted.unmount();
  }
});
