import { Effect, Layer, Option, Schema } from "effect";
import { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";

import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { parseSshExecutionTarget } from "../../ssh/sshExecutionTarget.ts";
import { resolveProductionTargetDescriptor } from "../../ssh/sshOwnerProductionTargets.ts";
import {
  InitiatingFetchOwner,
  initiatingTransportUnavailable,
  type InitiatingFetchOperands,
} from "./GitCore.initiatingTransport.ts";
import { routeSelectedFetch } from "./GitCore.fetchRoute.ts";
import type { SshTargetEndpoint } from "./GitCore.fetchRoute.match.ts";
import { resolveSshEndpoint } from "./GitCore.remoteEndpoint.ts";
import type { GitHelpers } from "./GitCoreExecutor.ts";
import { registerSshTargetRecordSource } from "./GitCore.targetRecords.ts";

interface ResolvedEndpoint {
  readonly host: string;
  readonly user: string;
  readonly port: number;
}

/**
 * Endpoints of every bigbud SSH execution target. An alias target contributes both the alias
 * and the HostName, User and Port the user's SSH config resolves it to (config only, so a
 * credential problem cannot hide its HostName); a structured target its own fields, completed
 * by the exact owner descriptor when resolvable. `undefined` (an unknown set, so SSH remotes
 * fail closed to the owner path) when an alias target's config cannot be evaluated (U17).
 */
export async function sshTargetEndpointsOf(
  executionTargetIds: Iterable<string>,
  resolve: (targetId: string) => Promise<ResolvedEndpoint | undefined> = (targetId) =>
    resolveProductionTargetDescriptor(targetId).then(
      ({ host, user, port }) => ({ host, user, port }),
      () => undefined,
    ),
  resolveAlias: typeof resolveSshEndpoint = resolveSshEndpoint,
): Promise<ReadonlyArray<SshTargetEndpoint> | undefined> {
  const endpoints: SshTargetEndpoint[] = [];
  for (const targetId of new Set(executionTargetIds)) {
    const target = parseSshExecutionTarget(targetId);
    if (!target) continue;
    if (!target.executionTargetId.includes("=")) {
      const alias = await resolveAlias({ host: target.host.toLowerCase() }).catch(
        () => "refused" as const,
      );
      if (alias === "refused") return undefined;
      endpoints.push(alias);
      continue;
    }
    const resolved = await resolve(targetId);
    const hosts = [target.host.toLowerCase()];
    if (resolved && !hosts.includes(resolved.host.toLowerCase()))
      hosts.push(resolved.host.toLowerCase());
    const user = target.user ?? resolved?.user;
    const port = target.port !== undefined ? Number(target.port) : resolved?.port;
    endpoints.push({
      hosts,
      ...(user ? { user } : {}),
      ...(port !== undefined && Number.isInteger(port) ? { port } : {}),
    });
  }
  return endpoints;
}

type TargetIdSource = () => Promise<ReadonlyArray<string>>;
let registeredSource: TargetIdSource | undefined;

/**
 * Process-wide source of bigbud target ids, registered by the server composition where the
 * project projection lives. Shared caches (background upstream refresh) run their lookups in
 * the Git layer's construction context, which need not carry the projection service.
 */
export function registerSshTargetIdSource(source: TargetIdSource): () => void {
  registeredSource = source;
  return () => {
    if (registeredSource === source) registeredSource = undefined;
  };
}

const liveIds = (projects: ReadonlyArray<{ executionTargetId: unknown; deletedAt: unknown }>) =>
  projects.filter((project) => project.deletedAt === null).map((p) => String(p.executionTargetId));

/** Server layer: publishes the projection as the target id source for its lifetime. */
export const SshTargetIdSourceLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const repository = yield* ProjectionProjectRepository;
    const services = yield* Effect.services<never>();
    const unregister = registerSshTargetIdSource(() =>
      Effect.runPromiseWith(services)(repository.listAll().pipe(Effect.map(liveIds))),
    );
    const unregisterRecords = registerSshTargetRecordSource(() =>
      Effect.runPromiseWith(services)(
        repository.listAll().pipe(
          Effect.map((projects) =>
            projects
              .filter((project) => project.deletedAt === null)
              .map((project) => ({
                executionTargetId: String(project.executionTargetId),
                workspaceRoot: project.workspaceRoot,
              })),
          ),
        ),
      ),
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unregister();
        unregisterRecords();
      }),
    );
  }),
);

/** Target endpoints at call time; `undefined` (fail closed) when no source can be read. */
export const readSshTargets = Effect.fn("readSshTargets")(function* () {
  const repository = yield* Effect.serviceOption(ProjectionProjectRepository);
  const source: TargetIdSource | undefined = Option.isSome(repository)
    ? () => Effect.runPromise(repository.value.listAll().pipe(Effect.map(liveIds)))
    : registeredSource;
  if (!source) return undefined;
  return yield* Effect.promise(() =>
    source().then(
      (ids) => sshTargetEndpointsOf(ids),
      () => undefined,
    ),
  );
});

/**
 * Product helper for every selected-mode fetch (explicit, background, pull, PR): routes by
 * remote transport and target ownership (`routeSelectedFetch`).
 */
export const fetchThroughSelectedRoute = Effect.fn("fetchThroughSelectedRoute")(function* (
  operands: InitiatingFetchOperands,
  runGitStdout: GitHelpers["runGitStdout"],
) {
  // Resolved through the workspace Git executor (a fenced local builtin), so URL rewriting by
  // `insteadOf` is applied exactly as the fetch would see it.
  const url = (yield* runGitStdout("GitCore.initiating.remoteUrl", operands.cwd, [
    "remote",
    "get-url",
    operands.remoteName,
  ])).trim();
  const owner = Option.getOrUndefined(yield* Effect.serviceOption(InitiatingFetchOwner));
  const services = yield* Effect.services<never>();
  const targets = () => Effect.runPromiseWith(services)(readSshTargets());
  yield* Effect.tryPromise({
    try: (signal) =>
      routeSelectedFetch({ operands, owner, targets }, signal, {
        resolveRemoteUrl: async () => url,
      }),
    catch: (cause) =>
      Schema.is(GitCommandError)(cause)
        ? cause
        : initiatingTransportUnavailable("fetch", operands.cwd),
  });
  return "fetched" as const;
});
