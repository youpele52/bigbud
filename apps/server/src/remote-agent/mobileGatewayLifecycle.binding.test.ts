import { publicationFixture } from "./mobileOptionalPublication.test-fixtures.ts";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeAll, expect, it } from "vitest";
import { currentMobileGatewayBinding } from "./mobileGatewayLifecycle.binding.ts";
import { withMobilePublicationOwner } from "./mobileGatewayLifecycle.publication.ts";
import { remoteAgentBuildId } from "./remoteAgentRuntime.ts";
import type { RemoteAgentRuntimeBinding } from "./remoteAgentConnectionPool.ts";
import type { RemoteAgentHello } from "./remoteAgentProtocol.ts";

const fixtures: Awaited<ReturnType<typeof publicationFixture>>[] = [];
let buildRoot: string, binary: Buffer;
beforeAll(async () => {
  buildRoot = await fs.mkdtemp("/tmp/bb-gateway-wire-");
  const output = join(buildRoot, "agent-fixture.mjs");
  execFileSync(
    "bun",
    [
      "build",
      join(import.meta.dirname, "mobileGatewayLifecycle.binding.fixture.ts"),
      "--target=node",
      `--outfile=${output}`,
    ],
    { stdio: "pipe" },
  );
  binary = Buffer.from(
    (await fs.readFile(output, "utf8")).replace(/^#![^\n]*/, `#!${process.execPath}`),
  );
});
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
import { afterAll } from "vitest";
afterAll(async () => {
  if (buildRoot) await fs.rm(buildRoot, { recursive: true });
});
async function fixture(epoch = "fixture-epoch") {
  const f = await publicationFixture();
  fixtures.push(f);
  const state = f.read(),
    original = state.builds.find((b) => b.id === state.current)!;
  const hash = createHash("sha256").update(binary).digest("hex");
  const directory = join(f.control.root, "bin", original.runtime.version, hash);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const runtime = {
    ...original.runtime,
    sha256: hash,
    binaryPath: join(directory, "bigbud-remote-agent"),
  };
  await fs.writeFile(runtime.binaryPath, binary, { mode: 0o700 });
  const id = remoteAgentBuildId(runtime);
  f.replaceState({
    ...state,
    current: id,
    builds: [{ ...original, id, runtime }],
    launches: state.launches.map((l) => Object.assign({}, l, { buildId: id })),
  });
  const hello: RemoteAgentHello = {
    protocolMajor: 1,
    protocolMinor: 7,
    agentVersion: runtime.version,
    buildDigest: runtime.buildDigest,
    os: "linux",
    architecture: runtime.targetTriple.startsWith("aarch64") ? "aarch64" : "x86_64",
    agentInstanceId: runtime.generation,
    agentEpoch: epoch,
    capabilities: [
      "diagnostic",
      "workspace.files",
      "workspace.search",
      "workspace.write",
      "workspace.watch",
      "process.run",
      "process.attach",
      "terminal.pty",
    ].map((name) => ({ name, major: 1, minor: 0 })),
    maxFrameBytes: 1024 * 1024,
    maxOperationOutputBytes: 1024,
    maxJournalBytes: 1024,
  };
  await fs.writeFile(join(runtime.statePath, "gateway-agent-fixture.json"), JSON.stringify(hello), {
    mode: 0o600,
  });
  const binding: RemoteAgentRuntimeBinding = {
    runtime,
    connectionId: runtime.generation,
    expectedEpoch: "fixture-epoch",
  };
  return { f, binding, runtime };
}
it("uses an actual bounded P4 hello/readiness wire probe for the canonical owner binding", async () => {
  const { f, binding, runtime } = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request);
    const result = await withMobilePublicationOwner(proof, ({ authority }, signal) =>
      currentMobileGatewayBinding(authority, { getBinding: async () => binding }, signal),
    );
    expect(result.epoch).toBe("fixture-epoch");
    const requests = (
      await fs.readFile(join(runtime.statePath, "gateway-agent-requests.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(requests).toEqual([
      { type: "clientHello", kind: null },
      { type: "diagnosticRequest", kind: "readiness" },
    ]);
  });
});
it("rejects a fresh live epoch mismatch despite unchanged persisted ready metadata", async () => {
  const { f, binding } = await fixture("changed-live-epoch");
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request);
    await expect(
      withMobilePublicationOwner(proof, ({ authority }, signal) =>
        currentMobileGatewayBinding(authority, { getBinding: async () => binding }, signal),
      ),
    ).rejects.toThrow(/continuity/);
  });
});
it("rejects canonical owner binding replacement after a successful diagnostic", async () => {
  const { f, binding } = await fixture();
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request);
    let calls = 0;
    await expect(
      withMobilePublicationOwner(proof, ({ authority }, signal) =>
        currentMobileGatewayBinding(
          authority,
          {
            getBinding: async () =>
              ++calls === 1 ? binding : { ...binding, connectionId: "replacement" },
          },
          signal,
        ),
      ),
    ).rejects.toThrow(/binding changed/);
  });
});
it("cancels and settles the owned proxy promptly while a hello is stalled", async () => {
  const { f, binding, runtime } = await fixture("stall");
  await f.run(async (publisher) => {
    const proof = await publisher.publish(f.request),
      controller = new AbortController();
    const operation = withMobilePublicationOwner(
      proof,
      ({ authority }, signal) =>
        currentMobileGatewayBinding(authority, { getBinding: async () => binding }, signal),
      controller.signal,
    );
    const log = join(runtime.statePath, "gateway-agent-requests.jsonl");
    let observed = false;
    for (let tries = 0; tries < 100; tries++) {
      try {
        if ((await fs.readFile(log, "utf8")).includes("clientHello")) {
          observed = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(observed).toBe(true);
    controller.abort(new Error("fixture cancel stalled hello"));
    await expect(operation).rejects.toThrow();
  });
});
