import { expect, it } from "vitest";
import path from "node:path";
import { v2SharedProtectedResources } from "./Runtime.policy.shared.paths.ts";
import { v2SharedToolPolicy } from "./Runtime.policy.shared.ts";

// Pinned upstream 2.0.24 core/src/util/wildcard.ts semantics (slash folding and Windows case folding).
function matches(input: string, pattern: string) {
  const escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "si").test(input.replaceAll("\\", "/"));
}

it("protects DOS and long-path Windows spelling with native case/slash semantics", () => {
  const resources = v2SharedProtectedResources(["\\\\?\\C:\\User Space\\state"], true);
  for (const name of [
    "c:/USER SPACE/state",
    "C:\\User Space\\state\\service.json",
    "\\\\?\\c:\\user space\\state\\db-wal",
  ])
    expect(resources.some((pattern) => matches(name, pattern))).toBe(true);
  expect(resources.some((pattern) => matches("C:\\User Space\\state-sibling\\file", pattern))).toBe(
    false,
  );
});

it("preserves access modes and appends denies for the verified registration directory", () => {
  const database = path.resolve("fixture/data/db");
  const registration = path.resolve("fixture/custom-state/service.json");
  for (const mode of ["full-access", "auto-accept-edits", "approval-required"] as const) {
    const rules = v2SharedToolPolicy(mode, database, true, registration);
    expect(rules[0]!.effect).toBe(mode === "full-access" ? "allow" : "ask");
    expect(rules[1]!.effect).toBe(mode === "approval-required" ? "ask" : "allow");
    expect(rules).toContainEqual({
      action: "read",
      resource: path.dirname(registration),
      effect: "deny",
    });
    expect(rules).toContainEqual({ action: "subagent", resource: "*", effect: "deny" });
  }
  expect(v2SharedToolPolicy("full-access", database, false, registration)).toEqual([
    { action: "*", resource: "*", effect: "deny" },
  ]);
});
