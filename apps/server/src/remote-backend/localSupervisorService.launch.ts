import { assertLocalSupervisorServiceReservation } from "./localSupervisorService.reservation.ts";
import { dirname, join } from "node:path";
import type { RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import {
  buildRemoteAgentLaunchPreparation,
  quoteRemoteAgentLaunchValue as quote,
} from "../remote-agent/remoteAgentRuntime.launch.prepare.ts";
import { buildManagedRemoteAgentReplacementPreparation } from "../remote-agent/remoteAgentRuntime.launch.replacement.ts";
import { verifyManagedLocalSupervisor } from "./localSupervisorBinary.ts";
import type { LocalSupervisorControl } from "./localSupervisorControl.ts";
import { readLocalSupervisorServiceConfig } from "./localSupervisorService.config.read.ts";
import { readLocalSupervisorServiceFile } from "./localSupervisorService.files.ts";
import { buildLocalSupervisorServiceProjection } from "./localSupervisorService.projection.ts";

/** Independent account unit launcher. Its acknowledgment is not authenticated P4 readiness. */
export function makeLocalSupervisorServiceLauncher(input: {
  readonly control: LocalSupervisorControl;
  readonly configPath: string;
  readonly signal?: AbortSignal;
}) {
  const { control } = input;
  const run = (script: string, stdin?: string) =>
    control.run(control.targetId, script, {
      timeoutMs: 60_000,
      maxBufferBytes: 64 * 1024,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(stdin === undefined ? {} : { stdin }),
    });
  const launch = async (
    runtime: RemoteAgentRuntime,
    attemptId: string,
    oldEpoch?: string,
    oldAttemptId?: string,
  ) => {
    input.signal?.throwIfAborted();
    if (runtime.origin !== "managed" || dirname(dirname(runtime.statePath)) !== control.root)
      throw new Error("Service launch requires this account's immutable managed runtime.");
    await assertLocalSupervisorServiceReservation(control, runtime, attemptId);
    const authority = control.targetId.slice("remote-backend:".length);
    const expectedConfig = input.configPath;
    const { config, raw: previousConfig } = await readLocalSupervisorServiceConfig({
      homeDir: control.homeDir,
      configPath: expectedConfig,
      authorityId: authority,
    });
    if (
      config.rust_binary !== runtime.binaryPath ||
      config.rust_sha256 !== runtime.sha256 ||
      config.rust_state !== runtime.statePath
    )
      throw new Error("Service config does not select this authority's reserved managed runtime.");
    await verifyManagedLocalSupervisor(runtime);
    const capabilities = (await run(`${quote(runtime.binaryPath)} --check --capabilities`)).stdout;
    // This factory starts only the independent Rust/P4 unit. Backend stage/enable requires
    // backend-service-graph=1 separately; protocol2 alone never authorizes Node activation.
    if (!capabilities.split(/\s+/).includes("backend-service=2"))
      throw new Error("The verified signed runtime does not support account services.");
    // Read-only native verification binds config/artifacts/account reservation before intent writes.
    await run(`${quote(runtime.binaryPath)} --backend-service render ${quote(expectedConfig)}`);
    const prepared = (
      await run(
        oldEpoch === undefined
          ? buildRemoteAgentLaunchPreparation(runtime, attemptId)
          : buildManagedRemoteAgentReplacementPreparation(
              runtime,
              attemptId,
              oldEpoch,
              oldAttemptId!,
            ),
      )
    ).stdout.trim();
    if (prepared) return prepared;
    const bootId = (
      await readLocalSupervisorServiceFile(join(runtime.statePath, "launch.boot"), 256)
    ).trim();
    const projection = buildLocalSupervisorServiceProjection({
      runtime,
      configPath: expectedConfig,
      previousConfig,
      attemptId,
      priorEpoch: oldEpoch ?? "fresh",
      bootId,
    });
    await run(projection.script, projection.stdin);
    await run(
      `${quote(runtime.binaryPath)} --backend-service start-rust ${quote(expectedConfig)} --confirm-startup`,
    );
    return "launch-reserved";
  };
  return {
    launch: (runtime: RemoteAgentRuntime, attemptId: string) => launch(runtime, attemptId),
    launchReplacement: (
      runtime: RemoteAgentRuntime,
      attemptId: string,
      oldEpoch: string,
      oldAttemptId: string,
    ) => launch(runtime, attemptId, oldEpoch, oldAttemptId),
  };
}
