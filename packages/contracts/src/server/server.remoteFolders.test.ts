import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ServerListRemoteFoldersInput,
  ServerListRemoteFoldersResult,
} from "./server.remoteFolders";

describe("server.listRemoteFolders schemas", () => {
  it("round-trips a folder listing", () => {
    const result = {
      path: "/home/dev",
      homePath: "/home/dev",
      folders: [
        { name: "api", isGitRepo: true },
        { name: "with space", isGitRepo: false },
      ],
      truncated: false,
    };

    const encoded = Schema.encodeUnknownSync(ServerListRemoteFoldersResult)(result);
    expect(Schema.decodeUnknownSync(ServerListRemoteFoldersResult)(encoded)).toEqual(result);
  });

  it("accepts a missing path and rejects an empty one", () => {
    const decode = Schema.decodeUnknownSync(ServerListRemoteFoldersInput);
    expect(decode({ executionTargetId: "ssh:box" })).toEqual({ executionTargetId: "ssh:box" });
    expect(() => decode({ executionTargetId: "ssh:box", path: "  " })).toThrow();
  });
});
