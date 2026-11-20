import { describe, expect, it } from "vitest";
import { isAbsolutePath, isWindowsAbsolutePath } from "./path";

describe("isAbsolutePath", () => {
  it("accepts POSIX, Windows drive and UNC paths", () => {
    for (const path of ["/", "/Users/me/a.png", "C:\\a.png", "c:/a.png", "\\\\server\\share\\a"]) {
      expect(isAbsolutePath(path), path).toBe(true);
    }
  });

  it("rejects relative, home-relative and bare paths", () => {
    for (const path of ["", "a.png", "./a.png", "../a", "~/a.png", "C:a.png", "\\a", "1:\\a"]) {
      expect(isAbsolutePath(path), path).toBe(false);
    }
  });
});

describe("isWindowsAbsolutePath", () => {
  it("accepts only drive and UNC paths", () => {
    expect(isWindowsAbsolutePath("D:\\x")).toBe(true);
    expect(isWindowsAbsolutePath("\\\\host\\x")).toBe(true);
    expect(isWindowsAbsolutePath("/x")).toBe(false);
  });
});
