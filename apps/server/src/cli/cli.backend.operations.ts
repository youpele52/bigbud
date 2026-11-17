import { userInfo } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { resolveServerConfig } from "./cli.config.ts";
import { prepareBackendSetupCliInput, type BackendSetupCliInput } from "./cli.backend.inputs.ts";
import { backendCliOwned, BackendCliError } from "./cli.backend.effect.ts";
import { backendUnitRunning } from "./cli.backend.failure.ts";
import { readLocalSupervisorServiceConfig } from "../remote-backend/localSupervisorService.config.read.ts";
import {
  readLocalSupervisorServiceFile,
  assertLocalSupervisorServiceDirectory,
} from "../remote-backend/localSupervisorService.files.ts";
import { verifyManagedLocalSupervisor } from "../remote-backend/localSupervisorBinary.ts";
import { runLocalSupervisorCommand } from "../remote-backend/localSupervisorControl.runner.ts";
import { runLocalSupervisorServicePreflight } from "../remote-backend/localSupervisorService.preflight.ts";
import { setupLocalSupervisorService } from "../remote-backend/localSupervisorService.setup.ts";
import { inspectLocalSupervisorServiceSetup } from "../remote-backend/localSupervisorService.setup.status.ts";
import { parseRemoteAgentRegistry } from "../remote-agent/remoteAgentInstall.registry.ts";
import { quoteRemoteAgentLaunchValue as quote } from "../remote-agent/remoteAgentRuntime.launch.prepare.ts";

function actualAccount() {
  const account = userInfo();
  if (process.platform !== "linux" || account.uid === 0 || account.uid !== process.getuid?.())
    throw new BackendCliError({
      message: "Backend services require the actual unprivileged Linux account.",
    });
  return account;
}
function configuration(backendHome: string) {
  return resolveServerConfig(
    {
      mode: Option.some("remote"),
      baseDir: Option.some(backendHome),
      authToken: Option.some(randomBytes(32).toString("hex")),
      noBrowser: Option.some(true),
      autoBootstrapProjectFromCwd: Option.some(false),
      port: Option.none(),
      host: Option.none(),
      cwd: Option.none(),
      devUrl: Option.none(),
      bootstrapFd: Option.none(),
      logWebSocketEvents: Option.none(),
    },
    Option.none(),
  );
}

export const runBackendSetupCli = Effect.fn("runBackendSetupCli")(function* (
  input: BackendSetupCliInput,
) {
  yield* Effect.try({
    try: actualAccount,
    catch: (cause) =>
      new BackendCliError({ message: "Linux account service setup is unavailable.", cause }),
  });
  const prepared = yield* backendCliOwned((signal) => prepareBackendSetupCliInput(input, signal));
  const config = yield* configuration(prepared.backendHome);
  return yield* runLocalSupervisorServicePreflight({
    config,
    operation: (context, signal) => setupLocalSupervisorService(context, prepared, signal),
  });
});

export type BackendNativeAction = "status" | "enable" | "disable" | "start" | "stop";
const NATIVE_TIMEOUT_MS: Readonly<Record<BackendNativeAction, number>> = {
  status: 60_000,
  disable: 60_000,
  enable: 180_000,
  // Capability probe, reload and a bounded Type=exec start; stop waits for two stop timeouts.
  start: 90_000,
  stop: 90_000,
};
async function selectedNative(authorityId: string, signal: AbortSignal) {
  if (!/^[a-f0-9]{32}$/.test(authorityId)) throw new Error("Exact backend authority is required.");
  const account = actualAccount(),
    home = await realpath(account.homedir);
  const configPath = join(home, ".bigbud/backend-services", authorityId, "config-v1");
  const { config, raw } = await readLocalSupervisorServiceConfig({
    homeDir: home,
    configPath,
    authorityId,
  });
  const root = join(home, ".bigbud/agent");
  await assertLocalSupervisorServiceDirectory(root);
  await assertLocalSupervisorServiceDirectory(join(root, "control-v1"));
  const reservation = await readLocalSupervisorServiceFile(
    join(root, "account-authority-v1"),
    32 * 1024,
  );
  if (
    createHash("sha256").update(reservation).digest("hex") !== config.authority_reservation_sha256
  )
    throw new Error("Configured account reservation changed.");
  const registry = parseRemoteAgentRegistry(
    await readLocalSupervisorServiceFile(join(root, "control-v1/registry.json"), 1024 * 1024),
  );
  const build = registry.builds.find(
    (row) =>
      row.authenticated &&
      row.binary === "present" &&
      row.runtime.origin === "managed" &&
      row.runtime.sha256 === config.rust_sha256 &&
      row.runtime.binaryPath === config.rust_binary &&
      row.runtime.statePath === config.rust_state,
  );
  if (!build) throw new Error("Configured managed signed runtime is unavailable.");
  await verifyManagedLocalSupervisor(build.runtime);
  signal.throwIfAborted();
  return {
    home,
    configPath,
    config,
    raw,
    runtime: build.runtime,
    binary: build.runtime.binaryPath,
  };
}

