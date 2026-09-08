import { randomUUID } from "node:crypto";
import type { PtyProcess, PtySpawnInput } from "../terminal/Services/PTY.ts";
import type { RemoteAgentConnectionPool } from "./remoteAgentConnectionPool.ts";
import {
  RemoteAgentPtyClient,
  RemoteAgentPtyError,
  RemoteAgentPtyProcess,
} from "./remoteAgentPtyClient.ts";
import {
  RemoteAgentWorkspaceClient,
  RemoteAgentWorkspaceError,
} from "./remoteAgentWorkspaceClient.ts";
import { remoteAgentAdmission } from "./remoteAgentAdmission.ts";
import {
  reclaimDeadPreparedOwner,
  remoteAgentOwners,
  type RemoteAgentOwnerStore,
  type RemoteAgentOwner,
} from "./remoteAgentOwners.ts";
import { remoteAgentRequestDigest } from "./remoteAgentRequestDigest.ts";
import { openRemoteAgentControl } from "./remoteAgentControl.ts";
import { pinRemoteAgentBuild } from "./remoteAgentInstall.registry.transitions.ts";
import { remoteAgentBuildId } from "./remoteAgentRuntime.ts";
import { currentRemoteAgentController } from "./remoteAgentController.ts";

/** Application terminal identity is resolved durably BEFORE generating a PTY ID or opening a workspace. */
export function makeOwnedRemoteAgentPty(
  pool: RemoteAgentConnectionPool,
  storeFor: () => RemoteAgentOwnerStore = remoteAgentOwners,
) {
  return async (input: PtySpawnInput): Promise<PtyProcess> => {
    if (!input.ownerKey || !input.executionTargetId || !input.remoteCwd)
      throw new Error("Remote terminal owner identity is required.");
    const store = storeFor();
    const key = `terminal:${input.ownerKey}`;
    const controller = currentRemoteAgentController();
    let owner = await reclaimDeadPreparedOwner(store, await store.get(key));
    if (!owner && input.recoverOnly)
      throw new Error(
        "Existing terminal history has no durable remote PTY identity. Its outcome is unknown; no replacement was spawned.",
      );
    let created = false;
    const digest = Buffer.from(
      remoteAgentRequestDigest({ target: input.executionTargetId, cwd: input.remoteCwd }),
    ).toString("hex");
    if (!owner || owner.state === "terminal") {
      const binding = owner
        ? { runtime: owner.runtime, expectedEpoch: owner.epoch }
        : await remoteAgentAdmission.resolveBinding(input.executionTargetId);
      if (!binding) throw new Error("Connect a new remote session before opening a terminal.");
      const resourceId = randomUUID();
      const reservationId = randomUUID();
      owner = await store.reserve(
        {
          ownerKey: key,
          controllerId: controller.id,
          controllerPid: controller.pid,
          controllerStartedAt: controller.startedAt,
          reservationId,
          target: input.executionTargetId,
          runtime: binding.runtime,
          epoch: binding.expectedEpoch,
          connectionId:
            "connectionId" in binding && binding.connectionId
              ? binding.connectionId
              : binding.runtime.generation,
          resourceId,
          digest,
          state: "prepared",
          outputSequence: 0,
          nextInputSequence: 1,
          inputAcknowledged: 0,
        },
        true,
      );
      created = owner.reservationId === reservationId;
    }
    if (!created && owner.state === "prepared" && owner.reservationId)
      throw new RemoteAgentPtyError(
        "PTY_IN_PROGRESS",
        "Another request is preparing this remote terminal; no duplicate dispatch was attempted.",
      );
    if (owner.target !== input.executionTargetId || owner.digest !== digest)
      throw new Error(
        "Existing terminal belongs to a different workspace; its outcome must be resolved before replacement.",
      );
    if (owner.state === "terminal")
      throw new Error("This terminal's remote process exited. Open a new terminal ID.");
    const binding = { runtime: owner.runtime, expectedEpoch: owner.epoch };
    const resourceId = owner.resourceId;
    const rollbackPrepared = async () => {
      if (!created) return;
      await store.rollbackPrepared?.(key, resourceId);
    };
    let connection: Awaited<ReturnType<typeof pool.getBound>>;
    let control: Awaited<ReturnType<typeof openRemoteAgentControl>>;
    try {
      connection = await pool.getBound(owner.target, binding, ["terminal.pty", "workspace.files"]);
      control = await openRemoteAgentControl(owner.target);
    } catch (cause) {
      try {
        await rollbackPrepared();
      } catch {
        // Keep the durable owner when a local rollback cannot be proven.
      }
      throw cause;
    }
    const ownerTarget = owner.target;
    const reconnect = () => pool.getBound(ownerTarget, binding, ["terminal.pty"]);
    const buildId = remoteAgentBuildId(owner.runtime);
    const pinOwner = `${key}:${owner.resourceId}`;
    const update = (transition: (current: RemoteAgentOwner) => RemoteAgentOwner) =>
      store.update(key, (current) =>
        current.resourceId === resourceId ? transition(current) : current,
      );
    const releaseDefinitiveFailure = async () => {
      await update((current) => ({ ...current, state: "terminal" }));
      await control.registry.update((state) => ({
        ...state,
        revision: state.revision + 1,
        pins: state.pins.filter((pin) => pin.owner !== pinOwner),
      }));
    };
    const markUnknownFailure = async () => {
      await update((current) => ({ ...current, state: "outcome-unknown" }));
    };
    let process: RemoteAgentPtyProcess;
    try {
      await control.registry.update((state) => pinRemoteAgentBuild(state, pinOwner, buildId));
      if (!created || owner.state !== "prepared") {
        process = new RemoteAgentPtyProcess(connection, owner.resourceId, reconnect);
        process.restoreSequences(
          owner.outputSequence,
          owner.nextInputSequence,
          owner.inputAcknowledged,
        );
        await process.attach(owner.outputSequence);
      } else {
        owner = await update((current) => ({ ...current, state: "may-have-been-sent" }));
        const workspaceHandle = `terminal-${owner.resourceId}`;
        try {
          await new RemoteAgentWorkspaceClient(connection).openWorkspace(
            workspaceHandle,
            input.remoteCwd,
          );
        } catch (cause) {
          if (cause instanceof RemoteAgentWorkspaceError) await releaseDefinitiveFailure();
          else await markUnknownFailure();
          throw cause;
        }
        process = await new RemoteAgentPtyClient(connection, reconnect).create({
          ptyId: owner.resourceId,
          requestDigest: Buffer.from(owner.digest, "hex"),
          workspaceHandle,
          cwd: "",
          shell: "/bin/sh",
          args: ["-lc", 'exec "${SHELL:-/bin/sh}" -l'],
          cols: input.cols,
          rows: input.rows,
          environment: Object.entries(input.env).flatMap(([name, value]) =>
            value !== undefined && /^(TERM|COLORTERM|LANG|LC_[A-Z_]+)$/.test(name)
              ? [{ name, value }]
              : [],
          ),
          onRejected: releaseDefinitiveFailure,
        });
      }
    } catch (cause) {
      try {
        await rollbackPrepared();
      } catch {
        // Conditional rollback never removes possibly dispatched ownership; remote pins stay conservative.
      }
      throw cause;
    }
    process.setDurability({
      allocated: (sequence) =>
        update((current) => ({ ...current, nextInputSequence: sequence + 1 })).then(
          () => undefined,
        ),
      acknowledged: (sequence) =>
        update((current) => ({
          ...current,
          inputAcknowledged: Math.max(current.inputAcknowledged, sequence),
        })).then(() => undefined),
      output: (sequence) =>
        update((current) => ({
          ...current,
          outputSequence: Math.max(sequence, current.outputSequence),
        })).then(() => undefined),
    });
    process.onExit(() => {
      void update((current) => ({ ...current, state: "terminal" }))
        .then(() =>
          control.registry.update((state) => ({
            ...state,
            revision: state.revision + 1,
            pins: state.pins.filter((pin) => pin.owner !== pinOwner),
          })),
        )
        .catch(() => {
          /* Failure retains the remote pin; never discard recovery evidence. */
        });
    });
    return {
      detach: () => process.detach(),
      get pid() {
        return process.pid;
      },
      write: (data) => process.write(data),
      resize: (cols, rows) => process.resize(cols, rows),
      kill: (signal) => process.kill(signal),
      onExit: (callback) => process.onExit(callback),
      onData: (callback) => {
        if (!created)
          callback(
            "\r\n[Remote terminal restored. Output history may contain a gap after server restart.]\r\n",
          );
        const removeError = process.onError((error) =>
          callback(`\r\n[Remote terminal: ${error.message}]\r\n`),
        );
        const removeData = process.onData(callback);
        return () => {
          removeError();
          removeData();
        };
      },
    };
  };
}
