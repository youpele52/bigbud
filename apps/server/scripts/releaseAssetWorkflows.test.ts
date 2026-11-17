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

interface GraphWorkflow {
  readonly on: {
    readonly workflow_call: {
      readonly inputs: Record<string, { readonly type: string; readonly default?: unknown }>;
      readonly secrets: Record<string, { readonly required: boolean }>;
    };
    readonly workflow_dispatch: unknown;
    readonly pull_request: { readonly paths: readonly string[] };
  };
  readonly jobs: Record<
    string,
    WorkflowJob & {
      readonly strategy: { readonly matrix: { readonly include: readonly { target: string }[] } };
    }
  >;
}
interface ReleaseWorkflow {
  readonly jobs: Record<
    string,
    WorkflowJob & {
      readonly uses?: string;
      readonly with?: Record<string, unknown>;
      readonly secrets?: Record<string, string> | "inherit";
    }
  >;
}

const readWorkflow = (file: string) =>
  parse(readFileSync(new URL(`../../../.github/workflows/${file}`, import.meta.url), "utf8"));

describe("remote backend graph release workflow", () => {
  const graph = readWorkflow("release-remote-backend-graph.yml") as GraphWorkflow;
  const job = graph.jobs.remote_backend_graph_build!;
  const runs = job.steps.map((step) => step.run ?? "").join("\n");

  it("is reusable, dispatchable and PR-checked with release signing opt-in", () => {
    expect(Object.keys(graph.on.workflow_call.inputs).toSorted()).toEqual([
      "ref",
      "release_signing",
      "version",
    ]);
    expect(graph.on.workflow_call.inputs.release_signing).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(graph.on.workflow_call.secrets).toEqual({
      BIGBUD_REMOTE_AGENT_SIGNING_KEY: { required: false },
      BIGBUD_REMOTE_AGENT_SIGNING_KEY_ID: { required: false },
    });
    expect(graph.on).toHaveProperty("workflow_dispatch");
    expect(graph.on.pull_request.paths).toContain("scripts/build-remote-backend-graph*.ts");
    expect(graph.on.pull_request.paths).toContain("scripts/remote-backend-graph/**");
  });

  it("builds both GNU targets from both server bundles", () => {
    expect(job.strategy.matrix.include.map((entry) => entry.target)).toEqual([
      "x86_64-unknown-linux-gnu",
      "aarch64-unknown-linux-gnu",
    ]);
    const server = runs.indexOf("bunx tsdown\n");
    const relay = runs.indexOf("bunx tsdown -c tsdown.clientRelay.config.ts");
    const produce = runs.indexOf(
      'bun run remote-backend-graph --target "${{ matrix.target }}" --dist apps/server/dist',
    );
    expect(server).toBeGreaterThanOrEqual(0);
    expect(relay).toBeGreaterThan(server);
    expect(produce).toBeGreaterThan(relay);
    expect(runs).toContain('--output "$RUNNER_TEMP/remote-backend-graph/out"');
    expect(runs).toContain("/opt/graph/runtime/node /opt/graph/server/bin.mjs --help");
  });

  it("signs releases with the secret and other runs with an ephemeral fixture key", () => {
    const signing = job.steps.find((step) => step.run?.includes("openssl genpkey"))!;
    expect(signing.run).toContain('if [[ "$RELEASE_SIGNING" == true ]]; then');
    expect(signing.run).toContain("openssl genpkey -algorithm ed25519");
    expect(signing.run).toContain('key_dir="$RUNNER_TEMP/graph-signing"');
    const env = (signing as { env?: Record<string, string> }).env!;
    expect(env.RELEASE_SIGNING).toBe("${{ inputs.release_signing == true }}");
    for (const name of ["BIGBUD_REMOTE_AGENT_SIGNING_KEY", "BIGBUD_REMOTE_AGENT_SIGNING_KEY_ID"])
      expect(env[name]).toBe(`\${{ inputs.release_signing == true && secrets.${name} || '' }}`);
    expect(runs).toContain('rm -f "$RUNNER_TEMP/graph-signing/key.pem"');
  });

  it("uploads per-target archive, manifest and provenance", () => {
    for (const suffix of [".tar.gz", ".manifest.json", ".provenance.json"])
      expect(runs).toContain(`"release-publish/\${prefix}${suffix}"`);
    expect(runs).toContain('sha256sum "${prefix}.tar.gz" > "${prefix}.tar.gz.sha256"');
    expect(runs).toContain('prefix="bigbud-backend-graph-${GRAPH_VERSION}-${{ matrix.target }}"');
    const upload = job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"))!;
    expect(upload.with).toMatchObject({
      name: "remote-backend-graph-${{ matrix.target }}",
      path: "release-publish/*",
      "if-no-files-found": "error",
    });
  });

  it("is release-signed, downloaded, verified and published by release.yml", () => {
    const release = readWorkflow("release.yml") as ReleaseWorkflow;
    const caller = release.jobs.remote_backend_graph_build!;
    expect(caller.uses).toBe("./.github/workflows/release-remote-backend-graph.yml");
    expect(caller.with).toMatchObject({ release_signing: true });
    expect(caller.secrets).toEqual({
      BIGBUD_REMOTE_AGENT_SIGNING_KEY: "${{ secrets.BIGBUD_REMOTE_AGENT_SIGNING_KEY }}",
      BIGBUD_REMOTE_AGENT_SIGNING_KEY_ID: "${{ secrets.BIGBUD_REMOTE_AGENT_SIGNING_KEY_ID }}",
    });
    const publisher = release.jobs.release!;
    expect(publisher.needs).toContain("remote_backend_graph_build");
    const download = publisher.steps.find(
      (step) => step.with?.pattern === "remote-backend-graph-*",
    );
    expect(download?.with).toMatchObject({ "merge-multiple": true, path: "release-assets" });
    const verify = publisher.steps.map((step) => step.run ?? "").join("\n");
    expect(verify).toContain('sha256sum --check "${prefix}.tar.gz.sha256"');
    expect(verify).toContain("fixture-public-key.pem");
    const publish = publisher.steps.find((step) =>
      step.uses?.startsWith("softprops/action-gh-release@"),
    ) as { with: { files: string } };
    expect(publish.with.files).toContain("release-assets/bigbud-backend-graph-*");
  });
});
