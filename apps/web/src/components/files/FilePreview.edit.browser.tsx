import "../../index.css";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { hash, mocks, preview } from "./FilePreview.edit.fixtures";

describe("Files panel text editing", () => {
  beforeEach(() => {
    mocks.read
      .mockReset()
      .mockResolvedValue({ contents: "first line", truncated: false, sizeBytes: 10, sha256: hash });
    mocks.write.mockReset().mockResolvedValue({ relativePath: "local.txt" });
  });

  it("retains an unsaved local draft across navigation", async () => {
    const mounted = await render(preview("local.txt"));
    try {
      await vi.waitFor(() => expect(page.getByRole("button", { name: "Edit file" })).toBeVisible());
      await page.getByRole("button", { name: "Edit file" }).click();
      await page.getByRole("textbox", { name: "local.txt" }).click();
      await userEvent.keyboard("{End}!");
      await vi.waitFor(() => expect(document.body.textContent).toContain("Unsaved"));
      expect(document.body.textContent).not.toContain("Draft is in memory only until saved");
      mocks.read.mockImplementation((input: { relativePath: string }) =>
        input.relativePath === "local.txt"
          ? Promise.reject(new Error("Disconnected"))
          : Promise.resolve({
              contents: "another file",
              truncated: false,
              sizeBytes: 12,
              sha256: hash,
            }),
      );
      await mounted.rerender(preview("other.txt"));
      await mounted.rerender(preview("local.txt"));
      await vi.waitFor(() => expect(document.body.textContent).toContain("first line!"));
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain("Showing your in-memory copy"),
      );
    } finally {
      await mounted.unmount();
    }
  });

  it("does not offer editing for direct SSH", async () => {
    const mounted = await render(preview("direct.txt", "ssh:host=dev&transport=direct-ssh"));
    try {
      await vi.waitFor(() => expect(document.body.textContent).toContain("Read only"));
      expect(
        [...document.querySelectorAll("button")].some(
          (button) => button.getAttribute("aria-label") === "Edit file",
        ),
      ).toBe(false);
      expect(mocks.write).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });

  it("warns when a refresh fails while retaining the loaded draft", async () => {
    const mounted = await render(preview("refresh-error.txt"));
    try {
      await vi.waitFor(() => expect(page.getByRole("button", { name: "Edit file" })).toBeVisible());
      mocks.write.mockRejectedValue(new Error("Save failed"));
      [...document.querySelectorAll<HTMLButtonElement>("[data-file-preview-header] button")]
        .find((button) => button.getAttribute("aria-label") === "Edit file")!
        .click();
      await page.getByRole("textbox", { name: "refresh-error.txt" }).click();
      await userEvent.keyboard("{End}!");
      await vi.waitFor(() => expect(document.body.textContent).toContain("Check disk"), {
        timeout: 5000,
      });
      mocks.read.mockRejectedValue(new Error("Connection lost"));
      [...document.querySelectorAll<HTMLButtonElement>("[data-file-preview-header] button")]
        .find((button) => button.textContent === "Check disk")!
        .click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Connection lost"));
      [...document.querySelectorAll<HTMLButtonElement>("[data-file-preview-header] button")]
        .find((button) => button.getAttribute("aria-label") === "Preview file")!
        .click();
      await vi.waitFor(() =>
        expect(document.querySelector(".file-preview-code")?.textContent).toContain("first line!"),
      );
      expect(document.body.textContent).toContain("Showing your in-memory copy");
    } finally {
      await mounted.unmount();
    }
  });

  it("restores the raw preview scroll position after editing", async () => {
    const contents = Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n");
    mocks.read.mockResolvedValue({
      contents,
      truncated: false,
      sizeBytes: contents.length,
      sha256: hash,
    });
    const mounted = await render(preview("scroll.txt"));
    try {
      await vi.waitFor(() => expect(document.querySelector(".file-preview-code")).not.toBeNull());
      const viewport = document.querySelector(".file-preview-code")!.parentElement!
        .parentElement! as HTMLDivElement;
      viewport.scrollTop = 220;
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }));
      [...document.querySelectorAll<HTMLButtonElement>("[data-file-preview-header] button")]
        .find((button) => button.getAttribute("aria-label") === "Edit file")!
        .click();
      await vi.waitFor(() =>
        expect(
          document
            .querySelector("diffs-container")
            ?.shadowRoot?.querySelector("[contenteditable]") ?? null,
        ).not.toBeNull(),
      );
      [...document.querySelectorAll<HTMLButtonElement>("[data-file-preview-header] button")]
        .find((button) => button.getAttribute("aria-label") === "Preview file")!
        .click();
      await vi.waitFor(() => expect(document.querySelector(".file-preview-code")).not.toBeNull());
      await vi.waitFor(() =>
        expect(
          (
            document.querySelector(".file-preview-code")!.parentElement!
              .parentElement! as HTMLDivElement
          ).scrollTop,
        ).toBe(220),
      );
    } finally {
      await mounted.unmount();
    }
  });

  it("returns to rendered markdown with the edited draft", async () => {
    const mounted = await render(preview("notes.md"));
    try {
      await vi.waitFor(() =>
        expect(document.querySelector(".file-preview-markdown")).not.toBeNull(),
      );
      [...document.querySelectorAll<HTMLButtonElement>("[data-file-preview-header] button")]
        .find((button) => button.getAttribute("aria-label") === "Edit file")!
        .click();
      await page.getByRole("textbox", { name: "notes.md" }).click();
      await userEvent.keyboard("{End}!");
      await vi.waitFor(() => expect(document.body.textContent).toContain("Unsaved"));
      [...document.querySelectorAll<HTMLButtonElement>("[data-file-preview-header] button")]
        .find((button) => button.getAttribute("aria-label") === "Preview file")!
        .click();
      await vi.waitFor(() =>
        expect(document.querySelector(".file-preview-markdown")?.textContent).toContain(
          "first line!",
        ),
      );
    } finally {
      await mounted.unmount();
    }
  });

  it("autosaves through the explicitly selected remote-agent target with its read hash", async () => {
    const target = "ssh:host=dev&transport=agent";
    const mounted = await render(preview("remote.txt", target));
    try {
      await vi.waitFor(() => expect(page.getByRole("button", { name: "Edit file" })).toBeVisible());
      expect(
        document
          .querySelector('[aria-label="Edit file"] svg')
          ?.classList.contains("text-muted-foreground"),
      ).toBe(true);
      expect(
        document.querySelector('[role="status"]')?.classList.contains("text-muted-foreground"),
      ).toBe(true);
      const mutedColor = getComputedStyle(
        document.querySelector('[aria-label="Edit file"] svg')!,
      ).color;
      expect(mutedColor).toBe(getComputedStyle(document.querySelector('[role="status"]')!).color);
      [...document.querySelectorAll<HTMLButtonElement>("[data-file-preview-header] button")]
        .find((button) => button.getAttribute("aria-label") === "Edit file")!
        .click();
      await page.getByRole("textbox", { name: "remote.txt" }).click();
      await userEvent.keyboard("{End}!");
      await vi.waitFor(
        () =>
          expect(mocks.write.mock.calls.some(([call]) => call.relativePath === "remote.txt")).toBe(
            true,
          ),
        { timeout: 5000 },
      );
      const remoteWrite = mocks.write.mock.calls.find(
        ([call]) => call.relativePath === "remote.txt",
      )![0];
      expect(remoteWrite).toMatchObject({
        executionTargetId: target,
        relativePath: "remote.txt",
        contents: "first line!",
        expectedSha256: hash,
      });
      await vi.waitFor(() =>
        expect(document.querySelector('[role="status"] .sr-only')?.textContent).toBe("Saved"),
      );
      expect(document.querySelector('[role="status"]')?.classList.contains("text-success")).toBe(
        true,
      );
      expect(document.querySelector('[role="status"] [aria-label="Saved"] svg')).not.toBeNull();
      const header = document.querySelector("[data-file-preview-header]")!;
      const navigation = header.firstElementChild!;
      const edit = header.querySelector('[aria-label="Preview file"]')!;
      expect(edit.getAttribute("aria-pressed")).toBe("true");
      expect(edit.querySelector("svg")?.classList.contains("text-info")).toBe(true);
      expect(getComputedStyle(edit.querySelector("svg")!).color).not.toBe(mutedColor);
      const saved = header.querySelector('[role="status"]')!;
      expect(navigation.contains(edit)).toBe(true);
      expect(navigation.contains(saved)).toBe(true);
      expect(saved.getBoundingClientRect().left).toBeGreaterThan(
        navigation.querySelector('[aria-label="Forward"]')!.getBoundingClientRect().right,
      );
      expect(edit.getBoundingClientRect().left).toBeGreaterThan(
        saved.getBoundingClientRect().right,
      );
      (edit as HTMLButtonElement).click();
      await vi.waitFor(() =>
        expect(
          header
            .querySelector('[aria-label="Edit file"] svg')
            ?.classList.contains("text-muted-foreground"),
        ).toBe(true),
      );
      expect(getComputedStyle(header.querySelector('[aria-label="Edit file"] svg')!).color).toBe(
        mutedColor,
      );
    } finally {
      await mounted.unmount();
    }
  });

  it("swings the blue save icon while a write is pending", async () => {
    let finishWrite!: () => void;
    mocks.write.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const mounted = await render(preview("saving.txt"));
    try {
      await vi.waitFor(() => expect(page.getByRole("button", { name: "Edit file" })).toBeVisible());
      document.querySelector<HTMLButtonElement>('[aria-label="Edit file"]')!.click();
      await page.getByRole("textbox", { name: "saving.txt" }).click();
      await userEvent.keyboard("{End}!");
      await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledOnce(), { timeout: 5000 });
      expect(document.querySelector('[role="status"]')?.classList.contains("text-info")).toBe(true);
      expect(
        getComputedStyle(document.querySelector('[aria-label="Preview file"] svg')!).color,
      ).toBe(getComputedStyle(document.querySelector('[role="status"]')!).color);
      expect(document.querySelector('[role="alert"]')).toBeNull();
      expect(
        document.querySelector('[role="status"] svg')?.classList.contains("file-preview-save-sway"),
      ).toBe(true);
      finishWrite();
      await vi.waitFor(() =>
        expect(document.querySelector('[role="status"]')?.classList.contains("text-success")).toBe(
          true,
        ),
      );
    } finally {
      finishWrite?.();
      await mounted.unmount();
    }
  });

  it("shows an explicit conflict and requires a verified disk read before discarding", async () => {
    mocks.write.mockRejectedValueOnce(
      Object.assign(new Error("Workspace file changed since it was read."), {
        conflict: true,
        writeDisposition: "terminal",
      }),
    );
    const mounted = await render(preview("conflict.txt"));
    try {
      await vi.waitFor(() => expect(page.getByRole("button", { name: "Edit file" })).toBeVisible());
      // Keep the automatic post-write verification pending until the explicit refresh below.
      mocks.read.mockImplementationOnce(() => new Promise(() => {}));
      [...document.querySelectorAll<HTMLButtonElement>("[data-file-preview-header] button")]
        .find((button) => button.getAttribute("aria-label") === "Edit file")!
        .click();
      await page.getByRole("textbox", { name: "conflict.txt" }).click();
      await userEvent.keyboard("{End}!");
      await vi.waitFor(() => expect(document.body.textContent).toContain("Refresh file"), {
        timeout: 5000,
      });
      expect(document.body.textContent).not.toContain("Discard draft");
      mocks.read.mockResolvedValue({
        contents: "external",
        truncated: false,
        sizeBytes: 8,
        sha256: "b".repeat(64),
      });
      [...document.querySelectorAll<HTMLButtonElement>("[data-file-preview-header] button")]
        .find((button) => button.textContent === "Refresh file")!
        .click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("File changed on disk"));
      [...document.querySelectorAll<HTMLButtonElement>("[data-file-preview-header] button")]
        .find((button) => button.getAttribute("aria-label") === "Preview file")!
        .click();
      await vi.waitFor(() => expect(document.body.textContent).toContain("Discard draft"));
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      try {
        [...document.querySelectorAll<HTMLButtonElement>("[data-file-preview-header] button")]
          .find((button) => button.textContent === "Discard draft")!
          .click();
        await vi.waitFor(() =>
          expect(document.querySelector(".file-preview-code")?.textContent).toContain("external"),
        );
      } finally {
        confirm.mockRestore();
      }
    } finally {
      await mounted.unmount();
    }
  });
});
