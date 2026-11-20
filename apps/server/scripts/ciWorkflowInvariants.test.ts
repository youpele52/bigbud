import { describe, expect, it } from "vitest";

import {
  actionPath,
  readAction,
  readText,
  readWorkflow,
  workflowPath,
  type CompositeAction,
  type Step,
  type Workflow,
} from "./ciWorkflowInvariants.helpers.ts";

const RELEASE_WORKFLOWS = [
  "release.yml",
  "release-desktop-build.yml",
  "release-remote-agent-build.yml",
  "release-remote-backend-graph.yml",
] as const;
const PIPELINE_WORKFLOWS = ["ci.yml", ...RELEASE_WORKFLOWS] as const;
const COMPOSITE_ACTIONS = ["setup-bigbud", "setup-rust-native"] as const;

const PINNED_ACTION = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/;
const PINNED_LINE = /^\s*(?:- )?uses: [\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40} # \S+$/;
const MAIN_PUSH_GUARDS = ["github.event_name == 'push'", "github.ref == 'refs/heads/main'"];

/** Every `uses` reference of a workflow (job-level reusable calls and steps) or a composite. */
function usesOf(document: Workflow | CompositeAction): string[] {
  if ("runs" in document) return document.runs.steps.flatMap((step) => step.uses ?? []);
  return Object.values(document.jobs).flatMap((job) =>
    (job.uses ? [job.uses] : []).concat((job.steps ?? []).flatMap((step) => step.uses ?? [])),
  );
}

/** Remote references that are not pinned to a full commit SHA. Local `./` paths are allowed. */
function unpinnedUses(uses: readonly string[]): string[] {
  return uses.filter((ref) => !ref.startsWith("./") && !PINNED_ACTION.test(ref));
}

/** Remote `uses:` lines without a trailing comment naming the resolved ref (for example `# v6`). */
function uncommentedPins(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => /^\s*(?:- )?uses: /.test(line) && !/uses: \.\//.test(line))
    .filter((line) => !PINNED_LINE.test(line));
}

/** Non-reusable jobs without a positive integer `timeout-minutes`. */
function jobsWithoutTimeout(workflow: Workflow): string[] {
  return Object.entries(workflow.jobs)
    .filter(([, job]) => job.uses === undefined)
    .filter(([, job]) => {
      const timeout = job["timeout-minutes"];
      return !(typeof timeout === "number" && Number.isInteger(timeout) && timeout > 0);
    })
    .map(([id]) => id);
}

/** Cache-save steps that could run outside a push to main. */
function unguardedCacheSaves(steps: readonly Step[]): Step[] {
  return steps.filter(
    (step) =>
      step.uses?.startsWith("actions/cache/save@") &&
      !MAIN_PUSH_GUARDS.every((guard) => step.if?.includes(guard)),
  );
}

const allSteps = (workflow: Workflow) =>
  Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);

describe("workflow invariant checkers", () => {
  it("flag tag references and accept SHA pins and local paths", () => {
    expect(
      unpinnedUses([
        "actions/checkout@v6",
        "actions/cache/save@caa296126883cff596d87d8935842f9db880ef25",
        "./.github/actions/setup-bigbud",
        "dtolnay/rust-toolchain@stable",
      ]),
    ).toEqual(["actions/checkout@v6", "dtolnay/rust-toolchain@stable"]);
  });

  it("flag pins without a ref comment", () => {
    const sha = "d23441a48e516b6c34aea4fa41551a30e30af803";
    expect(
      uncommentedPins(
        [
          `      - uses: actions/checkout@${sha} # v6`,
          `        uses: actions/checkout@${sha}`,
          "        uses: ./.github/workflows/release-desktop-build.yml",
          "    uses: actions/checkout@v6 # v6",
        ].join("\n"),
      ),
    ).toEqual([`        uses: actions/checkout@${sha}`, "    uses: actions/checkout@v6 # v6"]);
  });

  it("flag missing, non-numeric and zero timeouts but skip reusable callers", () => {
    const workflow = {
      on: {},
      jobs: {
        ok: { "runs-on": "ubuntu-24.04", "timeout-minutes": 10, steps: [] },
        missing: { "runs-on": "ubuntu-24.04", steps: [] },
        text: { "runs-on": "ubuntu-24.04", "timeout-minutes": "10", steps: [] },
        zero: { "runs-on": "ubuntu-24.04", "timeout-minutes": 0, steps: [] },
        caller: { uses: "./.github/workflows/release-desktop-build.yml" },
      },
    } satisfies Workflow;
    expect(jobsWithoutTimeout(workflow)).toEqual(["missing", "text", "zero"]);
  });

  it("flag cache saves that are not limited to main pushes", () => {
    const save = "actions/cache/save@caa296126883cff596d87d8935842f9db880ef25";
    const guarded = `github.event_name == 'push' && github.ref == 'refs/heads/main'`;
    const steps: Step[] = [
      { uses: save, if: guarded },
      { uses: save, if: "github.event_name == 'push'" },
      { uses: save },
    ];
    expect(unguardedCacheSaves(steps)).toEqual([steps[1], steps[2]]);
  });
});

