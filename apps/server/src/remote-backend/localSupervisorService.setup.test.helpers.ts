import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  canonicalizeRemoteAgentArtifact,
  type RemoteAgentArtifact,
} from "@bigbud/shared/remoteAgentArtifact";
import { ServerConfig } from "../startup/config.ts";
import {
  runLocalSupervisorServicePreflight,
  type LocalSupervisorPreflightContext,
} from "./localSupervisorService.preflight.ts";
import { makeLocalSupervisorControl } from "./localSupervisorControl.ts";
import {
  localSupervisorServiceSetupDependencies,
  type LocalSupervisorServiceSetupDependencies,
} from "./localSupervisorService.setup.runtime.ts";
import { makeLocalSupervisorServiceSetup } from "./localSupervisorService.setup.ts";
import { verifyBackendGraph } from "./backendGraph.ts";
import {
  canonicalBackendGraphPayload,
  decodeBackendGraphManifest,
} from "./backendGraph.manifest.ts";
import type { RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
const sha = (body: Uint8Array | string) => createHash("sha256").update(body).digest("hex");
export async function setupFixture(graphInsideState = false) {
  const root = await fs.realpath(await fs.mkdtemp("/tmp/su-"));
  const home = join(root, "h"),
    backendHome = join(root, "b"),
    initialGraphRoot = join(root, "g");
  for (const path of [home, backendHome]) await fs.mkdir(path, { mode: 0o700 });
  const base = await Effect.runPromise(
    Effect.service(ServerConfig).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), backendHome).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );
  await fs.chmod(base.stateDir, 0o700);
  const graphRoot = graphInsideState ? join(base.stateDir, "runtime-graph") : initialGraphRoot;
  await fs.mkdir(graphRoot, { mode: 0o700 });
  const config = {
    ...base,
    mode: "remote" as const,
    authToken: "setup-fixture-token",
    host: "127.0.0.1",
    devUrl: undefined,
    noBrowser: true,
    autoBootstrapProjectFromCwd: false,
  };
  const keys = generateKeyPairSync("ed25519"),
    publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const content = [
    ["node", "fixture-node", true],
    ["bin.mjs", "import './chunk.mjs';", false],
    ["chunk.mjs", "export const v=1;", false],
  ] as const;
  for (const [path, body, exec] of content)
    await fs.writeFile(join(graphRoot, path), body, { mode: exec ? 0o700 : 0o600 });
  const draft = decodeBackendGraphManifest({
    revision: 1,
    version: "1-fixture",
    buildDigest: "a".repeat(64),
    target: "aarch64-unknown-linux-gnu",
    node: "node",
    entry: "bin.mjs",
    files: content.map(([path, body, executable]) => ({
      path,
      executable,
      sizeBytes: Buffer.byteLength(body),
      sha256: sha(body),
    })),
    signature: { algorithm: "ed25519", keyId: "fixture", value: "A".repeat(88) },
  });
  const manifest = decodeBackendGraphManifest({
    ...draft,
    signature: {
      ...draft.signature,
      value: sign(null, canonicalBackendGraphPayload(draft), keys.privateKey).toString("base64"),
    },
  });
  const graph = await verifyBackendGraph({
    root: graphRoot,
    manifest,
    target: manifest.target,
    trustStore: { fixture: publicKey },
  });
  const rustBytes = Buffer.from("signed-rust-fixture\n");
  const unsigned: RemoteAgentArtifact = {
    version: "1-fixture",
    buildDigest: "fixture-rust",
    protocolMajor: 1,
    protocolMinor: 0,
    targetTriple: "aarch64-unknown-linux-gnu",
    sizeBytes: rustBytes.length,
    sha256: sha(rustBytes),
    url: "https://example.invalid/fixture",
    signature: { algorithm: "ed25519", keyId: "fixture", value: "A".repeat(88) },
  };
  const artifact = {
    ...unsigned,
    signature: {
      ...unsigned.signature,
      value: sign(
        null,
        Buffer.from(canonicalizeRemoteAgentArtifact(unsigned)),
        keys.privateKey,
      ).toString("base64"),
    },
  };
  const input = {
    graph,
    rustSource: {
      manifest: { schemaVersion: 1 as const, artifacts: [artifact] },
      trustStore: { fixture: publicKey },
    },
    backendHome,
    requestId: randomUUID(),
    confirmFreshSetup: true as const,
    restart: true,
  };
  const events: string[] = [],
    commands: string[] = [];
  /** Adoption probes: installed `--check` identity and the existing supervisor observation. */
  const probes = {
    identity: `bigbud-remote-agent ${artifact.version} 1 0 ${artifact.buildDigest} linux aarch64`,
    observation: "ready",
  };
  const makeRuntime = async (
    control: ReturnType<typeof makeLocalSupervisorControl>,
  ): Promise<RemoteAgentRuntime> => {
    const statePath = join(control.root, "runtimes/g1"),
      binaryPath = join(
        control.root,
        "bin",
        artifact.version,
        artifact.sha256,
        "bigbud-remote-agent",
      );
    for (const path of [
      join(control.root, "bin"),
      join(control.root, "bin", artifact.version),
      join(control.root, "bin", artifact.version, artifact.sha256),
      join(control.root, "runtimes"),
      statePath,
    ])
      await fs.mkdir(path, { mode: 0o700 });
    await fs.writeFile(binaryPath, rustBytes, { mode: 0o700 });
    return {
      generation: "g1",
      version: artifact.version,
      sha256: artifact.sha256,
      buildDigest: artifact.buildDigest,
      targetTriple: artifact.targetTriple,
      binaryPath,
      statePath,
      socketPath: join(statePath, "supervisor.sock"),
      logPath: join(statePath, "supervisor.log"),
      origin: "managed",
    };
  };
  const dependencies: LocalSupervisorServiceSetupDependencies = {
    ...localSupervisorServiceSetupDependencies,
    account: () => ({
      home,
      operatingSystem: "linux",
      architecture: "arm64",
      uid: process.getuid!(),
    }),
    control: (selectedHome, target) =>
      makeLocalSupervisorControl({
        homeDir: selectedHome,
        targetId: target,
        execute: async (_command, args) => {
          const script = args[1]!;
          commands.push(script);
          return {
            code: 0,
            signal: null,
            timedOut: false,
            stderr: "",
            stdout: script.endsWith("\nobserve_supervisor")
              ? probes.observation
              : script.includes("cat /proc/")
                ? "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
                : script.includes("--check --capabilities")
                  ? "backend-service=2 backend-service-graph=1"
                  : script.includes("--backend-service status")
                    ? "fixture observation"
                    : script.includes(" --check; else")
                      ? probes.identity
                      : "",
          };
        },
      }),
    claim: async (...args) => {
      events.push("claim");
      return localSupervisorServiceSetupDependencies.claim(...args);
    },
    install: async (control) => {
      events.push("install");
      return makeRuntime(control);
    },
    admit: async (context, control, runtime, _path, id) => {
      events.push("admit");
      await context.owners.bindConnection(control.targetId, `setup-admit-${id}`, {
        runtime,
        expectedEpoch: "123456",
      });
      return "123456";
    },
  };
  function withContext<A>(
    operation: (context: LocalSupervisorPreflightContext, signal: AbortSignal) => Promise<A>,
  ) {
    return Effect.runPromise(runLocalSupervisorServicePreflight({ config, operation }));
  }
  return {
    root,
    home,
    backendHome,
    graphRoot,
    input,
    events,
    commands,
    probes,
    artifact,
    rustBytes,
    dependencies,
    makeRuntime,
    withContext,
    setup: makeLocalSupervisorServiceSetup(dependencies),
  };
}
export type SetupFixture = Awaited<ReturnType<typeof setupFixture>>;
