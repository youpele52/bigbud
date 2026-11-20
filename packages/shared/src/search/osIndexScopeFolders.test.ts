import { describe, expect, it } from "vitest";

import {
  OS_INDEX_COMMON_FOLDERS,
  OS_INDEX_MACOS_CLOUD_FOLDERS,
  OS_INDEX_MACOS_NOISE_FOLDER,
} from "./osIndexScopeFolders";

describe("osIndexScopeFolders", () => {
  it("lists the common folders and the macOS cloud folders search reads", () => {
    expect(OS_INDEX_COMMON_FOLDERS).toEqual([
      "Desktop",
      "Documents",
      "Downloads",
      "Music",
      "Pictures",
    ]);
    // iCloud Drive and File Provider storage stay searchable at `unrestricted`.
    expect(OS_INDEX_MACOS_CLOUD_FOLDERS).toEqual([
      "Library/Mobile Documents",
      "Library/CloudStorage",
    ]);
    for (const folder of OS_INDEX_MACOS_CLOUD_FOLDERS) {
      expect(folder.startsWith(`${OS_INDEX_MACOS_NOISE_FOLDER}/`)).toBe(true);
    }
  });
});
