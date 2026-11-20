import { describe, expect, it } from "vitest";

import {
  readPackageScripts,
  readWorkflow,
  type Job,
  type Step,
  type Workflow,
} from "./ciWorkflowInvariants.helpers.ts";

interface ReleaseJob extends Job {
  readonly permissions?: Record<string, string>;
  readonly outputs?: Record<string, string>;
  readonly with?: Record<string, unknown>;
  readonly secrets?: unknown;
}
interface ReleaseWorkflow extends Workflow {
  readonly permissions?: Record<string, string>;
}
interface ReusableWorkflow extends Workflow {
  readonly on: {
    readonly workflow_call: {
      readonly inputs: Record<string, { type?: string; default?: unknown }>;
    };
  };
}

const release = readWorkflow("release.yml") as ReleaseWorkflow;
const ci = readWorkflow("ci.yml");
const REUSABLE = {
  build: "release-desktop-build.yml",
  remote_agent_build: "release-remote-agent-build.yml",
  remote_backend_graph_build: "release-remote-backend-graph.yml",
} as const;
const SIGNING_JOBS = new Set(["build", "remote_backend_graph_build", "release"]);
const PUBLISH_IF = "${{ github.event_name == 'push' || inputs.publish == true }}";
const RETENTION_OUTPUT = "${{ fromJSON(needs.preflight.outputs.artifact_retention_days) }}";

const job = (id: string): ReleaseJob => {
  const found = release.jobs[id];
  if (!found) throw new Error(`release.yml has no job ${id}`);
  return found as ReleaseJob;
};
const needsOf = (entry: Job): string[] =>
  entry.needs === undefined
    ? []
    : typeof entry.needs === "string"
      ? [entry.needs]
      : [...entry.needs];
const steps = (id: string): readonly Step[] => job(id).steps ?? [];
const stepNamed = (id: string, name: string): Step => {
  const found = steps(id).find((step) => step.name === name);
  if (!found) throw new Error(`release.yml job ${id} has no step '${name}'`);
  return found;
};
const uploads = (workflow: Workflow) =>
  Object.values(workflow.jobs)
    .flatMap((entry) => entry.steps ?? [])
    .filter((step) => step.uses?.startsWith("actions/upload-artifact@"));

describe("release.yml permissions and triggers", () => {
  it("defaults to read-only contents and grants write only to the publish job", () => {
    expect(release.permissions).toEqual({ contents: "read" });
    expect(job("release").permissions).toEqual({ contents: "write" });
    const writers = Object.entries(release.jobs)
      .filter(([, entry]) =>
        Object.values((entry as ReleaseJob).permissions ?? {}).includes("write"),
      )
      .map(([id]) => id);
    expect(writers).toEqual(["release"]);
  });

  it("makes manual dispatches dry runs unless publish is explicitly true", () => {
    const inputs = (release.on.workflow_dispatch as { inputs: Record<string, unknown> }).inputs;
    expect(inputs.publish).toMatchObject({ type: "boolean", default: false, required: false });
    expect(job("release").if).toBe(PUBLISH_IF);
  });

  it("references signing secrets only in the signing and publish jobs", () => {
    for (const [id, entry] of Object.entries(release.jobs)) {
      const mentionsSecrets = JSON.stringify(entry).includes("secrets");
      expect(mentionsSecrets, id).toBe(SIGNING_JOBS.has(id));
    }
  });
});

