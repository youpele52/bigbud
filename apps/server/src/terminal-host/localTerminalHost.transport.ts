import { createHash } from "node:crypto";

import { findWorkspaceAgentTarget } from "../../../../scripts/lib/workspace-agent-target.ts";
import {
  RemoteAgentConnection,
  RemoteAgentConnectionError,
  type RemoteAgentLocalProcessInput,
} from "../remote-agent/remoteAgentConnection.ts";
import type {
  RemoteAgentConnectionPoolFactory,
  RemoteAgentRuntimeBinding,
} from "../remote-agent/remoteAgentConnectionPool.ts";
import type { RemoteAgentHello } from "../remote-agent/remoteAgentProtocol.ts";
import {
  validateRemoteAgentRuntime,
  type RemoteAgentRuntime,
} from "../remote-agent/remoteAgentRuntime.ts";
import {
  LOCAL_TERMINAL_HOST_TARGET_ID,
  type LocalTerminalHostGenerationPaths,
} from "./localTerminalHost.paths.ts";

export const LOCAL_TERMINAL_HOST_PROXY_PATH = "/usr/local/bin:/usr/bin:/bin";

/**
 * The host's hello. Protocol 1.9 hosts fill `processId`/`processStartTimeMs` (R4/R5), which name
 * the PID to verify; an older host omits them and the registry falls back to its own record plus
 * `LC_ALL=C ps -o lstart=` verification.
 */
export type LocalTerminalHostHello = RemoteAgentHello;

const POOL_TRIPLES: Readonly<Record<string, RemoteAgentRuntime["targetTriple"]>> = {
  aarch64: "aarch64-unknown-linux-musl",
  x86_64: "x86_64-unknown-linux-musl",
};

/**
 * The durable owner store and pool validate every binding with the remote-agent runtime rules
 * (Linux triple, `linux` hello OS). This adapter presents a local host through that shape:
 * `origin: "legacy-external"` (no managed path layout), a Linux triple naming only the
 * architecture, and a deterministic identity hash derived from the host's own version and build.
 * The real OS and architecture are checked in `adaptLocalTerminalHostConnection` instead.
 */
export function localTerminalHostRuntime(input: {
  readonly generation: LocalTerminalHostGenerationPaths;
  readonly agentVersion: string;
  readonly buildDigest: string;
  readonly architecture: string;
  readonly binaryPath: string;
}): RemoteAgentRuntime {
  const targetTriple = POOL_TRIPLES[input.architecture];
  if (!targetTriple)
    throw new Error(`Unsupported terminal host architecture ${input.architecture}.`);
  return validateRemoteAgentRuntime({
    generation: input.generation.name,
    version: input.agentVersion,
    sha256: createHash("sha256")
      .update(`${LOCAL_TERMINAL_HOST_TARGET_ID}\0${input.agentVersion}\0${input.buildDigest}`)
      .digest("hex"),
    buildDigest: input.buildDigest,
    targetTriple,
    binaryPath: input.binaryPath,
    statePath: input.generation.statePath,
    socketPath: input.generation.socketPath,
    logPath: input.generation.logPath,
    origin: "legacy-external",
  });
}

/** The pool binding comes from the hello: digest and epoch of the host actually running. */
export function localTerminalHostBinding(
  generation: LocalTerminalHostGenerationPaths,
  hello: Pick<RemoteAgentHello, "agentVersion" | "buildDigest" | "architecture" | "agentEpoch">,
  binaryPath: string,
): RemoteAgentRuntimeBinding {
  return {
    connectionId: generation.name,
    expectedEpoch: hello.agentEpoch,
    runtime: localTerminalHostRuntime({
      generation,
      agentVersion: hello.agentVersion,
      buildDigest: hello.buildDigest,
      architecture: hello.architecture,
      binaryPath,
    }),
  };
}

/** Rejects a hello from another platform, then presents it in the pool's Linux shape. */
export function normalizeLocalTerminalHostHello(
  hello: RemoteAgentHello,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): RemoteAgentHello {
  const target = findWorkspaceAgentTarget(platform, architecture);
  if (!target || hello.os !== target.rustOs || hello.architecture !== target.rustArch)
    throw new RemoteAgentConnectionError(
      "Local terminal host platform differs from this backend.",
      "IDENTITY_MISMATCH",
    );
  return { ...hello, os: "linux" };
}

/** Forwards every member to the real connection; only `handshake` is normalized. */
export function adaptLocalTerminalHostConnection(
  connection: RemoteAgentConnection,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): RemoteAgentConnection {
  return new Proxy(connection, {
    get(target, property) {
      if (property === "handshake")
        return async (...args: Parameters<RemoteAgentConnection["handshake"]>) =>
          normalizeLocalTerminalHostHello(await target.handshake(...args), platform, architecture);
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export type LocalTerminalHostConnect = (
  input: RemoteAgentLocalProcessInput,
) => RemoteAgentConnection;

/** `--proxy` is a pure byte forwarder, so the currently staged binary reaches any generation. */
export function connectLocalTerminalHostProxy(
  proxyBinary: string,
  statePath: string,
  connect: LocalTerminalHostConnect = RemoteAgentConnection.local,
): RemoteAgentConnection {
  return connect({
    binaryPath: proxyBinary,
    mode: "proxy",
    env: {
      BIGBUD_AGENT_STATE_DIR: statePath,
      PATH: LOCAL_TERMINAL_HOST_PROXY_PATH,
      LANG: "C.UTF-8",
    },
  });
}

export interface LocalTerminalHostTransportOptions {
  readonly resolveBinding: () => Promise<RemoteAgentRuntimeBinding | undefined>;
  readonly proxyBinary: () => Promise<string>;
  /** Runs before every dial; refuses symlinked, foreign or group-accessible sockets. */
  readonly assertSocket: (socketPath: string) => Promise<void>;
  readonly connect?: LocalTerminalHostConnect;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
}

/** Dedicated factory for target `local-terminal-host`; each generation binding dials its own socket. */
export function makeLocalTerminalHostTransportFactory(
  options: LocalTerminalHostTransportOptions,
): RemoteAgentConnectionPoolFactory {
  const assertTarget = (target: string) => {
    if (target !== LOCAL_TERMINAL_HOST_TARGET_ID)
      throw new Error("The local terminal host transport cannot address another target.");
  };
  return {
    resolveBinding: async (target) => {
      assertTarget(target);
      return options.resolveBinding();
    },
    create: async (target, binding) => {
      assertTarget(target);
      if (!binding?.expectedEpoch)
        throw new Error("A local terminal host connection requires a generation binding.");
      // Owner rows bind `{ runtime, expectedEpoch }`; the runtime's generation is the connection
      // id by construction (F2), so an explicit connection id must agree with it.
      if (binding.connectionId !== undefined && binding.connectionId !== binding.runtime.generation)
        throw new Error("A local terminal host binding names another generation.");
      await options.assertSocket(binding.runtime.socketPath);
      const connection = connectLocalTerminalHostProxy(
        await options.proxyBinary(),
        binding.runtime.statePath,
        options.connect,
      );
      return adaptLocalTerminalHostConnection(connection, options.platform, options.architecture);
    },
  };
}