type SelectedNative = Awaited<ReturnType<typeof selectedNative>>;
async function invokeNative(
  selected: SelectedNative,
  action: BackendNativeAction,
  signal: AbortSignal,
): Promise<string> {
  const result = await runLocalSupervisorCommand(
    "/bin/sh",
    [
      "-c",
      `${quote(selected.binary)} --backend-service ${action} ${quote(selected.configPath)}${action === "enable" ? " --confirm-startup" : ""}`,
    ],
    {
      cwd: selected.home,
      signal,
      timeoutMs: NATIVE_TIMEOUT_MS[action],
      maxBufferBytes: 64 * 1024,
      env: { HOME: selected.home, PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
    },
  );
  return result.stdout;
}

/** Native CLI revalidates configuration/graph and owns finite preflight before boot policy changes. */
export const runBackendNativeCli = Effect.fn("runBackendNativeCli")(function* (input: {
  readonly authorityId: string;
  readonly action: BackendNativeAction;
  readonly confirmStartup?: boolean;
}) {
  const fixed = Object.freeze({ ...input });
  if (
    !Object.hasOwn(NATIVE_TIMEOUT_MS, fixed.action) ||
    (fixed.action === "enable" && fixed.confirmStartup !== true)
  )
    return yield* Effect.fail(
      new BackendCliError({ message: "Explicit startup confirmation is required." }),
    );
  const selected = yield* backendCliOwned((signal) => selectedNative(fixed.authorityId, signal));
  if (fixed.action === "start") {
    // A running backend holds the state directory its preflight needs, so start is answered
    // from read-only unit status instead of failing on the lock: an idempotent no-op.
    const status = yield* backendCliOwned((signal) => invokeNative(selected, "status", signal));
    if (backendUnitRunning(status, fixed.authorityId))
      return Object.freeze({
        authorityId: fixed.authorityId,
        action: fixed.action,
        output: `${status.trim()}\nThe backend is already running; nothing was started.\n`,
      });
  }
  // Starting, like enabling, requires verified setup completion; stop never depends on it.
  if (fixed.action === "enable" || fixed.action === "start") {
    const config = yield* configuration(selected.config.backend_home);
    const observed = yield* runLocalSupervisorServicePreflight({
      config,
      requireExistingIdentity: true,
      validateIdentity: (identity) => {
        if (
          identity.authority.authorityId !== fixed.authorityId ||
          identity.installationFingerprint !== selected.config.expected_installation_fingerprint
        )
          throw new Error("Service identity changed.");
      },
      operation: inspectLocalSupervisorServiceSetup,
    });
    if (observed.status !== "present")
      return yield* Effect.fail(
        new BackendCliError({
          message: "Setup completion could not be verified; preserve it for repair.",
        }),
      );
  }
  return yield* backendCliOwned(async (signal) => {
    const current = await readLocalSupervisorServiceConfig({
      homeDir: selected.home,
      configPath: selected.configPath,
      authorityId: fixed.authorityId,
    });
    if (current.raw !== selected.raw)
      throw new Error("Configured service changed before execution.");
    await verifyManagedLocalSupervisor(selected.runtime);
    signal.throwIfAborted();
    return Object.freeze({
      authorityId: fixed.authorityId,
      action: fixed.action,
      output: await invokeNative(selected, fixed.action, signal),
    });
  });
});
