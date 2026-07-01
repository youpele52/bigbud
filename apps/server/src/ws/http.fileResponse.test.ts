import { describe, expect, it } from "vitest";

import { parseByteRangeHeader } from "./http.fileResponse.ts";

describe("parseByteRangeHeader", () => {
  it("returns null when no range header is present", () => {
    expect(parseByteRangeHeader(undefined, 100)).toBeNull();
    expect(parseByteRangeHeader("text/plain", 100)).toBeNull();
  });

  it("parses an open-ended byte range", () => {
    expect(parseByteRangeHeader("bytes=10-", 100)).toEqual({ start: 10, end: 99 });
  });

  it("parses a closed byte range", () => {
    expect(parseByteRangeHeader("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
  });

  it("parses suffix byte ranges", () => {
    expect(parseByteRangeHeader("bytes=-20", 100)).toEqual({ start: 80, end: 99 });
  });

  it("clamps the end offset to the file size", () => {
    expect(parseByteRangeHeader("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
  });

  it("returns unsatisfiable when the start offset is past the file end", () => {
    expect(parseByteRangeHeader("bytes=100-", 100)).toBe("unsatisfiable");
  });
});
