import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PROVIDER_KINDS } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

const SUBAGENT_DISPLAY_FILES = [
  "SubagentsCard.tsx",
  "SubagentsCard.hierarchy.ts",
  "SubagentRow.tsx",
  "SubagentRow.details.tsx",
  "subagentPresentation.logic.ts",
];

describe("Subagents card stays provider-agnostic", () => {
  it("has no provider-specific branches; labels come from task data", () => {
    for (const file of SUBAGENT_DISPLAY_FILES) {
      const source = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8");
      for (const provider of PROVIDER_KINDS) {
        expect(source, `${file} mentions ${provider}`).not.toMatch(
          new RegExp(`["'\`]${provider}["'\`]`),
        );
      }
      expect(source, file).not.toMatch(/\.provider\b/);
    }
  });
});
