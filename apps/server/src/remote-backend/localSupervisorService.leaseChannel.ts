import { userInfo } from "node:os";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { BackendInstance } from "../startup/backendInstance.ts";
import { RemoteAgentRuntimeOwners } from "../persistence/Layers/RemoteAgentRuntimeBindings.service.ts";
import { RemoteAgentConnection } from "../remote-agent/remoteAgentConnection.ts";
import { parseRemoteAgentRegistry } from "../remote-agent/remoteAgentInstall.registry.ts";
import { remoteAgentRuntimeEqual } from "../remote-agent/remoteAgentRuntime.ts";
import {
  connectNativeServiceLeaseClient,
  type NativeServiceLeaseClient,
} from "../remote-agent/remoteAgentServiceLeaseClient.ts";
import { RemoteBackendIdentityService } from "./identity.service.ts";
import { makeLocalSupervisorControl } from "./localSupervisorControl.ts";
import { assertLocalSupervisorBackendReservation } from "./localSupervisorAuthority.ts";
import { readLocalSupervisorServiceConfig } from "./localSupervisorService.config.read.ts";
import {
  assertLocalSupervisorServiceDirectory,
  readLocalSupervisorServiceFile,
} from "./localSupervisorService.files.ts";
import { verifyManagedLocalSupervisor } from "./localSupervisorBinary.ts";
import { managedLeaseRuntimeSelection } from "./localSupervisorService.leaseChannel.policy.ts";

export class ManagedNativeLeaseChannelError extends Data.TaggedError(
  "ManagedNativeLeaseChannelError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
const failure = (cause: unknown) =>
  new ManagedNativeLeaseChannelError({
    message: "The managed account lease channel is unavailable; preserve existing ownership.",
    cause,
  });
export interface ManagedNativeLeaseChannel {
  readonly _managedLeaseChannel: unique symbol;
}
type Record = {
  readonly client: NativeServiceLeaseClient;
  readonly nativeEpoch: string;
  readonly targetId: string;
  readonly assertCurrent: () => Promise<void>;
};
const channels = new WeakMap<ManagedNativeLeaseChannel, Record>();

/** Reject structural/fake clients. No renderer channel/path/command can mint this handle. */
export function managedNativeLeaseChannel(channel: ManagedNativeLeaseChannel): Record {
  const record = channels.get(channel);
  if (!record) throw failure(undefined);
  return record;
}

/** Actual held account/identity/SQL only. Does not create a root, claim, install, or start anything. */
export const acquireManagedNativeLeaseChannel = Effect.fn("acquireManagedNativeLeaseChannel")(
  function* () {
    const owner = yield* BackendInstance;
    const identity = yield* RemoteBackendIdentityService;
    const owners = yield* RemoteAgentRuntimeOwners;
    return yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          if (process.platform !== "linux" || process.getuid?.() === 0 || owner.pid !== process.pid)
            throw failure(undefined);
          const home = userInfo().homedir;
          if ((await realpath(home)) !== home) throw failure(undefined);
          const targetId = `remote-backend:${identity.authority.authorityId}`;
          const control = makeLocalSupervisorControl({ targetId, homeDir: home });
          const configPath = join(
            home,
            ".bigbud/backend-services",
            identity.authority.authorityId,
            "config-v1",
          );
          const snapshot = async () => {
            await owner.assertHeld();
            await assertLocalSupervisorBackendReservation(control, identity, owner.stateDir);
            const { config, raw } = await readLocalSupervisorServiceConfig({
              homeDir: home,
              configPath,
              authorityId: identity.authority.authorityId,
            });
            if (config.expected_installation_fingerprint !== identity.installationFingerprint)
              throw failure(undefined);
            // Read the existing journal directly. registry.read() would prepare/write its lock root.
            await assertLocalSupervisorServiceDirectory(join(control.root, "control-v1"));
            const registry = parseRemoteAgentRegistry(
              await readLocalSupervisorServiceFile(
                join(control.root, "control-v1/registry.json"),
                1024 * 1024,
              ),
            );
            const binding = managedLeaseRuntimeSelection(
              registry,
              await owners.getBinding(targetId),
              config,
            );
            await owner.assertHeld();
            return { binding, raw };
          };
          const selected = await snapshot();
          await verifyManagedLocalSupervisor(selected.binding.runtime);
          let client: NativeServiceLeaseClient | undefined;
          const connection = RemoteAgentConnection.local({
            binaryPath: selected.binding.runtime.binaryPath,
            args: ["--backend-service", "proxy", configPath],
            env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
          });
          try {
            client = await connectNativeServiceLeaseClient(connection, {
              nativeEpoch: selected.binding.expectedEpoch,
              stateDir: owner.stateDir,
              expectedRuntime: selected.binding.runtime,
            });
            const assertCurrent = async () => {
              const current = await snapshot();
              if (
                current.raw !== selected.raw ||
                current.binding.expectedEpoch !== selected.binding.expectedEpoch ||
                current.binding.connectionId !== selected.binding.connectionId ||
                !remoteAgentRuntimeEqual(current.binding.runtime, selected.binding.runtime)
              )
                throw failure(undefined);
            };
            await assertCurrent();
            const channel = Object.freeze({}) as ManagedNativeLeaseChannel;
            channels.set(
              channel,
              Object.freeze({
                client,
                targetId,
                nativeEpoch: selected.binding.expectedEpoch,
                assertCurrent,
              }),
            );
            return channel;
          } catch (cause) {
            if (client) await client.dispose();
            else await connection.closeConfirmed();
            throw cause;
          }
        },
        catch: failure,
      }),
      (channel) =>
        Effect.tryPromise({
          try: async () => {
            const record = managedNativeLeaseChannel(channel);
            try {
              await record.client.dispose();
            } finally {
              channels.delete(channel);
            }
          },
          catch: failure,
        }).pipe(Effect.orDie),
    );
  },
);