describe("release.yml preflight and builds", () => {
  it("resolves metadata only, with an ignore-scripts install and a 15 minute timeout", () => {
    const preflight = job("preflight");
    expect(preflight.name).toBe("Preflight");
    expect(preflight["timeout-minutes"]).toBe(15);
    const commands = steps("preflight")
      .map((step) => step.run ?? "")
      .join("\n");
    expect(commands).toContain("bun install --frozen-lockfile --ignore-scripts");
    expect(commands).toContain("bun scripts/resolve-release-metadata.ts");
    for (const forbidden of [
      "bun run test",
      "typecheck",
      "bun run lint",
      "fmt:check",
      "cargo",
      "playwright",
      "test:browser",
    ])
      expect(commands, forbidden).not.toContain(forbidden);
    expect(steps("preflight").some((step) => step.uses?.startsWith("dtolnay/"))).toBe(false);
  });

  it("starts every build on preflight alone", () => {
    expect(needsOf(job("build"))).toEqual(["preflight"]);
    for (const id of Object.keys(release.jobs).filter(
      (key) => !["preflight", "release"].includes(key),
    ))
      expect(needsOf(job(id)), id).toEqual(["preflight"]);
  });

  it("keeps unpublished dry-run artifacts for 3 days only", () => {
    expect(job("preflight").outputs?.artifact_retention_days).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.publish != true && 3 || 0 }}",
    );
    for (const [id, file] of Object.entries(REUSABLE)) {
      expect(job(id).with?.retention_days, id).toBe(RETENTION_OUTPUT);
      const reusable = readWorkflow(file) as ReusableWorkflow;
      expect(reusable.on.workflow_call.inputs.retention_days).toMatchObject({
        type: "number",
        default: 0,
      });
      for (const step of uploads(reusable)) {
        const retention = step.with?.["retention-days"];
        if (String(step.with?.name).startsWith("notarization-recovery-")) expect(retention).toBe(3);
        else
          expect(retention, `${file} ${String(step.with?.name)}`).toBe(
            "${{ inputs.retention_days || 0 }}",
          );
      }
    }
    for (const step of uploads(release))
      expect(step.with?.["retention-days"], String(step.with?.name)).toBe(RETENTION_OUTPUT);
  });
});

describe("release.yml CI gate", () => {
  const gate = job("ci_gate");

  it("needs only preflight and reads Actions without secrets or write access", () => {
    expect(needsOf(gate)).toEqual(["preflight"]);
    expect(gate.permissions).toEqual({ actions: "read", contents: "read" });
    expect(JSON.stringify(gate)).not.toContain("secrets");
  });

  it("checks out the release commit and asserts HEAD before waiting", () => {
    const checkout = steps("ci_gate").find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with).toEqual({
      ref: "${{ needs.preflight.outputs.ref }}",
      "persist-credentials": false,
    });
    const assertIndex = steps("ci_gate").findIndex(
      (step) => step.name === "Assert the checkout is the release commit",
    );
    const waitIndex = steps("ci_gate").findIndex(
      (step) => step.name === "Wait for CI passed on the release commit",
    );
    expect(assertIndex).toBeGreaterThan(0);
    expect(assertIndex).toBeLessThan(waitIndex);
    const assertStep = steps("ci_gate")[assertIndex]!;
    expect(assertStep.env?.RELEASE_SHA).toBe("${{ needs.preflight.outputs.ref }}");
    expect(assertStep.run).toContain('head="$(git rev-parse HEAD)"');
    expect(assertStep.run).toContain('"$head" != "$RELEASE_SHA"');
  });

  it("waits for the ci.yml job named exactly like the CI verdict, within the job timeout", () => {
    const wait = stepNamed("ci_gate", "Wait for CI passed on the release commit");
    expect(wait.env).toEqual({
      GITHUB_TOKEN: "${{ github.token }}",
      RELEASE_SHA: "${{ needs.preflight.outputs.ref }}",
    });
    const run = wait.run ?? "";
    expect(run).toMatch(/^node scripts\/wait-for-ci-verdict\.ts /);
    expect(run).toContain('--sha "$RELEASE_SHA"');
    expect(run).toContain("--workflow ci.yml");
    expect(run).toContain(`--job "${ci.jobs.ci_passed?.name}"`);
    expect(ci.jobs.ci_passed?.name).toBe("CI passed");
    const minutes = Number(/--timeout-minutes (\d+)/.exec(run)?.[1]);
    expect(minutes).toBe(70);
    expect(gate["timeout-minutes"]).toBeGreaterThan(minutes);
    // The documented Bun entry point runs the same file the gate runs directly.
    expect(readPackageScripts("package.json")["ci:wait-for-verdict"]).toBe(
      "node scripts/wait-for-ci-verdict.ts",
    );
  });

  it("publishes only after the gate, every build and both native cleanup jobs", () => {
    const others = Object.keys(release.jobs).filter((id) => id !== "release");
    expect(needsOf(job("release")).toSorted()).toEqual(others.toSorted());
    expect(needsOf(job("release"))).toEqual(
      expect.arrayContaining([
        "ci_gate",
        "native_resource_cleanup",
        "native_resource_cleanup_mount",
      ]),
    );
  });
});
