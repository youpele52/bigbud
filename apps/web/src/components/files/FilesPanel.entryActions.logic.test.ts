import { describe, expect, it } from "vitest";

import {
  createEntryErrorMessage,
  deleteConfirmationCopy,
  entryActionDisabledReason,
  isSameOrDescendantPath,
  joinRelativeEntryPath,
  parentRelativePath,
  resolveCreateTargetFolder,
  validateNewEntryName,
} from "./FilesPanel.entryActions.logic";
import { FILE_EDIT_READ_ONLY_COPY } from "./fileEditEligibility";

describe("new entry names", () => {
  it.each([
    ["", "Enter a name."],
    ["   ", "Enter a name."],
    [".", "That name isn't allowed."],
    ["..", "That name isn't allowed."],
    ["a/b", "A name can't contain / or \\."],
    ["a\\b", "A name can't contain / or \\."],
    ["x".repeat(256), "That name is too long."],
  ])("refuses %j", (name, message) => {
    expect(validateNewEntryName(name)).toBe(message);
  });

  it("accepts one path segment, including dotfiles", () => {
    expect(validateNewEntryName("README.md")).toBeNull();
    expect(validateNewEntryName(".env")).toBeNull();
    expect(joinRelativeEntryPath("", "a.ts")).toBe("a.ts");
    expect(joinRelativeEntryPath("src/lib", "a.ts")).toBe("src/lib/a.ts");
    expect(parentRelativePath("src/lib/a.ts")).toBe("src/lib");
    expect(parentRelativePath("a.ts")).toBe("");
  });
});

describe("create target folder", () => {
  it("uses the last opened folder while it is visible, else its visible ancestor, else root", () => {
    expect(resolveCreateTargetFolder(null, {})).toBe("");
    expect(resolveCreateTargetFolder("src/lib", { src: true, "src/lib": true })).toBe("src/lib");
    expect(resolveCreateTargetFolder("src/lib", { src: true, "src/lib": false })).toBe("src");
    expect(resolveCreateTargetFolder("src/lib", { src: false, "src/lib": true })).toBe("");
  });
});

describe("delete confirmation copy", () => {
  it("names a file and says where it goes", () => {
    const copy = deleteConfirmationCopy({
      target: { relativePath: "docs/README.md", kind: "file" },
      permanent: false,
      remote: false,
    });
    expect(copy.title).toBe("Delete README.md?");
    expect(copy.description).toBe("The file moves to the Trash.");
    expect(copy.confirmLabel).toBe("Move to Trash");
  });

  it("names a folder and says everything inside is deleted", () => {
    const copy = deleteConfirmationCopy({
      target: { relativePath: "src/lib", kind: "directory" },
      permanent: false,
      remote: false,
    });
    expect(copy.title).toBe("Delete lib?");
    expect(copy.description).toContain("This deletes the folder lib and everything inside it.");
  });

  it("says a remote delete can't be undone and a missing Trash is permanent", () => {
    const remote = deleteConfirmationCopy({
      target: { relativePath: "a.txt", kind: "file" },
      permanent: true,
      remote: true,
    });
    expect(remote.description).toBe("This can't be undone.");
    expect(remote.confirmLabel).toBe("Delete permanently");
    const noTrash = deleteConfirmationCopy({
      target: { relativePath: "a.txt", kind: "file" },
      permanent: true,
      remote: false,
    });
    expect(noTrash.description).toContain("deleted permanently");
  });
});

describe("action gating and errors", () => {
  it("uses the editor read-only copy for Direct SSH and old agents", () => {
    expect(entryActionDisabledReason({ allowed: true })).toBeNull();
    expect(entryActionDisabledReason({ allowed: false, reason: "directSshPendingOwner" })).toBe(
      FILE_EDIT_READ_ONLY_COPY.directSshPendingOwner,
    );
    expect(
      entryActionDisabledReason({ allowed: false, reason: "agentTooOld", permanent: true }),
    ).toBe(FILE_EDIT_READ_ONLY_COPY.agentTooOld);
    // Unknown support (still loading or an older server) stays disabled.
    expect(entryActionDisabledReason(null)).not.toBeNull();
  });

  it("explains a name collision without overwriting", () => {
    expect(createEntryErrorMessage({ alreadyExists: true, message: "x" }, "a.ts")).toBe(
      "a.ts already exists here. Choose another name.",
    );
    expect(createEntryErrorMessage(new Error("Disk full"), "a.ts")).toBe("Disk full");
    expect(isSameOrDescendantPath("src/a.ts", "src")).toBe(true);
    expect(isSameOrDescendantPath("srcx/a.ts", "src")).toBe(false);
  });
});
