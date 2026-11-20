import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  readPackageScripts,
  readWorkflow,
  repoFile,
  type Job,
  type Step,
} from "./ciWorkflowInvariants.helpers.ts";

interface MatrixEntry {
  readonly label: string;
  readonly runner: string;
  readonly platform: string;
  readonly arch: string;
}

const MAIN_PUSH_SAVE = "${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}";
const RUST_CACHE_PIN = "Swatinem/rust-cache@d1527c8f67ef9af357290475d4af4b0fab8f12e0";
const MAC_X64_IF = "matrix.platform == 'mac' && matrix.arch == 'x64'";
const AUDIT_RUN = 'bun run verify:desktop:mac-architecture -- release "${{ matrix.arch }}"';

const ci = readWorkflow("ci.yml");
const DESKTOP_BUILDS = [
  ["ci.yml", ci.jobs.desktop_release_build],
  ["release-desktop-build.yml", readWorkflow("release-desktop-build.yml").jobs.build],
] as const;

const matrixOf = (job: Job | undefined) =>
  (job?.strategy?.matrix?.include ?? []) as readonly MatrixEntry[];
const indexOf = (steps: readonly Step[], predicate: (step: Step) => boolean) =>
  steps.findIndex(predicate);
const named = (name: string) => (step: Step) => step.name === name;
const isRustCache = (step: Step) => step.uses?.startsWith("Swatinem/rust-cache@") ?? false;

describe.each(DESKTOP_BUILDS)("%s macOS x64 cross build", (_file, job) => {
  const steps = job?.steps ?? [];
  const build = indexOf(steps, named("Build desktop artifact"));

  it("builds macOS x64 on the Apple Silicon runner next to arm64", () => {
    const mac = matrixOf(job).filter((entry) => entry.platform === "mac");
    expect(mac.map((entry) => [entry.arch, entry.runner])).toEqual([
      ["arm64", "macos-15"],
      ["x64", "macos-15"],
    ]);
  });

  it("adds and verifies the x86_64-apple-darwin Rust target before the build", () => {
    const index = indexOf(steps, named("Add Rust macOS x64 target"));
    const step = steps[index]!;
    expect(step.if).toBe(MAC_X64_IF);
    expect(step.run).toContain("rust-toolchain.toml");
    expect(step.run).toContain("--target x86_64-apple-darwin");
    expect(step.run).toContain("grep -qx x86_64-apple-darwin");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(build);
  });

  it("installs Rosetta 2 when missing and fails loudly before any x64 binary runs", () => {
    const index = indexOf(steps, named("Ensure Rosetta 2 for x64 smoke tests"));
    const step = steps[index]!;
    expect(step.if).toBe(MAC_X64_IF);
    expect(step.run).toContain("sudo softwareupdate --install-rosetta --agree-to-license");
    // Checked again after the install: an unavailable Rosetta fails the job instead of skipping.
    expect(step.run!.split("arch -x86_64 /usr/bin/true").length - 1).toBe(2);
    expect(step.run).toContain("exit 1");
    expect(step["continue-on-error"]).toBeUndefined();
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(build);
  });

  it("audits every packaged macOS app's architectures before the smoke tests", () => {
    const index = indexOf(steps, named("Audit packaged macOS app architectures"));
    const step = steps[index]!;
    expect(step.if).toBe("matrix.platform == 'mac'");
    expect(step.run).toBe(AUDIT_RUN);
    expect(step["continue-on-error"]).toBeUndefined();
    expect(index).toBeGreaterThan(build);
    expect(index).toBeLessThan(indexOf(steps, named("Smoke test packaged workspace watcher")));
  });
});

describe("macOS architecture audit command", () => {
  it("is a Bun script that runs an existing file", () => {
    const script = readPackageScripts("package.json")["verify:desktop:mac-architecture"];
    expect(script).toBe("node scripts/verify-macos-app-architecture.ts");
    expect(existsSync(repoFile(script!.split(" ")[1]!))).toBe(true);
  });
});

describe("native Intel jobs", () => {
  it.each(["ci.yml", "release.yml"])("%s keeps the macOS x64 cleanup tests on Intel", (file) => {
    const entry = matrixOf(readWorkflow(file).jobs.native_resource_cleanup).find(
      (item) => item.label === "macOS x64",
    );
    expect(entry?.runner).toBe("macos-15-intel");
  });
});

describe("ci.yml Rust build cache", () => {
  const RUST_JOBS = [
    "rust",
    "build_desktop_pipeline",
    "test_packages",
    "test_server_integration",
    "desktop_release_build",
  ] as const;
  const rustCaches = Object.entries(ci.jobs).flatMap(([id, job]) =>
    (job.steps ?? []).filter(isRustCache).map((step) => [id, step] as const),
  );

  it("restores the pinned cache in every Rust-building job before cargo runs", () => {
    expect([...new Set(rustCaches.map(([id]) => id))].toSorted()).toEqual(
      [...RUST_JOBS].toSorted(),
    );
    for (const id of RUST_JOBS) {
      const steps = ci.jobs[id]!.steps ?? [];
      const cache = indexOf(steps, isRustCache);
      expect(steps[cache]!.uses, id).toBe(RUST_CACHE_PIN);
      const firstCargo = indexOf(
        steps,
        (step) =>
          /\bcargo\b/.test(step.run ?? "") ||
          step.run === "bun run build:desktop" ||
          step.name === "Build desktop artifact",
      );
      expect(cache, id).toBeLessThan(firstCargo);
    }
  });

  it("saves only from main pushes, with the integration shards restore-only", () => {
    for (const [id, step] of rustCaches) {
      const saveIf = step.with?.["save-if"];
      if (id === "test_server_integration") expect(saveIf, id).toBe(false);
      else expect(saveIf, id).toBe(MAIN_PUSH_SAVE);
    }
  });

  it("restores the macOS x64 cache after its Rust target and keys it per target", () => {
    const steps = ci.jobs.desktop_release_build!.steps ?? [];
    expect(indexOf(steps, isRustCache)).toBeGreaterThan(
      indexOf(steps, named("Add Rust macOS x64 target")),
    );
    expect(steps.find(isRustCache)?.with?.key).toBe("${{ matrix.platform }}-${{ matrix.arch }}");
  });

  it("keys the desktop Electron cache by the target architecture", () => {
    const setup = (ci.jobs.desktop_release_build!.steps ?? []).find((step) => step.id === "setup");
    expect(setup?.with?.["electron-arch"]).toBe(
      "${{ matrix.arch == 'arm64' && 'ARM64' || 'X64' }}",
    );
  });
});
