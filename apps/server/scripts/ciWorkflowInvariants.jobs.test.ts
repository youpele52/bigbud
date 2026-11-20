import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  readAction,
  readPackageScripts,
  readWorkflow,
  repoFile,
  type Job,
  type Step,
} from "./ciWorkflowInvariants.helpers.ts";

// Split CI jobs (plan section 7.1) and their timeouts.
const SPLIT_JOB_TIMEOUTS = {
  fmt_lint: 15,
  typecheck: 25,
  rust: 25,
  build_desktop_pipeline: 20,
  test_packages: 30,
  test_server_unit: 20,
  test_server_integration: 35,
  test_server_shard_coverage: 10,
} as const;
const SETUP_RUST_NATIVE = "./.github/actions/setup-rust-native";
const NATIVE_TEST_BINARIES = "cargo test --locked --workspace --no-run";
const REPORTS_DIR = "${{ runner.temp }}/server-test-reports";

const ci = readWorkflow("ci.yml");
const rootScripts = readPackageScripts("package.json");
const serverScripts = readPackageScripts("apps/server/package.json");

const job = (id: string): Job => {
  const found = ci.jobs[id];
  if (!found) throw new Error(`ci.yml has no job ${id}`);
  return found;
};
const steps = (id: string): readonly Step[] => job(id).steps ?? [];
const stepIndex = (id: string, predicate: (step: Step) => boolean) =>
  steps(id).findIndex(predicate);
const stepNamed = (id: string, name: string): Step => {
  const found = steps(id).find((step) => step.name === name);
  if (!found) throw new Error(`ci.yml job ${id} has no step '${name}'`);
  return found;
};
const usesRustNative = (step: Step) => step.uses === SETUP_RUST_NATIVE;
const shardMatrix = () => job("test_server_integration").strategy?.matrix?.shard;

const SERVER_TEST_JOBS = {
  test_server_unit: "Test server unit",
  test_server_integration: "Test server integration shard",
} as const;

