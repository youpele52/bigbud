import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

interface WorkflowStep {
  readonly uses?: string;
  readonly run?: string;
  readonly with?: {
    readonly name?: string;
    readonly pattern?: string;
    readonly path?: string;
    readonly "if-no-files-found"?: string;
    readonly "merge-multiple"?: boolean;
  };
}
interface WorkflowJob {
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly "runs-on"?: string;
  readonly steps: readonly WorkflowStep[];
}

describe("assembled release native helper coverage", () => {
  it.each([
    ["ci.yml", "release_asset_assembly"],
    ["release.yml", "release"],
  ])("%s builds and downloads the required Windows ARM64 helper", (workflowFile, consumerName) => {
    const workflow = parse(
      readFileSync(new URL(`../../../.github/workflows/${workflowFile}`, import.meta.url), "utf8"),
    ) as { jobs: Record<string, WorkflowJob> };
    const producerName = "workspace_agent_windows_arm64";
    const producer = workflow.jobs[producerName]!;
    const consumer = workflow.jobs[consumerName]!;
    expect(consumer.needs).toContain(producerName);
    expect(producer["runs-on"]).toBe("windows-11-arm");
    if (workflowFile === "ci.yml") expect(producer.if).toBe(consumer.if);
    const commands = producer.steps.map((step) => step.run ?? "").join("\n");
    expect(commands).toContain(
      "cargo test --locked --package bigbud-remote-agent --test inspect_local",
    );
    expect(commands).toContain("cargo build --locked --release --package bigbud-remote-agent");
    expect(commands).toContain(
      "Copy-Item target/release/bigbud-remote-agent.exe release-publish/server-workspace-agent-win32-arm64.exe",
    );
    expect(commands).toContain("'windows\\s+aarch64$'");
    const upload = producer.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    )!;
    expect(upload.with?.path).toBe("release-publish/*");
    expect(upload.with?.["if-no-files-found"]).toBe("error");
    const download = consumer.steps.find(
      (step) =>
        step.uses?.startsWith("actions/download-artifact@") &&
        upload.with!.name!.startsWith(step.with?.pattern?.replace(/\*$/, "") ?? "!"),
    );
    expect(download).toBeDefined();
    expect(download?.with?.["merge-multiple"]).toBe(true);
    expect(download?.with?.path).toBe("release-assets");
    expect(
      consumer.steps.some((step) =>
        step.run?.includes("scripts/verify-desktop-release-assets.ts release-assets"),
      ),
    ).toBe(true);
  });
});
