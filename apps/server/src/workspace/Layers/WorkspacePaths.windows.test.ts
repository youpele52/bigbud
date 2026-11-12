import { expect, it } from "vitest";
import { hasWindowsPathAlias } from "./WorkspacePaths.windows.ts";

it.each(["folder ", "folder./file", "C:\\root \\file", " "])(
  "detects Win32 alias risk in %j",
  (path) => expect(hasWindowsPathAlias(path)).toBe(true),
);
it.each(["folder/file", " leading/file", "./folder", "../folder", "folder\\file"])(
  "leaves ordinary segments and traversal checks intact for %j",
  (path) => expect(hasWindowsPathAlias(path)).toBe(false),
);
