import { createHash, generateKeyPairSync, sign } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Effect, Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { vi } from "vitest";
import type { MobileOptionalArtifact } from "@bigbud/contracts/server/mobileOptionalArtifact";
import { canonicalizeMobileOptionalArtifact } from "@bigbud/shared/mobileOptionalArtifact";
import { version } from "../../package.json" with { type: "json" };
import { BackendInstance, makeBackendInstance } from "../startup/backendInstance.ts";
import { PROCESS_START_TOKEN_PREFIX } from "../utils/processStartToken.ts";
import { acquireStateDirLock, type StateDirLockProbe } from "../startup/stateDirLock.ts";
import { ServerConfig } from "../startup/config.ts";
import { RemoteBackendIdentityService } from "../remote-backend/identity.service.ts";
import { loadRemoteBackendIdentity } from "../remote-backend/authority.ts";
import { makeLocalSupervisorControl } from "../remote-backend/localSupervisorControl.ts";
import { claimLocalSupervisorAuthorityReservation } from "../remote-backend/localSupervisorAuthority.ts";
import { makeTestSettings } from "../ws/serverSettings.testing.ts";
import { ServerSettingsService, type ServerSettingsShape } from "../ws/serverSettings.ts";
import {
  emptyRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "./remoteAgentInstall.registry.ts";
import { setRemoteAgentMobileConsent } from "./remoteAgentInstall.mobile.transitions.ts";
import { memoryRegistryCommand } from "./remoteAgentInstall.mobile.fixtures.ts";
import { remoteAgentBuildId } from "./remoteAgentRuntime.ts";
import { tarBytes, tarMember } from "./mobileOptionalAssets.test-fixture.ts";
import {
  withMobileOptionalPublisher,
  type MobileOptionalPublisher,
} from "./mobileOptionalPublication.ts";

const wiring = vi.hoisted(() => ({
  run: async (_script: string): Promise<string> => "missing",
  before: undefined as undefined | ((script: string) => Promise<void>),
}));
export const publicationWiring = wiring;
vi.mock("../remote-backend/localSupervisorControl.runner.ts", () => ({
  runLocalSupervisorCommand: async (_command: string, args: readonly string[]) => {
    const script = args[1]!;
    await wiring.before?.(script);
    return {
      stdout: await wiring.run(script),
      stderr: "",
      code: 0,
      signal: null,
      timedOut: false,
    };
  },
}));

export async function publicationFixture(
  options: {
    readonly processStarts?: ReadonlyMap<number, string | undefined>;
    readonly ownerStartedAt?: string;
  } = {},
) {
  const home = await fs.realpath(await fs.mkdtemp("/tmp/bb-mpub-"));
  vi.stubEnv("HOME", home);
  const oldPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  const backendHome = join(home, "backend");
  const stateDir = join(backendHome, "state");
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const probe: StateDirLockProbe = {
    pid: process.pid,
    hostname: () => "publication-fixture",
    machineId: () => "machine-v1:publication-fixture",
    isAlive: (pid) => pid === process.pid || options.processStarts?.has(pid) === true,
    startToken: (pid) =>
      pid === process.pid
        ? (options.ownerStartedAt ?? `${PROCESS_START_TOKEN_PREFIX}test:publication-fixture-start`)
        : options.processStarts?.get(pid),
  };
  let handle = await acquireStateDirLock({ stateDir, port: 49321, probe });
  let owner = makeBackendInstance(handle, stateDir, probe);
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
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const targetTriple = `${arch}-unknown-linux-musl` as const;
  const baseBytes = Buffer.from("test-only installed base artifact");
  const baseHash = createHash("sha256").update(baseBytes).digest("hex");
  const binaryDir = join(control.root, "bin", "0.2.207", baseHash);
  const runtimeDir = join(control.root, "runtimes", "fixture");
  await fs.mkdir(binaryDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const runtime = {
    version: "0.2.207",
    sha256: baseHash,
    buildDigest: "fixture",
    targetTriple,
    generation: "fixture",
    origin: "managed" as const,
    binaryPath: join(binaryDir, "bigbud-remote-agent"),
    statePath: runtimeDir,
    socketPath: join(runtimeDir, "supervisor.sock"),
    logPath: join(runtimeDir, "supervisor.log"),
  };
  await fs.writeFile(runtime.binaryPath, baseBytes, { mode: 0o700 });
  const buildId = remoteAgentBuildId(runtime);
  const settings = await Effect.runPromise(
    makeTestSettings({ mobileRemoteControl: { enabled: true } }),
  );
  const config = await Effect.runPromise(
    Effect.service(ServerConfig).pipe(
      Effect.provide(
        ServerConfig.layerTest(home, join(home, "config-fixture")).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
  const releaseKeys = generateKeyPairSync("ed25519");
  const gatewayBytes = Buffer.alloc(64);
  gatewayBytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  gatewayBytes.writeUInt16LE(2, 16);
  gatewayBytes.writeUInt16LE(arch === "aarch64" ? 183 : 62, 18);
  const assetsBytes = gzipSync(
    tarBytes([tarMember("index.html", "0", "<html>signed publication fixture</html>")]),
  );
  const artifact = (
    kind: "mobile-gateway" | "mobile-assets",
    bytes: Buffer,
  ): MobileOptionalArtifact => {
    const metadata: MobileOptionalArtifact = {
      schemaVersion: 1,
      ...(kind === "mobile-gateway"
        ? { kind, targetTriple, format: "executable" }
        : { kind, targetTriple: "portable", format: "tar.gz" }),
      compatibility: {
        agentVersion: runtime.version,
        backendVersion: version,
        gatewayVersion: "1",
        mobileAssetVersion: "1",
        minimumMobileRpcRevision: 1,
        maximumMobileRpcRevision: 1,
      },
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      url: `https://github.com/example/releases/download/fixture/${kind}`,
      signature: { algorithm: "ed25519", keyId: "fixture", value: "" },
    };
    return {
      ...metadata,
      signature: {
        ...metadata.signature,
        value: sign(
          null,
          Buffer.from(canonicalizeMobileOptionalArtifact(metadata)),
          releaseKeys.privateKey,
        ).toString("base64"),
      },
    };
  };
  const pin = {
    authority: identity.authority,
    installationFingerprint: identity.installationFingerprint,
  };
  const context = { owner: pin, expectedConsentRevision: 0 };
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
      launches: [{ id: runtime.generation, buildId, phase: "ready", epoch: "fixture-epoch" }],
    },
    context,
    true,
  );
  let command = memoryRegistryCommand(seeded);
  wiring.run = (script) => command.run(script);
  wiring.before = undefined;
  const keys = {
    fixture: releaseKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  const request = {
    stageId: "publication-fixture",
    consentRevision: 1,
    gateway: artifact("mobile-gateway", gatewayBytes),
    assets: artifact("mobile-assets", assetsBytes),
    gatewayBytes,
    assetsBytes,
  };
  const run = <A>(
    operation: (publisher: MobileOptionalPublisher, signal: AbortSignal) => Promise<A>,
    options: {
      signal?: AbortSignal;
      onExit?: () => Promise<void>;
      settings?: ServerSettingsShape;
    } = {},
  ) => {
    const program = withMobileOptionalPublisher(keys, operation).pipe(
      Effect.provideService(BackendInstance, owner),
      Effect.provideService(RemoteBackendIdentityService, identity),
      Effect.provideService(ServerConfig, { ...config, mode: "remote", stateDir }),
      Effect.provideService(ServerSettingsService, options.settings ?? settings),
    );
    return Effect.runPromise(
      options.onExit ? program.pipe(Effect.ensuring(Effect.promise(options.onExit))) : program,
      options.signal ? { signal: options.signal } : undefined,
    );
  };
  return {
    home,
    stateDir,
    control,
    identity,
    pin,
    settings,
    request,
    keys,
    run,
    releaseOwner: () => handle.release(),
    owner: () => owner,
    read: () => command.read(),
    command: () => command,
    replaceState: (state: RemoteAgentRegistry) => {
      command = memoryRegistryCommand(state);
    },
    artifact,
    restart: async (previousDead: boolean) => {
      await handle.release();
      const nextProbe = {
        ...probe,
        startToken: (pid: number) =>
          pid === process.pid
            ? previousDead
              ? `${PROCESS_START_TOKEN_PREFIX}test:second-process-start`
              : `${PROCESS_START_TOKEN_PREFIX}test:publication-fixture-start`
            : options.processStarts?.get(pid),
      };
      handle = await acquireStateDirLock({ stateDir, port: 49321, probe: nextProbe });
      owner = makeBackendInstance(handle, stateDir, nextProbe);
    },
    close: async () => {
      wiring.before = undefined;
      await handle.release();
      Object.defineProperty(process, "platform", { value: oldPlatform, configurable: true });
      vi.unstubAllEnvs();
      await fs.rm(home, { recursive: true, force: true });
    },
  };
}
