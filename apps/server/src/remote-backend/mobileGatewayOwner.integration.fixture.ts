/** Real Linux lock/identity/CAS/private HTTP socket; P4 peer is explicitly synthetic wire data. */
import * as fs from "node:fs/promises";
import * as http from "node:http";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { BackendInstance, makeBackendInstance } from "../startup/backendInstance.ts";
import { acquireStateDirLock, defaultStateDirLockProbe } from "../startup/stateDirLock.ts";
import { ServerConfig } from "../startup/config.ts";
import { loadRemoteBackendIdentity } from "./authority.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import { makeLocalSupervisorControl } from "./localSupervisorControl.ts";
import { runLocalSupervisorCommand } from "./localSupervisorControl.runner.ts";
import { claimLocalSupervisorAuthorityReservation } from "./localSupervisorAuthority.ts";
import { makeTestSettings } from "../ws/serverSettings.testing.ts";
import { ServerSettingsService } from "../ws/serverSettings.ts";
import { RemoteAgentRuntimeOwners } from "../persistence/Layers/RemoteAgentRuntimeBindings.service.ts";
import type { RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import { remoteAgentBuildId } from "../remote-agent/remoteAgentRuntime.ts";
import { emptyRemoteAgentRegistry } from "../remote-agent/remoteAgentInstall.registry.ts";
import { makeRemoteAgentRegistryStore } from "../remote-agent/remoteAgentInstall.registry.store.ts";
import { setRemoteAgentMobileConsent } from "../remote-agent/remoteAgentInstall.mobile.transitions.ts";
import { remoteMobileDescriptor } from "./mobileDescriptor.ts";
import {
  matchesMobileGatewayCredential,
  MOBILE_GATEWAY_CREDENTIAL_HEADER,
} from "../mobile/mobileGatewayCredential.ts";
import { version } from "../../package.json" with { type: "json" };
import type { ownerIntegrationArtifacts } from "./mobileGatewayOwner.integration.artifacts.ts";

export async function createOwnerIntegrationFixture(
  artifacts: Awaited<ReturnType<typeof ownerIntegrationArtifacts>>,
  options: { readonly privateTransport?: boolean } = {},
) {
  const peerPath = process.env.BIGBUD_OWNER_TEST_P4_PEER;
  if (!peerPath || process.platform !== "linux")
    throw new Error("Explicit Linux P4 wire fixture required.");
  const previousHome = process.env.HOME;
  const home = await fs.realpath(await fs.mkdtemp("/tmp/bb-owner-"));
  process.env.HOME = home;
  const backendHome = join(home, "backend"),
    stateDir = join(backendHome, "state");
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lock = await acquireStateDirLock({
    stateDir,
    port: 49321,
    probe: defaultStateDirLockProbe,
  });
  const owner = makeBackendInstance(lock, stateDir, defaultStateDirLockProbe);
  const identity = await loadRemoteBackendIdentity(owner);
  const control = makeLocalSupervisorControl({
    homeDir: home,
    targetId: `remote-backend:${identity.authority.authorityId}`,
  });
  await claimLocalSupervisorAuthorityReservation(control, identity, {
    confirmFreshSetup: true,
    backendHome,
    backendStateDir: stateDir,
  });
  const peer = await fs.readFile(peerPath);
  const sha256 = createHash("sha256").update(peer).digest("hex");
  const binaryDir = join(control.root, "bin", "0.2.207", sha256),
    statePath = join(control.root, "runtimes", "owner-wire-fixture");
  await fs.mkdir(binaryDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(statePath, { recursive: true, mode: 0o700 });
  const runtime = {
    version: "0.2.207",
    sha256,
    buildDigest: "fixture",
    targetTriple: artifacts.target,
    generation: "owner-wire-fixture",
    origin: "managed" as const,
    binaryPath: join(binaryDir, "bigbud-remote-agent"),
    statePath,
    socketPath: join(statePath, "supervisor.sock"),
    logPath: join(statePath, "supervisor.log"),
  };
  await fs.writeFile(runtime.binaryPath, peer, { mode: 0o700 });
  const hello = {
    protocolMajor: 1,
    protocolMinor: 7,
    agentVersion: runtime.version,
    buildDigest: runtime.buildDigest,
    os: "linux",
    architecture: process.arch === "arm64" ? "aarch64" : "x86_64",
    agentInstanceId: runtime.generation,
    agentEpoch: "owner-fixture-epoch",
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
    maxFrameBytes: 1048576,
    maxOperationOutputBytes: 1024,
    maxJournalBytes: 1024,
  };
  await fs.writeFile(join(statePath, "gateway-agent-fixture.json"), JSON.stringify(hello), {
    mode: 0o600,
  });
  const buildId = remoteAgentBuildId(runtime);
  const pin = {
    authority: identity.authority,
    installationFingerprint: identity.installationFingerprint,
  };
  const seeded = setRemoteAgentMobileConsent(
    {
      ...emptyRemoteAgentRegistry(),
      current: buildId,
      promotionSequence: 1,
      builds: [
        {
          id: buildId,
          runtime,
          health: "healthy",
          promotion: 1,
          authenticated: true,
          binary: "present",
        },
      ],
      launches: [{ id: runtime.generation, buildId, phase: "ready", epoch: hello.agentEpoch }],
    },
    { owner: pin, expectedConsentRevision: 0 },
    true,
  );
  await fs.mkdir(join(control.root, "control-v1"), { mode: 0o700 });
  await fs.writeFile(join(control.root, "control-v1", "registry.json"), JSON.stringify(seeded), {
    mode: 0o600,
    flag: "wx",
  });
  const store = makeRemoteAgentRegistryStore(control.root, {
    run: async (script) =>
      (
        await runLocalSupervisorCommand("/bin/sh", ["-c", script], {
          timeoutMs: 15000,
          maxBufferBytes: 2097152,
        })
      ).stdout,
  });
  const settings = await Effect.runPromise(
    makeTestSettings({ mobileRemoteControl: { enabled: false } }),
  );
  const base = await Effect.runPromise(
    Effect.service(ServerConfig).pipe(
      Effect.provide(
        ServerConfig.layerTest(home, join(home, "config")).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  );
  const privateTransport = options.privateTransport !== false;
  const credential = randomBytes(32).toString("hex");
  const config = {
    ...base,
    mode: "remote" as const,
    stateDir,
    ...(privateTransport ? { remoteMobile: { gatewayCredential: Redacted.make(credential) } } : {}),
  };
  let requests = 0;
  const server = http.createServer((request, response) => {
    if (
      !matchesMobileGatewayCredential(
        credential,
        request.headers[MOBILE_GATEWAY_CREDENTIAL_HEADER]?.toString(),
      )
    ) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== "GET" || request.url !== "/api/mobile/handshake") {
      response.writeHead(404).end();
      return;
    }
    requests++;
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(remoteMobileDescriptor(identity, version, false)));
  });
  const socket = join(stateDir, "remote-mobile.sock");
  if (privateTransport) {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    await fs.chmod(socket, 0o600);
  }
  let heldBinding: { entered: () => void; wait: Promise<void> } | undefined;
  let bindingWaiters = 0;
  const owners: RemoteAgentOwnerStore = {
    getBinding: async () => {
      const held = heldBinding;
      if (held) {
        bindingWaiters++;
        held.entered();
        try {
          await held.wait;
        } finally {
          bindingWaiters--;
        }
      }
      return { runtime, expectedEpoch: hello.agentEpoch, connectionId: runtime.generation };
    },
    get: async () => undefined,
    reserve: async (input) => input,
    bindConnection: async () => {},
    update: async () => {
      throw new Error("Fixture does not mutate command owners.");
    },
    referencedBuildIds: async () => new Set(),
  };
  const runtimeLayer = Layer.mergeAll(
    Layer.succeed(BackendInstance, owner),
    Layer.succeed(RemoteBackendIdentityService, identity),
    Layer.succeed(ServerConfig, config),
    Layer.succeed(ServerSettingsService, settings),
    Layer.succeed(RemoteAgentRuntimeOwners, owners),
  );
  return {
    home,
    owner,
    identity,
    settings,
    runtimeLayer,
    store,
    requests: () => requests,
    holdBindingReads: () => {
      let entered!: () => void, release!: () => void;
      const began = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      heldBinding = { entered, wait };
      return {
        began,
        waiting: () => bindingWaiters,
        release: () => {
          heldBinding = undefined;
          release();
        },
      };
    },
    consent: async (enabled: boolean) =>
      store.update((state) => {
        if (state.schemaVersion !== 3) throw new Error("Expected fixture v3 journal.");
        return setRemoteAgentMobileConsent(
          state,
          { owner: pin, expectedConsentRevision: state.mobile.consent.revision },
          enabled,
        );
      }),
    close: async () => {
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      await lock.release();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(home, { recursive: true, force: true });
    },
  };
}
