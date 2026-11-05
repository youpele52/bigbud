import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ProjectWriteFileError } from "./project";

describe("project write disposition", () => {
  it.each(["not-dispatched", "terminal", "unknown"] as const)(
    "roundtrips %s",
    (writeDisposition) => {
      const error = new ProjectWriteFileError({ message: "Write failed", writeDisposition });
      expect(
        Schema.decodeUnknownSync(ProjectWriteFileError)(
          Schema.encodeSync(ProjectWriteFileError)(error),
        ),
      ).toMatchObject({ writeDisposition });
    },
  );

  it("accepts legacy errors without asserting settlement", () => {
    expect(
      Schema.decodeUnknownSync(ProjectWriteFileError)({
        _tag: "ProjectWriteFileError",
        message: "Write failed",
      }).writeDisposition,
    ).toBeUndefined();
  });

  it("rejects unsupported disposition values", () => {
    expect(() =>
      Schema.decodeUnknownSync(ProjectWriteFileError)({
        _tag: "ProjectWriteFileError",
        message: "Write failed",
        writeDisposition: "retryable",
      }),
    ).toThrow();
  });
});
