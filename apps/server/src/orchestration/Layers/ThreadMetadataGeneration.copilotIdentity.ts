import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import type { ServerSettings } from "@bigbud/contracts/core/settings.ts";
import type { ModelSelection } from "@bigbud/contracts/orchestration/orchestration.provider";
import { metadataProviderConfiguration } from "./ThreadMetadataGeneration.configuration.ts";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireCopilotLease } from "@bigbud/shared/copilotRuntime.storage";
import { copilotRuntimeRoot } from "@bigbud/shared/copilotRuntime.paths";
import {
  resolveCopilotRuntimeInvocation,
  type CopilotRuntimeInvocation,
} from "../../provider/Layers/Copilot/Adapter.types.cli.ts";
import { copilotNativePackageName } from "../../provider/Layers/Copilot/Runtime.release.ts";
import { sdkCopilotExecutable } from "../../provider/Layers/Copilot/Runtime.executable.ts";
import { metadataFingerprint } from "./ThreadMetadataGeneration.policy.ts";
import { closeMetadataRuntime, metadataAbortable } from "./ThreadMetadataGeneration.runtime.ts";

/** Resolve explicitly; SDK implicit transport/environment selection is not execution authority. */
export function copilotMetadataRuntime(binary: string, environment: NodeJS.ProcessEnv) {
  const invocation = resolveCopilotRuntimeInvocation(binary, { env: environment });
  if (invocation) return invocation;
  const name = copilotNativePackageName({
    platform: process.platform,
    arch: process.arch,
    isMusl:
      process.platform === "linux" &&
      !(process.report?.getReport() as { header?: { glibcVersionRuntime?: string } })?.header
        ?.glibcVersionRuntime,
  });
  const path = name && sdkCopilotExecutable(name.slice("@github/copilot-".length));
  if (!path) throw new Error("Copilot metadata runtime is unavailable.");
  return { path, args: [], source: "sdk" as const };
}

/** Empty mode disables keytar: interactive/keychain-only authentication is not qualified. */
export function copilotMetadataAccount(account: {
  isAuthenticated: boolean;
  authType?: string;
  host?: string;
  login?: string;
}): string | null {
  if (
    !account.isAuthenticated ||
    !account.login ||
    !account.host ||
    !["env", "gh-cli", "token"].includes(account.authType ?? "")
  )
    return null;
  return metadataFingerprint(["copilot", account.authType, account.host, account.login]);
}

/** Include the resolved runtime, not only the user's potentially managed binary alias. */
export function copilotMetadataTransport(
  selection: ModelSelection,
  providers: ServerSettings["providers"],
  environment: NodeJS.ProcessEnv,
  runtime = copilotMetadataRuntime(providers.copilot.binaryPath || "copilot", environment),
): string {
  const config = providers.copilot;
  return metadataFingerprint({
    version: 1,
    selection,
    executionTarget: "local",
    config: metadataProviderConfiguration(config),
    binary: config.binaryPath || "copilot",
    runtime,
    environment,
  });
}

export type MetadataCopilotClient = Pick<CopilotClient, "start" | "getAuthStatus" | "forceStop">;
export type MetadataCopilotClientFactory = (
  binary: string,
  environment: NodeJS.ProcessEnv,
) => Promise<{
  client: MetadataCopilotClient;
  invocation: CopilotRuntimeInvocation;
  close: () => Promise<void>;
}>;

/** Constructor-only seam: verifies SDK options without leasing, auth, startup, or I/O. */
export function makeMetadataCopilotClient(
  invocation: CopilotRuntimeInvocation,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): CopilotClient {
  return new CopilotClient({
    connection: RuntimeConnection.forStdio({
      path: invocation.path,
      args: [...invocation.args],
      env: Object.fromEntries(
        Object.entries(environment).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    }),
    mode: "empty",
    // Process cwd is a real empty directory; session paths are memory-only.
    workingDirectory: cwd,
    sessionFs: { initialCwd: "/metadata", sessionStatePath: "/state", conventions: "posix" },
    logLevel: "none",
  });
}

export const createMetadataCopilotClient: MetadataCopilotClientFactory = async (
  binary,
  environment,
) => {
  // Lease BEFORE resolution, as for ordinary Copilot sessions: uninstall must not race startup.
  const release = await acquireCopilotLease(copilotRuntimeRoot());
  let ownedCwd: string | undefined;
  try {
    const invocation = copilotMetadataRuntime(binary, environment);
    ownedCwd = await mkdtemp(join(tmpdir(), "bigbud-metadata-copilot-"));
    const cwd = await realpath(ownedCwd);
    const client = makeMetadataCopilotClient(invocation, environment, cwd);
    const owned = ownedCwd;
    let closing: Promise<void> | undefined;
    return {
      client,
      invocation,
      close: () =>
        (closing ??= (async () => {
          // Keep the runtime lease/directory if stopping is uncertain. Never unlink beneath a live child.
          await client.forceStop();
          await release();
          await rm(owned, { recursive: true, force: true });
        })()),
    };
  } catch (error) {
    await release().catch(() => undefined);
    if (ownedCwd) await rm(ownedCwd, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
};

/** Bound cleanup independently of provider budget, without changing an established result. */
export const closeMetadataCopilotRuntime = (close: () => Promise<void>) =>
  closeMetadataRuntime(close, "Copilot");

/** Abort waits, not just model calls. A pre-source probe never sends conversation content. */
export function metadataCopilotAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return metadataAbortable(promise, signal, {
    aborted: "Copilot metadata execution aborted.",
  });
}

export async function probeMetadataCopilotAccount(
  binary: string,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
  create: MetadataCopilotClientFactory = createMetadataCopilotClient,
): Promise<string | null> {
  signal.throwIfAborted();
  const runtime = await create(binary, environment);
  try {
    signal.throwIfAborted();
    await metadataCopilotAbortable(runtime.client.start(), signal);
    return copilotMetadataAccount(
      await metadataCopilotAbortable(runtime.client.getAuthStatus(), signal),
    );
  } finally {
    // Cleanup failure never changes account evidence or permits generation.
    await closeMetadataCopilotRuntime(runtime.close);
  }
}
