import type { ProjectId } from "@bigbud/contracts/core/baseSchemas.ts";
import { Effect, Option } from "effect";
import type { ProjectionProjectRepositoryShape } from "../persistence/Services/ProjectionProjects.ts";
import { sampleSshMonitor } from "../ssh/sshMonitor.ts";
import {
  isConnectedSshMonitorTarget,
  isHealthySshMonitorTarget,
  recordSshMonitorSample,
  sshMonitorLease,
} from "../ssh/sshMonitor.connections.ts";
import { validSshMonitorTarget } from "../ssh/sshMonitor.target.ts";

function activeTarget(project: {
  workspaceExecutionTargetId: string;
  deletingAt: string | null;
  deletedAt: string | null;
}): string | null {
  const target = project.workspaceExecutionTargetId;
  return !project.deletedAt && !project.deletingAt && validSshMonitorTarget(target) ? target : null;
}

/** Project id is resolved from persistence; the caller never chooses the SSH argv target. */
export const sampleSshMonitorEffect = Effect.fn("sampleSshMonitorEffect")(function* (
  input: { projectId: ProjectId },
  projects: ProjectionProjectRepositoryShape,
  callerId: string,
) {
  const project = yield* projects
    .getById({ projectId: input.projectId })
    .pipe(Effect.mapError(() => "SSH monitor project lookup failed"));
  const target = Option.isSome(project) ? activeTarget(project.value) : null;
  const lease = target ? sshMonitorLease(target, callerId) : null;
  if (!target || !lease)
    return yield* Effect.fail("SSH monitor requires a connected saved workspace");
  const snapshot = yield* Effect.tryPromise({
    try: async () => {
      if (
        !(await isConnectedSshMonitorTarget(target, callerId)) ||
        !isHealthySshMonitorTarget(target, callerId, lease)
      )
        throw new Error("SSH monitor connection unavailable");
      return sampleSshMonitor(target);
    },
    catch: (error) =>
      error instanceof Error && error.message.startsWith("Unsupported remote OS:")
        ? error.message
        : "SSH monitor unavailable. Check the connection and retry.",
  });
  const current = yield* projects
    .getById({ projectId: input.projectId })
    .pipe(Effect.mapError(() => "SSH monitor project lookup failed"));
  if (
    Option.isNone(current) ||
    Option.isNone(project) ||
    activeTarget(current.value) !== target ||
    current.value.createdAt !== project.value.createdAt ||
    current.value.updatedAt !== project.value.updatedAt ||
    !isHealthySshMonitorTarget(target, callerId, lease)
  )
    return yield* Effect.fail("SSH monitor workspace or connection changed during sampling");
  recordSshMonitorSample(target, snapshot.sampledAtMs, callerId, lease);
  if (!isHealthySshMonitorTarget(target, callerId, lease))
    return yield* Effect.fail("SSH monitor connection changed during sampling");
  return JSON.stringify(snapshot);
});

/** Shared verified-target health is authoritative across renderer tabs and reconnects. */
export const listConnectedSshMonitorsEffect = Effect.fn("listConnectedSshMonitorsEffect")(
  function* (projects: ProjectionProjectRepositoryShape, callerId: string) {
    const rows = yield* projects
      .listAll()
      .pipe(Effect.mapError(() => "SSH monitor project lookup failed"));
    const targets = [
      ...new Set(
        rows
          .map(activeTarget)
          .filter(
            (target): target is string =>
              target !== null && sshMonitorLease(target, callerId) !== null,
          ),
      ),
    ];
    const connected = yield* Effect.tryPromise({
      try: async () => {
        const connected: string[] = [];
        for (let i = 0; i < targets.length; i += 4) {
          const group = targets.slice(i, i + 4);
          const states = await Promise.all(
            group.map((target) => isConnectedSshMonitorTarget(target, callerId)),
          );
          for (let j = 0; j < group.length; j++) if (states[j]) connected.push(group[j]!);
        }
        return connected;
      },
      catch: () => "SSH monitor connection discovery unavailable",
    });
    // A project may have been deleted or retargeted while health checks were in flight.
    const current = yield* projects
      .listAll()
      .pipe(Effect.mapError(() => "SSH monitor project lookup failed"));
    const healthy = new Set(connected);
    return current.flatMap((project) => {
      const target = activeTarget(project);
      return target && healthy.has(target) && sshMonitorLease(target, callerId) !== null
        ? [{ projectId: project.projectId, name: project.title, target }]
        : [];
    });
  },
);
