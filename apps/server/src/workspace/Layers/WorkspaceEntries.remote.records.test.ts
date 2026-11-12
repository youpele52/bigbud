import { describe, expect, it } from "vitest";
import { parseRemoteFindRecord } from "./WorkspaceEntries.remote.records.ts";

describe("parseRemoteFindRecord", () => {
  it.each([" name ", "\tname\t", "line\nbreak ", " ", "-name", "a'$(echo x)"])(
    "preserves filename %j",
    (path) => {
      expect(parseRemoteFindRecord(`f\t${path}`)).toEqual({ path, kind: "file" });
      expect(parseRemoteFindRecord(`d\t${path}`)).toEqual({ path, kind: "directory" });
    },
  );
  it.each(["", "f", "x\tname", "f\t", "f\t.", "f\ta\0b"])("rejects malformed record %j", (record) =>
    expect(parseRemoteFindRecord(record)).toBeNull(),
  );
});
