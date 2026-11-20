import { describe, expect, it } from "vitest";

import { readWorkflow, type Job } from "./ciWorkflowInvariants.helpers.ts";

const ci = readWorkflow("ci.yml");
const VERDICT = "ci_passed";
const MAIN_ONLY_BUILDS = [
  "desktop_release_build",
  "workspace_agent_windows_arm64",
  "workspace_agent_linux_arm64",
] as const;

const job = (id: string): Job => {
  const found = ci.jobs[id];
  if (!found) throw new Error(`ci.yml has no job ${id}`);
  return found;
};
const needsOf = (id: string): string[] => {
  const needs = job(id).needs;
  return needs === undefined ? [] : typeof needs === "string" ? [needs] : [...needs];
};
const sorted = (values: Iterable<string>) => [...values].toSorted();
const verdictStep = () => {
  const step = job(VERDICT).steps?.[0];
  if (!step) throw new Error("ci_passed has no step");
  return step;
};

describe("ci.yml CI passed verdict", () => {
  it("replaces the monolithic quality job", () => {
    expect(ci.jobs.quality).toBeUndefined();
  });

  it("always runs under the check name the release gate and ruleset look for", () => {
    expect(job(VERDICT).name).toBe("CI passed");
    expect(job(VERDICT).if).toBe("always()");
    expect(job(VERDICT)["timeout-minutes"]).toBe(5);
  });

  it("needs every unconditional job plus the shard coverage check, and no preview build", () => {
    // Conditional jobs are main-only builds and assembly; the coverage check skips only on cancel.
    const unconditional = Object.entries(ci.jobs)
      .filter(([id, entry]) => id !== VERDICT && entry.if === undefined)
      .map(([id]) => id);
    const expected = sorted([...unconditional, "test_server_shard_coverage"]);
    expect(sorted(needsOf(VERDICT))).toEqual(expected);
    expect(new Set(needsOf(VERDICT)).size).toBe(needsOf(VERDICT).length);
    for (const id of [...MAIN_ONLY_BUILDS, "release_asset_assembly"])
      expect(needsOf(VERDICT), id).not.toContain(id);
  });

  it("checks the exact needed job list as well as every result (no vacuous pass)", () => {
    const step = verdictStep();
    expect(step.env?.NEEDS).toBe("${{ toJSON(needs) }}");
    const listed = String(step.env?.EXPECTED_JOBS).split(/\s+/).filter(Boolean);
    expect(listed).toHaveLength(needsOf(VERDICT).length);
    expect(sorted(listed)).toEqual(sorted(needsOf(VERDICT)));
    expect(step.run).toContain("(keys | sort) == $expected");
    expect(step.run).toContain("length == ($expected | length)");
    expect(step.run).toContain('all(.[]; .result == "success")');
    expect(step.run).toContain("jq -e");
    expect(step.run).toContain("GITHUB_STEP_SUMMARY");
  });

  it("never lets a needed job or one of its steps continue on error", () => {
    for (const id of needsOf(VERDICT)) {
      expect(job(id)["continue-on-error"], id).toBeUndefined();
      for (const step of job(id).steps ?? []) expect(step["continue-on-error"], id).toBeUndefined();
    }
  });

  it("starts the main-only builds immediately; only assembly waits for the verdict", () => {
    for (const id of MAIN_ONLY_BUILDS) expect(job(id).needs, id).toBeUndefined();
    expect(sorted(needsOf("release_asset_assembly"))).toEqual(
      sorted([VERDICT, ...MAIN_ONLY_BUILDS]),
    );
  });

  it("keeps one designated writer of the Bun and Electron caches", () => {
    const writers = Object.entries(ci.jobs)
      .filter(([, entry]) =>
        (entry.steps ?? []).some(
          (step) =>
            step.uses === "./.github/actions/setup-bigbud" && step.with?.["save-caches"] === "true",
        ),
      )
      .map(([id]) => id);
    expect(writers).toEqual(["fmt_lint"]);
  });
});