describe("ci.yml split jobs", () => {
  it.each(Object.entries(SPLIT_JOB_TIMEOUTS))("%s exists with timeout %i", (id, timeout) => {
    expect(job(id)["timeout-minutes"]).toBe(timeout);
    expect(job(id)["runs-on"]).toBe("ubuntu-24.04");
  });

  it("starts every split job immediately except the shard coverage check", () => {
    for (const id of Object.keys(SPLIT_JOB_TIMEOUTS).filter((key) => !key.endsWith("coverage")))
      expect(job(id).needs, id).toBeUndefined();
    const coverage = job("test_server_shard_coverage");
    expect(coverage.needs).toEqual(["test_server_unit", "test_server_integration"]);
    // Runs after failed shards too (clearer message), but not when the run was cancelled.
    expect(coverage.if).toBe("${{ !cancelled() }}");
  });

  it("never lets a split job or one of its steps continue on error", () => {
    for (const id of Object.keys(SPLIT_JOB_TIMEOUTS)) {
      expect(job(id)["continue-on-error"], id).toBeUndefined();
      for (const step of steps(id)) expect(step["continue-on-error"], id).toBeUndefined();
    }
  });

  it("installs Rust and protoc where the server build or native binaries need them", () => {
    // The @bigbud/server build runs `cargo build --release` for two native helpers.
    for (const id of ["rust", "build_desktop_pipeline", "test_packages", "test_server_integration"])
      expect(steps(id).some(usesRustNative), id).toBe(true);
    expect(steps("rust").find(usesRustNative)?.with?.components).toBe("rustfmt, clippy");
    const build = stepIndex(
      "build_desktop_pipeline",
      (step) => step.run === "bun run build:desktop",
    );
    expect(build).toBeGreaterThan(stepIndex("build_desktop_pipeline", usesRustNative));
  });

  it("keeps every Rust check the monolith ran", () => {
    const commands = steps("rust").map((step) => step.run);
    expect(commands).toEqual(
      expect.arrayContaining([
        "cargo fmt --all --check",
        "cargo clippy --locked --workspace --all-targets -- -D warnings",
        "cargo test --locked --workspace",
        "cargo build --locked --workspace --release",
      ]),
    );
  });

  it.each([
    ["test_packages", "Test packages"],
    ["test_server_integration", "Test server integration shard"],
  ])("%s builds the monolith's native test binaries before its tests", (id, testStep) => {
    const prepare = stepIndex(id, (step) => step.run === NATIVE_TEST_BINARIES);
    expect(prepare).toBeGreaterThan(stepIndex(id, usesRustNative));
    expect(prepare).toBeLessThan(stepIndex(id, (step) => step.name === testStep));
  });

  it("runs every package's tests through Turbo, split between packages and server", () => {
    expect(rootScripts["test:packages"]).toBe("turbo run test --filter=!@bigbud/server");
    expect(rootScripts["test:server"]).toBe("turbo run test --filter=@bigbud/server --");
    expect(serverScripts["test:list-files"]).toBe("vitest list --filesOnly");
    expect(stepNamed("test_packages", "Test packages").run).toBe("bun run test:packages");
    for (const [id, name] of Object.entries(SERVER_TEST_JOBS))
      expect(stepNamed(id, name).run, id).toMatch(/^bun run test:server --project=/);
  });

  it("shards the integration project across the matrix with the coverage check's count", () => {
    const shards = shardMatrix();
    expect(Array.isArray(shards)).toBe(true);
    const count = (shards as unknown[]).length;
    expect(shards).toEqual(Array.from({ length: count }, (_, index) => index + 1));
    expect(job("test_server_integration").strategy?.["fail-fast"]).toBe(false);
    const run = stepNamed("test_server_integration", SERVER_TEST_JOBS.test_server_integration).run;
    expect(run).toContain("--project=integration");
    expect(run).toContain("--shard=${{ matrix.shard }}/${{ strategy.job-total }}");
    const verify = stepNamed(
      "test_server_shard_coverage",
      "Verify every server test file ran exactly once",
    );
    expect(verify.run).toContain(`--shard-count ${count} `);
    expect(stepNamed("test_server_unit", SERVER_TEST_JOBS.test_server_unit).run).toContain(
      "--project=unit",
    );
  });

  it("installs Playwright Chromium in every integration shard before the tests", () => {
    const install = stepIndex(
      "test_server_integration",
      (step) => step.run === "bun run --cwd apps/server test:browser:install",
    );
    expect(install).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(
      stepIndex("test_server_integration", (step) => step.name === "Test server integration shard"),
    );
  });

  it.each(Object.entries(SERVER_TEST_JOBS))(
    "%s writes its JSON report into a created directory and uploads it re-runnably",
    (id, testStep) => {
      const mkdir = stepIndex(
        id,
        (step) => step.run === 'mkdir -p "$RUNNER_TEMP/server-test-reports"',
      );
      expect(mkdir).toBeGreaterThanOrEqual(0);
      expect(mkdir).toBeLessThan(stepIndex(id, (step) => step.name === testStep));
      expect(stepNamed(id, testStep).run).toMatch(
        /--reporter=json --outputFile\.json="\$RUNNER_TEMP\/server-test-reports\/[\w${}. -]+\.json"$/,
      );
      const upload = stepNamed(id, "Upload test report");
      expect(upload.uses).toMatch(/^actions\/upload-artifact@/);
      expect(upload.if).toBe("always()");
      // upload-artifact@v4 rejects a second upload of the same name; re-runs must replace it.
      expect(upload.with).toMatchObject({ "retention-days": 7, overwrite: true });
      expect(String(upload.with?.name)).toMatch(/^server-test-report-/);
      expect(String(upload.with?.path)).toMatch(new RegExp(`^${escape(REPORTS_DIR)}/`));
    },
  );

  it("downloads every report into one flat directory and verifies coverage with the Bun script", () => {
    const download = stepNamed("test_server_shard_coverage", "Download server test reports");
    expect(download.uses).toMatch(/^actions\/download-artifact@/);
    expect(download.with).toEqual({
      pattern: "server-test-report-*",
      "merge-multiple": true,
      path: REPORTS_DIR,
    });
    const script = rootScripts["ci:verify-shard-coverage"];
    expect(script).toBe("node scripts/verify-test-shard-coverage.ts");
    expect(existsSync(repoFile(script!.split(" ")[1]!))).toBe(true);
    const verify = stepNamed(
      "test_server_shard_coverage",
      "Verify every server test file ran exactly once",
    );
    expect(verify.run).toMatch(/^bun run ci:verify-shard-coverage /);
    expect(verify.run).toContain('--shards-dir "$RUNNER_TEMP/server-test-reports"');
    expect(verify.run).toContain("--package-dir apps/server");
  });
});

describe("setup-rust-native composite", () => {
  const action = readAction("setup-rust-native");
  const actionSteps = action.runs.steps;

  it("installs the pinned toolchain with the requested components and protoc", () => {
    const toolchain = actionSteps.find((step) => step.uses?.startsWith("dtolnay/rust-toolchain@"));
    expect(toolchain?.with).toEqual({
      toolchain: "1.95.0",
      components: "${{ inputs.components }}",
    });
    expect(action.inputs.components?.default).toBe("");
    expect(actionSteps.map((step) => step.run ?? "").join("\n")).toContain(
      "sudo apt-get install --yes protobuf-compiler",
    );
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
