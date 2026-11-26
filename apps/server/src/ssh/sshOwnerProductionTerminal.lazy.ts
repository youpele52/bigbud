import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import * as Effect from "effect/Effect";

import type { RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import type { RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import type { DirectSshTerminalCwdOwner } from "../terminal/Layers/Manager.cwd.owner.ts";
import {
  PtySpawnError,
  type PtyAdapterShape,
  type PtySpawnInput,
} from "../terminal/Services/PTY.ts";
import {
  isProductionDirectSshTarget,
  makeSshOwnerProductionTerminal,
} from "./sshOwnerProductionTerminal.ts";
import type { SshOwnerProductionRegistration } from "./sshOwnerProductionRegistry.ts";

/**
 * The production terminal composition is built from the live owner's own
 * artifact, so durable lease rows name the native owner that holds them. The
 * owner may open after the terminal manager starts; until then, and after its
 * death, direct SSH spawns refuse typed and nothing routes to legacy SSH.
 *
 * @module sshOwnerProductionTerminal.lazy
 */

export interface LazyProductionTerminalOptions {
  readonly read: () => SshOwnerProductionRegistration | undefined;
  readonly owners: () => RemoteAgentOwnerStore;
  readonly targets: () => Promise<ReadonlyArray<string>>;
  readonly shellFor?: (input: PtySpawnInput) => string | undefined;
}

/** Native-owner metadata in the local host's durable runtime format. */
export function productionTerminalRuntime(artifactPath: string): RemoteAgentRuntime {
  const sha256 = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
  const root = path.dirname(artifactPath);
  return {
    generation: "production-ssh-owner",
    version: "1.0.0",
    sha256,
    buildDigest: sha256,
    // The local terminal route reuses the legacy storage triple discriminator only.
    targetTriple:
      process.arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl",
    origin: "legacy-external",
    binaryPath: artifactPath,
    statePath: root,
    socketPath: path.join(root, "supervisor.sock"),
    logPath: path.join(root, "supervisor.log"),
  };
}

export function makeLazySshOwnerProductionTerminal(options: LazyProductionTerminalOptions) {
  let built:
    | { artifactPath: string; value: ReturnType<typeof makeSshOwnerProductionTerminal> }
    | undefined;
  const current = () => {
    const artifactPath = options.read()?.handle.artifactPath;
    if (!artifactPath) return undefined;
    if (built?.artifactPath !== artifactPath) {
      built = {
        artifactPath,
        value: makeSshOwnerProductionTerminal({
          ...options,
          runtime: productionTerminalRuntime(artifactPath),
        }),
      };
    }
    return built.value;
  };
  const unavailable = () =>
    Effect.fail(
      new PtySpawnError({
        adapter: "native-ssh-owner",
        message: "sshOwnerUnavailable: The SSH owner is not running; no SSH terminal was started.",
      }),
    );

  function wrapPtyAdapter(original: PtyAdapterShape): PtyAdapterShape {
    // One wrapper per built composition, so each registers its own quit closer.
    const wrappers = new WeakMap<object, PtyAdapterShape>();
    const wrapped = () => {
      const composition = current();
      if (!composition) return undefined;
      const existing = wrappers.get(composition);
      if (existing) return existing;
      const next = composition.wrapPtyAdapter(original);
      wrappers.set(composition, next);
      return next;
    };
    return {
      ...original,
      ownedRuntimeForTarget: (id) =>
        isProductionDirectSshTarget(id)
          ? wrapped()?.ownedRuntimeForTarget?.(id)
          : original.ownedRuntimeForTarget?.(id),
      spawn: (input) => {
        if (!isProductionDirectSshTarget(input.executionTargetId)) return original.spawn(input);
        const next = wrapped();
        return next ? next.spawn(input) : unavailable();
      },
    };
  }

  const cwdOwner: DirectSshTerminalCwdOwner = {
    probeCwd: (input, signal) => {
      const composition = current();
      if (!composition) return Promise.reject(new Error("The SSH owner is not running."));
      return composition.cwdOwner.probeCwd(input, signal);
    },
  };

  return { wrapPtyAdapter, cwdOwner };
}
