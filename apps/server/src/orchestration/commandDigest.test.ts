import { CommandId, ProjectId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { calculateCommandPayloadDigest, commandPayloadDigestMatches } from "./commandDigest.ts";

describe("orchestration command payload digest", () => {
  it("is stable across command ids and changes when semantic payload changes", () => {
    const base = {
      type: "project.create" as const,
      commandId: CommandId.makeUnsafe("cmd-a"),
      projectId: ProjectId.makeUnsafe("project-digest"),
      title: "Digest",
      workspaceRoot: null,
      defaultModelSelection: { provider: "codex" as const, model: "gpt-5-codex" },
      createdAt: "2026-08-27T00:00:00.000Z",
    };

    expect(calculateCommandPayloadDigest(base)).toEqual(
      calculateCommandPayloadDigest({
        ...base,
        commandId: CommandId.makeUnsafe("cmd-b"),
      }),
    );
    expect(calculateCommandPayloadDigest(base).digest).not.toBe(
      calculateCommandPayloadDigest({ ...base, title: "Changed" }).digest,
    );
    expect(commandPayloadDigestMatches(base, calculateCommandPayloadDigest(base))).toBe(true);
    expect(
      commandPayloadDigestMatches(
        { ...base, title: "Tampered" },
        calculateCommandPayloadDigest(base),
      ),
    ).toBe(false);
  });
});
