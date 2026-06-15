import { describe, expect, it } from "vitest";

import { buildHandoffSeedMessage } from "./handoff";

describe("buildHandoffSeedMessage", () => {
  it("builds a user seed message that tells the next branch to read the handoff file", () => {
    const seedMessage = buildHandoffSeedMessage(
      "/Users/test/.bigbud/skills/handoff/tmp/handoff-1.md",
    );

    expect(seedMessage.role).toBe("user");
    expect(seedMessage.text).toContain("read the handoff document");
    expect(seedMessage.text).toContain("/Users/test/.bigbud/skills/handoff/tmp/handoff-1.md");
    expect(seedMessage.attachments).toEqual([
      {
        type: "path",
        id: expect.any(String),
        name: "handoff-1.md",
        mimeType: "text/markdown",
        sizeBytes: 0,
        path: "/Users/test/.bigbud/skills/handoff/tmp/handoff-1.md",
        entryKind: "file",
      },
    ]);
  });
});