describe("pipeline workflow invariants", () => {
  it.each(PIPELINE_WORKFLOWS)("%s pins every action to a commit SHA with a ref comment", (file) => {
    expect(unpinnedUses(usesOf(readWorkflow(file)))).toEqual([]);
    expect(uncommentedPins(readText(workflowPath(file)))).toEqual([]);
  });

  it.each(COMPOSITE_ACTIONS)("%s composite pins every action with a ref comment", (name) => {
    const action = readAction(name);
    expect(action.runs.using).toBe("composite");
    expect(unpinnedUses(usesOf(action))).toEqual([]);
    expect(uncommentedPins(readText(actionPath(name)))).toEqual([]);
  });

  it.each(PIPELINE_WORKFLOWS)("%s sets timeout-minutes on every non-reusable job", (file) => {
    expect(jobsWithoutTimeout(readWorkflow(file))).toEqual([]);
  });

  it("ci.yml cancels superseded pull request runs only and is dispatchable", () => {
    const ci = readWorkflow("ci.yml");
    expect(Object.keys(ci.on)).toEqual(
      expect.arrayContaining(["pull_request", "push", "workflow_dispatch"]),
    );
    // Non-PR runs get a unique group: GitHub cancels a pending run in a shared group.
    expect(ci.concurrency?.group).toBe(
      "ci-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || format('run-{0}', github.run_id) }}",
    );
    expect(ci.concurrency?.["cancel-in-progress"]).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );
    for (const [id, job] of Object.entries(ci.jobs))
      expect(job.concurrency, `ci.yml job ${id}`).toBeUndefined();
  });

  it.each(RELEASE_WORKFLOWS)("%s can never be cancelled by a concurrency group", (file) => {
    const workflow = readWorkflow(file);
    expect(workflow.concurrency).toBeUndefined();
    for (const [id, job] of Object.entries(workflow.jobs))
      expect(job.concurrency, `${file} job ${id}`).toBeUndefined();
  });

  it.each(RELEASE_WORKFLOWS)("%s restores and saves no caches", (file) => {
    const uses = usesOf(readWorkflow(file));
    expect(uses.filter((ref) => ref.startsWith("actions/cache"))).toEqual([]);
    expect(uses.filter((ref) => ref.startsWith("./.github/actions/"))).toEqual([]);
  });

  it("ci.yml saves caches only from main pushes and never via the combined cache action", () => {
    const steps = allSteps(readWorkflow("ci.yml"));
    expect(steps.filter((step) => step.uses?.startsWith("actions/cache@"))).toEqual([]);
    expect(unguardedCacheSaves(steps)).toEqual([]);
  });
});

describe("setup-bigbud composite", () => {
  const action = readAction("setup-bigbud");
  const steps = action.runs.steps;
  const index = (predicate: (step: Step) => boolean) => steps.findIndex(predicate);

  it("saves caches only on opt-in main pushes after a primary-key miss", () => {
    expect(action.inputs["save-caches"]?.default).toBe("false");
    expect(steps.filter((step) => step.uses?.startsWith("actions/cache@"))).toEqual([]);
    const saves = steps.filter((step) => step.uses?.startsWith("actions/cache/save@"));
    expect(saves).toHaveLength(2);
    expect(unguardedCacheSaves(saves)).toEqual([]);
    for (const save of saves) {
      expect(save.if).toContain("inputs.save-caches == 'true'");
      expect(save.if).toMatch(/steps\.\w+\.outputs\.cache-hit != 'true'/);
    }
  });

  it("restores the Electron cache before install under an expression path", () => {
    const resolve = index((step) => step.id === "electron_version");
    const restore = index((step) => step.id === "electron_cache");
    const install = index((step) => step.name === "Install dependencies");
    expect(resolve).toBeGreaterThanOrEqual(0);
    expect(resolve).toBeLessThan(restore);
    expect(restore).toBeLessThan(install);
    expect(steps[resolve]!.run).toContain('"electron": \\["electron@');
    expect(steps[resolve]!.run).toContain("electron_config_cache=");
    expect(steps[resolve]!.run).toContain("ELECTRON_CACHE=");
    // actions/cache does not expand shell variables such as $RUNNER_TEMP.
    for (const step of steps.filter((entry) => entry.uses?.startsWith("actions/cache/")))
      expect(String(step.with?.path)).not.toContain("$RUNNER_TEMP");
    expect(steps[restore]!.with?.path).toBe("${{ runner.temp }}/electron-cache");
    const verify = index((step) => step.name === "Verify installed Electron version");
    expect(verify).toBeGreaterThan(install);
  });

  it("keeps both install modes", () => {
    const install = steps.find((step) => step.name === "Install dependencies")!;
    expect(action.inputs.install?.default).toBe("full");
    expect(install.run).toContain("full) node scripts/bun-install-with-retry.ts ;;");
    expect(install.run).toContain(
      "ignore-scripts) bun install --frozen-lockfile --ignore-scripts ;;",
    );
  });
});
