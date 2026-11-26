import { randomBytes } from "node:crypto";

import type { SshOwnerTargetDescriptor } from "../../ssh/sshOwnerProductionClient.launch.ts";
import type { SshOwnerProductionRegistration } from "../../ssh/sshOwnerProductionRegistry.ts";
import {
  gitUploadAdmits,
  isExactRemotePath,
} from "../../ssh/sshOwnerPickerProof.codec.gitUpload.ts";
import { runProcess } from "../../utils/processRunner";
import {
  initiatingTransportUnavailable,
  sanitizedTransportEnvironment,
  type InitiatingFetchBinding,
} from "./GitCore.initiatingTransport.ts";
import {
  endpointServesTarget,
  parseSshRemoteSpec,
  resolveSshEndpoint,
  type ResolvedSshEndpoint,
} from "./GitCore.remoteEndpoint.ts";
import { openOwnerSocketLease } from "./GitCore.ownerSocketLease.ts";
import {
  fetchOverOwnerStream,
  type OwnerGitStreamLease,
  type OwnerGitStreamSession,
} from "./GitCore.selectedStream.ts";
import type { SshTargetRecord } from "./GitCore.targetRecords.ts";

/**
 * U15 production owner Git binding. For a remote on a bigbud SSH target it picks the exact
 * target (host spelling, user and port all equal to the owner descriptor), the longest
 * workspace root of that target that contains the repository, and opens the owner's
 * read-only upload lease. Anything ambiguous is a typed refusal; nothing falls back to
 * ambient SSH.
 *
 * @module GitCore.selectedStream.production
 */

export interface ProductionGitBindingDependencies {
  readonly owner: () => SshOwnerProductionRegistration | undefined;
  readonly records: () => Promise<ReadonlyArray<SshTargetRecord> | undefined>;
  readonly resolveRemoteUrl?: (cwd: string, remoteName: string) => Promise<string>;
  /** Test seam; production reads `~/.ssh/config`. */
  readonly resolveEndpoint?: typeof resolveSshEndpoint;
}

type BoundTarget = ReturnType<SshOwnerProductionRegistration["handle"]["target"]>;

function defaultResolveRemoteUrl(cwd: string, remoteName: string): Promise<string> {
  return runProcess("git", ["-C", cwd, "remote", "get-url", remoteName], {
    env: sanitizedTransportEnvironment(process.env),
    timeoutMs: 5_000,
  }).then((result) => result.stdout.trim());
}

/** The exact target, descriptor and workspace root one remote URL is served by. */
export interface ProductionGitSelection {
  readonly targetId: string;
  readonly descriptor: SshOwnerTargetDescriptor;
  readonly workspaceRoot: string;
  readonly repositoryPath: string;
  readonly endpoint: ResolvedSshEndpoint;
}

/**
 * Pick the target that serves `url` (ssh:// or scp form, host resolved through `~/.ssh/config`,
 * dialled host/user/port equal to the descriptor) and the longest workspace root of that target
 * containing the absolute repository path. `undefined` means refuse; nothing falls back.
 */
export async function selectProductionGitTarget(
  live: SshOwnerProductionRegistration,
  records: ReadonlyArray<SshTargetRecord>,
  url: string,
  resolveEndpoint: typeof resolveSshEndpoint = resolveSshEndpoint,
): Promise<ProductionGitSelection | undefined> {
  const spec = parseSshRemoteSpec(url);
  if (!spec || !isExactRemotePath(spec.path)) return undefined;
  // U17: a config that cannot be evaluated is refused, never read as the literal spelling.
  const endpoint = await resolveEndpoint(spec).catch(() => "refused" as const);
  if (endpoint === "refused") return undefined;
  for (const targetId of new Set(records.map((record) => record.executionTargetId))) {
    const descriptor = await live.descriptorFor(targetId).catch(() => undefined);
    if (!descriptor || !endpointServesTarget(endpoint, targetId, descriptor)) continue;
    const workspaceRoot = workspaceRootFor(
      records
        .filter((record) => record.executionTargetId === targetId)
        .map((record) => record.workspaceRoot),
      spec.path,
    );
    return workspaceRoot
      ? { targetId, descriptor, workspaceRoot, repositoryPath: spec.path, endpoint }
      : undefined;
  }
  return undefined;
}

/** The longest workspace root that admits the repository (owner rule mirrored). */
export function workspaceRootFor(
  roots: ReadonlyArray<string | null>,
  repositoryPath: string,
): string | undefined {
  return roots
    .filter((root): root is string => root !== null && gitUploadAdmits(root, repositoryPath))
    .toSorted((left, right) => right.length - left.length)[0];
}

/** One owner upload lease exposed as the stream lease `openOwnerGitStream` bridges. */
export function openProductionUploadLease(
  bound: BoundTarget,
  workspaceRoot: string,
  repositoryPath: string,
  signal: AbortSignal,
): Promise<OwnerGitStreamLease> {
  const lease = randomBytes(32);
  return openOwnerSocketLease(
    {
      open: () => bound.openGitUpload(lease, workspaceRoot, repositoryPath),
      status: () => bound.gitUploadStatus(lease),
      close: () => bound.closeGitUpload(lease),
    },
    "upload",
    signal,
  );
}

function productionSession(
  live: SshOwnerProductionRegistration,
  targetId: string,
  descriptor: SshOwnerTargetDescriptor,
  workspaceRoot: string,
): OwnerGitStreamSession {
  return {
    targetId,
    withClient: (operation, signal) =>
      operation({
        openGitUpload: (input, innerSignal) =>
          openProductionUploadLease(
            live.handle.target(descriptor),
            workspaceRoot,
            input.repositoryPath,
            innerSignal ?? signal,
          ),
      }),
  };
}

export function makeProductionInitiatingFetchBinding(
  dependencies: ProductionGitBindingDependencies,
): InitiatingFetchBinding {
  const resolveRemoteUrl = dependencies.resolveRemoteUrl ?? defaultResolveRemoteUrl;
  return {
    async fetch(operands, signal) {
      const refuse = () => initiatingTransportUnavailable("fetch", operands.cwd);
      const live = dependencies.owner();
      if (!live) throw refuse();
      const url = await resolveRemoteUrl(operands.cwd, operands.remoteName).catch(() => "");
      const records = url ? await dependencies.records() : undefined;
      const selected =
        records &&
        (await selectProductionGitTarget(live, records, url, dependencies.resolveEndpoint));
      if (!selected) throw refuse();
      const session = productionSession(
        live,
        selected.targetId,
        selected.descriptor,
        selected.workspaceRoot,
      );
      return fetchOverOwnerStream(session, selected.repositoryPath, operands, signal);
    },
  };
}
