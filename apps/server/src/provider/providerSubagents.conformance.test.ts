import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PROVIDER_KINDS } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { PROVIDER_SUBAGENT_CAPABILITIES } from "./providerSubagents.capabilities.ts";

const providerRoot = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.dirname(providerRoot);

/** Production files under `provider/Layers` that declare an adapter capability literal. */
function adapterCapabilityFiles(): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        entry.name.endsWith(".ts") &&
        !/\.(test|fixture|helpers)\.|\.test\.|test\.helpers/.test(entry.name) &&
        /\bsessionModelSwitch:\s*"/.test(readFileSync(full, "utf8"))
      )
        files.push(full);
    }
  };
  walk(path.join(providerRoot, "Layers"));
  return files;
}

describe("provider subagent capability conformance", () => {
  it("declares a capability with evidence for every provider kind", () => {
    for (const provider of PROVIDER_KINDS) {
      const capability = PROVIDER_SUBAGENT_CAPABILITIES[provider];
      expect(capability, provider).toBeDefined();
      expect(["native", "none", "gated"], provider).toContain(capability.support);
      expect(capability.evidence.trim().length, provider).toBeGreaterThan(20);
      if (capability.support !== "native") expect(capability.fields, provider).toEqual([]);
    }
  });

  it("backs every native or gated declaration with existing providerSubagent tests", () => {
    for (const provider of PROVIDER_KINDS) {
      const capability = PROVIDER_SUBAGENT_CAPABILITIES[provider];
      if (capability.support === "none") continue;
      if (capability.support === "native") {
        expect(capability.fields, provider).toContain("status");
        expect(capability.fields, provider).toContain("subject");
      }
      expect(capability.tests.length, `${provider} has no mapping tests`).toBeGreaterThan(0);
      for (const test of capability.tests) {
        const file = path.join(sourceRoot, test);
        expect(existsSync(file), `${provider}: missing ${test}`).toBe(true);
        expect(test, provider).toMatch(/\.test\.ts$/);
        expect(readFileSync(file, "utf8"), `${provider}: ${test}`).toContain("providerSubagent");
      }
    }
  });

  it("requires every production adapter to declare capabilities.subagents", () => {
    const files = adapterCapabilityFiles();
    // Every registered provider family has at least one capability literal.
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const literals = source.match(/\bsessionModelSwitch:\s*"/g)?.length ?? 0;
      const declarations =
        source.match(/\bsubagents:\s*PROVIDER_SUBAGENT_CAPABILITIES\.[a-zA-Z]+/g)?.length ?? 0;
      expect(declarations, path.relative(sourceRoot, file)).toBe(literals);
    }
  });
});
