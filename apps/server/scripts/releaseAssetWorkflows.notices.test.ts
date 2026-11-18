import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface Step {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, unknown>;
}
interface Workflow {
  readonly jobs: Record<string, { readonly steps: readonly Step[] }>;
}
const readWorkflow = (file: string) =>
  parse(
    readFileSync(new URL(`../../../.github/workflows/${file}`, import.meta.url), "utf8"),
  ) as Workflow;

describe("remote agent third-party notices", () => {
  const steps = readWorkflow("release-remote-agent-build.yml").jobs.remote_agent_build!.steps;
  const index = (predicate: (step: Step) => boolean) => steps.findIndex(predicate);

  it("generates per-target notices and inventory beside the binary before upload", () => {
    const bun = index((step) => step.uses?.startsWith("oven-sh/setup-bun@") ?? false);
    const prepare = index((step) => step.name === "Prepare remote agent release asset");
    const notices = index((step) => step.run?.includes("bun run licenses:rust") ?? false);
    const upload = index((step) => step.with?.name === "remote-agent-${{ matrix.target }}");
    expect(bun).toBeGreaterThanOrEqual(0);
    expect(bun).toBeLessThan(notices);
    expect(prepare).toBeLessThan(notices);
    expect(notices).toBeLessThan(upload);
    const run = steps[notices]!.run!;
    expect(run).toContain(
      'asset_name="bigbud-remote-agent-${{ inputs.version }}-${{ matrix.target }}"',
    );
    expect(run).toContain('--target "${{ matrix.target }}"');
    expect(run).toContain('--output "release-publish/${asset_name}.licenses.json"');
    expect(run).toContain('--notices-output "release-publish/${asset_name}.THIRD_PARTY_NOTICES"');
    expect(steps[upload]!.with?.path).toBe("release-publish/*");
  });

  it("is checked for every published target and published with the agent assets", () => {
    const release = readWorkflow("release.yml").jobs.release!.steps;
    const verify = release.find((step) => step.name === "Verify packaged remote agent assets")!;
    for (const target of [
      "x86_64-unknown-linux-musl",
      "aarch64-unknown-linux-musl",
      "x86_64-unknown-linux-gnu",
      "aarch64-unknown-linux-gnu",
    ])
      expect(verify.run).toContain(target);
    expect(verify.run).toContain("for suffix in .THIRD_PARTY_NOTICES .licenses.json; do");
    expect(verify.run).toContain(
      'test -s "release-assets/bigbud-remote-agent-${version}-${target}${suffix}"',
    );
    const publish = release.find((step) => step.uses?.startsWith("softprops/action-gh-release@"))!;
    expect(publish.with?.files).toContain("release-assets/bigbud-remote-agent-*");
  });
});
