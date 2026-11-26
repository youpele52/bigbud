import "../../index.css";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { hash, mocks, preview } from "./FilePreview.edit.fixtures";

describe("Files panel editing preserves file encoding details", () => {
  beforeEach(() => {
    mocks.write.mockReset().mockResolvedValue({ relativePath: "crlf.txt" });
  });

  it("saves a BOM and CRLF line endings exactly as read", async () => {
    mocks.read.mockReset().mockResolvedValue({
      contents: "﻿first\r\nsecond",
      truncated: false,
      sizeBytes: 16,
      sha256: hash,
    });
    const mounted = await render(preview("crlf.txt"));
    try {
      await vi.waitFor(() => expect(page.getByRole("button", { name: "Edit file" })).toBeVisible());
      await page.getByRole("button", { name: "Edit file" }).click();
      await page.getByRole("textbox", { name: "crlf.txt" }).click();
      await userEvent.keyboard("{Control>}{End}{/Control}{Meta>}{ArrowDown}{/Meta}{End}!");
      await vi.waitFor(() => expect(mocks.write).toHaveBeenCalled(), { timeout: 5000 });
      const contents = mocks.write.mock.calls.at(-1)![0].contents as string;
      expect(contents.startsWith("﻿")).toBe(true);
      expect(contents).toContain("\r\n");
      expect(contents.replace(/\r\n/g, "")).not.toContain("\n");
      expect(contents.endsWith("second!")).toBe(true);
    } finally {
      await mounted.unmount();
    }
  });
});
