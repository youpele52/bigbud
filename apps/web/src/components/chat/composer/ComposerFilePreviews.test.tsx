import { describe, expect, it, vi } from "vitest";

import { NewChatIcon } from "../../common/NewChatIcon";
import { ComposerFilePreviews } from "./ComposerFilePreviews";

describe("ComposerFilePreviews", () => {
  it("uses the shared chat icon for thread-reference attachments", () => {
    const element = ComposerFilePreviews({
      composerFiles: [
        {
          type: "file",
          id: "attachment-thread-1",
          name: "Keep threads in...",
          mimeType: "application/x-bigbud-thread-reference",
          sizeBytes: 0,
          attachmentMode: "thread-reference",
          filePath: "",
          file: null,
        },
      ],
      resolvedTheme: "dark",
      onRemoveFile: vi.fn(),
    });
    const chip = element?.props.children[0];

    expect(chip.props.children[0].type).toBe(NewChatIcon);
    expect(chip.props.children[0].props.className).toBe("size-3.5 shrink-0 opacity-70");
  });
});
