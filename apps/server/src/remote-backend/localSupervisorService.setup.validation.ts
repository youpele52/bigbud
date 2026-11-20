import * as fs from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { ownershipStateDir } from "@bigbud/shared/backendOwnership.paths";
import {
  remoteAgentTargetArchitecture,
  verifyRemoteAgentArtifactSignature,
} from "@bigbud/shared/remoteAgentArtifact";
import { parseRemoteAgentInstallSource } from "../remote-agent/remoteAgentInstallManager.ts";
import type { LocalSupervisorPreflightContext } from "./localSupervisorService.preflight.ts";
import { projectVerifiedBackendGraph } from "./backendGraph.ts";
import { assertLocalSupervisorServiceDirectory } from "./localSupervisorService.files.ts";
import { labelPrivatePermission } from "./privatePermission.ts";
import {
  SERVICE_SETUP_REQUEST_ID,
  type LocalSupervisorServiceSetupInput,
} from "./localSupervisorService.setup.types.ts";
export interface SetupAccount {
  readonly home: string;
  readonly operatingSystem: string;
  readonly architecture: string;
  readonly uid: number;
}
export const within = (root: string, path: string) => {
  const r = relative(root, path);
  return r !== ".." && !r.startsWith("../") && !isAbsolute(r);
};
export function assertSetupGraphSeparation(
  graphRoot: string,
  mutableRoots: ReadonlyArray<string>,
): void {
  if (mutableRoots.some((path) => within(graphRoot, path) || within(path, graphRoot)))
    throw new Error("Backend graph must remain outside mutable account/runtime state.");
}
export async function requireMissingServicePath(path: string) {
  try {
    await fs.lstat(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
  throw new Error(
    "Existing service state must be inspected explicitly; setup never overwrites or repairs it.",
  );
}
export async function validateServiceSetup(
  context: LocalSupervisorPreflightContext,
  input: LocalSupervisorServiceSetupInput,
  account: SetupAccount,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  await context.owner.assertHeld();
  if (
    input.confirmFreshSetup !== true ||
    typeof input.restart !== "boolean" ||
    !SERVICE_SETUP_REQUEST_ID.test(input.requestId) ||
    input.rustSource.allowUntrustedDevelopmentArtifact
  )
    throw new Error(
      "Explicit fresh setup, a request UUID and signed-only Rust source are required.",
    );
  if (
    account.operatingSystem !== "linux" ||
    account.uid === 0 ||
    account.uid !== process.getuid?.()
  )
    throw new Error("Account setup requires the actual unprivileged Linux account.");
  const home = await fs.realpath(account.home),
    backendHome = await fs.realpath(input.backendHome);
  if (
    backendHome !== input.backendHome ||
    ownershipStateDir(backendHome, false) !== context.owner.stateDir
  )
    throw new Error("Backend home does not select the actual locked state directory.");
  await labelPrivatePermission("account home directory", () =>
    assertLocalSupervisorServiceDirectory(home, [0o700, 0o750, 0o755]),
  );
  await labelPrivatePermission("backend home directory (--backend-home)", () =>
    assertLocalSupervisorServiceDirectory(backendHome),
  );
  const graph = await projectVerifiedBackendGraph(input.graph, signal);
  const architecture =
    account.architecture === "arm64" ? "aarch64" : account.architecture === "x64" ? "x86_64" : null;
  if (
    !architecture ||
    !graph.target.startsWith(architecture + "-") ||
    !graph.target.endsWith("-linux-gnu")
  )
    throw new Error("Backend graph does not match this Linux account platform.");
  const rustSource = parseRemoteAgentInstallSource(structuredClone(input.rustSource));
  const candidates = rustSource.manifest.artifacts.filter(
    (a) => remoteAgentTargetArchitecture(a.targetTriple) === architecture,
  );
  if (!candidates.length) throw new Error("No compatible signed Rust artifact was supplied.");
  for (const artifact of candidates)
    verifyRemoteAgentArtifactSignature(artifact, rustSource.trustStore);
  const authority = context.identity.authority.authorityId;
  const agentRoot = join(home, ".bigbud/agent"),
    configRoot = join(home, ".bigbud/backend-services", authority);
  assertSetupGraphSeparation(graph.root, [
    backendHome,
    context.owner.stateDir,
    configRoot,
    agentRoot,
  ]);
  await requireMissingServicePath(configRoot);
  signal.throwIfAborted();
  await context.owner.assertHeld();
  return Object.freeze({
    home,
    backendHome,
    configRoot,
    configPath: join(configRoot, "config-v1"),
    target: `remote-backend:${authority}`,
    rustSource,
    graph,
  });
}
