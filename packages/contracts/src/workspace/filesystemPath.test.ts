import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { FilesystemPath } from "./filesystemPath";
import {
  ProjectListDirectoryInput,
  ProjectListDirectoryResult,
  ProjectReadFilePreviewInput,
  ProjectWriteFileInput,
  ProjectDirectoryWatchInput,
} from "./project";

describe("filesystem path identity", () => {
  it.each([" leading", "trailing ", " ", "tab\t", "line\nbreak", "unicode\u00a0"])(
    "round trips %j without normalization",
    (path) => {
      expect(Schema.decodeUnknownSync(FilesystemPath)(path)).toBe(path);
      expect(Schema.encodeSync(FilesystemPath)(path)).toBe(path);
      const input = { cwd: "/workspace ", relativePath: path };
      expect(Schema.decodeUnknownSync(ProjectListDirectoryInput)(input)).toEqual(input);
      expect(Schema.decodeUnknownSync(ProjectReadFilePreviewInput)(input)).toEqual(input);
      expect(Schema.decodeUnknownSync(ProjectDirectoryWatchInput)(input)).toEqual(input);
      expect(Schema.decodeUnknownSync(ProjectWriteFileInput)({ ...input, contents: "x" })).toEqual({
        ...input,
        contents: "x",
      });
      const result = {
        entries: [{ path: `${path}/child `, parentPath: path, kind: "file" as const }],
      };
      expect(Schema.encodeSync(ProjectListDirectoryResult)(result)).toEqual(result);
    },
  );
  it.each(["", "a\0b"])("rejects invalid path %j", (path) => {
    expect(() => Schema.decodeUnknownSync(FilesystemPath)(path)).toThrow();
  });
  it("preserves the optional root directory sentinel", () => {
    expect(Schema.decodeUnknownSync(ProjectDirectoryWatchInput)({ cwd: "/workspace" })).toEqual({
      cwd: "/workspace",
    });
  });
});
