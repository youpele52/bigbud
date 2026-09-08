import posix from "node:path/posix";
import { Schema } from "effect";

export const RemoteAgentRuntimeSchema = Schema.Struct({
  generation: Schema.String,
  version: Schema.String,
  sha256: Schema.String,
  buildDigest: Schema.String,
  targetTriple: Schema.String,
  binaryPath: Schema.String,
  statePath: Schema.String,
  socketPath: Schema.String,
  logPath: Schema.String,
  origin: Schema.Literals(["managed", "legacy-external"]),
});
export type RemoteAgentRuntime = typeof RemoteAgentRuntimeSchema.Type;

export function remoteAgentBuildId(runtime: RemoteAgentRuntime): string {
  return `${runtime.version}:${runtime.sha256}:${runtime.targetTriple}${runtime.origin === "legacy-external" ? ":legacy" : ""}`;
}

export function remoteAgentRuntimeEqual(
  left: RemoteAgentRuntime,
  right: RemoteAgentRuntime,
): boolean {
  return (
    left.generation === right.generation &&
    left.version === right.version &&
    left.sha256 === right.sha256 &&
    left.buildDigest === right.buildDigest &&
    left.targetTriple === right.targetTriple &&
    left.binaryPath === right.binaryPath &&
    left.statePath === right.statePath &&
    left.socketPath === right.socketPath &&
    left.logPath === right.logPath &&
    left.origin === right.origin
  );
}

export function hasRemoteAgentPathControls(path: string): boolean {
  return Array.from(path).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

/** Reject shell fragments and noncanonical paths before a descriptor becomes durable. */
export function validateRemoteAgentRuntime(value: unknown): RemoteAgentRuntime {
  const runtime = Schema.decodeUnknownSync(RemoteAgentRuntimeSchema)(value);
  if (!/^[a-z0-9-]{1,32}$/.test(runtime.generation)) throw new Error("Invalid runtime generation.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(runtime.version)) {
    throw new Error("Invalid runtime version.");
  }
  if (!/^[a-f0-9]{64}$/.test(runtime.sha256)) throw new Error("Invalid runtime artifact hash.");
  if (
    !runtime.buildDigest ||
    runtime.buildDigest.length > 256 ||
    !/^[\x21-\x7e]+$/.test(runtime.buildDigest)
  ) {
    throw new Error("Invalid runtime build identity.");
  }
  if (!/^(aarch64|x86_64)-unknown-linux-gnu$/.test(runtime.targetTriple)) {
    throw new Error("Unsupported runtime target.");
  }
  for (const path of [runtime.binaryPath, runtime.statePath, runtime.socketPath, runtime.logPath]) {
    if (
      !path.startsWith("/") ||
      posix.normalize(path) !== path ||
      hasRemoteAgentPathControls(path)
    ) {
      throw new Error("Invalid runtime path.");
    }
  }
  if (Buffer.byteLength(runtime.socketPath) > 107)
    throw new Error("Runtime socket path is too long.");
  if (runtime.socketPath !== `${runtime.statePath}/supervisor.sock`) {
    throw new Error("Runtime socket is outside its state root.");
  }
  if (runtime.origin === "managed") {
    const root = posix.dirname(posix.dirname(runtime.statePath));
    if (
      runtime.statePath !== `${root}/runtimes/${runtime.generation}` ||
      runtime.binaryPath !==
        `${root}/bin/${runtime.version}/${runtime.sha256}/bigbud-remote-agent` ||
      runtime.logPath !== `${runtime.statePath}/supervisor.log`
    ) {
      throw new Error("Managed runtime paths disagree with immutable identity.");
    }
  }
  return Object.freeze(runtime);
}
