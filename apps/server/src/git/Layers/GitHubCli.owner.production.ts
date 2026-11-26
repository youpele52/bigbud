import { runProcess } from "../../utils/processRunner";
import {
  classifyRemoteUrl,
  endpointMatchesTarget,
  type SshTargetEndpoint,
} from "./GitCore.fetchRoute.match.ts";
import { ordinaryGitTransport, routeEndpoint } from "./GitCore.fetchRoute.ts";
import {
  ambientTransportDenied,
  ambientTransportEnvironment,
  initiatingTransportUnavailable,
  sanitizedTransportEnvironment,
} from "./GitCore.initiatingTransport.ts";
import { bridgeOwnerGitLease } from "./GitCore.selectedStream.ts";
import {
  openProductionUploadLease,
  selectProductionGitTarget,
  type ProductionGitBindingDependencies,
} from "./GitCore.selectedStream.production.ts";
import type { GitHubCliOwnerResult, GitHubCliOwnerTransportShape } from "./GitHubCli.owner.ts";
import { requiresOwnerSshTransport } from "./GitHubCli.owner.ts";

/**
 * U7 production `gh` transport (B). Plain GitHub API verbs run locally with a sanitized
 * environment. `gh pr checkout` makes `gh` run Git, so its transport is chosen from the
 * repository's remotes before `gh` starts:
 *
 * - No remote on a bigbud SSH target: the U14 fence (HTTP(S)/file, plus SSH to third-party
 *   hosts with the user's own config, BatchMode and the sanitized environment). The owner is
 *   not involved.
 * - Exactly one remote on a bigbud target and no third-party SSH remote: one U15 owner upload
 *   lease for that remote (same target and workspace-root selection as fetch). The shim admits
 *   only that remote's exact `git-upload-pack` command, so no other SSH dial reaches the lease.
 * - Anything else (an unknown target set, an unresolvable config, several target remotes,
 *   unsupported protocols): typed refusal before `gh` starts.
 *
 * @module GitHubCli.owner.production
 */
export interface ProductionGitHubCliDependencies extends ProductionGitBindingDependencies {
  readonly targets: () => Promise<ReadonlyArray<SshTargetEndpoint> | undefined>;
  /** Test seams; production runs local Git and `gh` with a sanitized environment. */
  readonly listRemoteUrls?: (cwd: string) => Promise<ReadonlyArray<string>>;
  readonly readGitConfig?: (cwd: string, key: string) => Promise<string | undefined>;
  readonly runGh?: (
    args: ReadonlyArray<string>,
    options: {
      readonly cwd: string;
      readonly env: Record<string, string>;
      readonly timeoutMs: number;
      readonly signal: AbortSignal;
    },
  ) => Promise<GitHubCliOwnerResult>;
}

const ALL_PROTOCOLS = "http:https:file:ssh";
const LOCAL_PROTOCOLS = "http:https:file";

function defaultListRemoteUrls(cwd: string): Promise<ReadonlyArray<string>> {
  return runProcess("git", ["-C", cwd, "config", "--get-regexp", "^remote\\..*\\.url$"], {
    env: sanitizedTransportEnvironment(process.env),
    timeoutMs: 5_000,
    allowNonZeroExit: true,
  }).then((result) =>
    result.code === 0
      ? result.stdout
          .split("\n")
          .map((line) => line.slice(line.indexOf(" ") + 1).trim())
          .filter((url) => url.length > 0)
      : [],
  );
}

function defaultReadGitConfig(cwd: string, key: string): Promise<string | undefined> {
  return runProcess("git", ["-C", cwd, "config", "--get", key], {
    env: sanitizedTransportEnvironment(process.env),
    timeoutMs: 5_000,
    allowNonZeroExit: true,
  }).then((result) => (result.code === 0 ? result.stdout.trim() || undefined : undefined));
}

function defaultRunGh(
  args: ReadonlyArray<string>,
  options: Parameters<NonNullable<ProductionGitHubCliDependencies["runGh"]>>[1],
): Promise<GitHubCliOwnerResult> {
  return runProcess("gh", args, { ...options, allowNonZeroExit: true }).then((result) => ({
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code ?? -1,
  }));
}

/** The exact remote command Git sends for an upload-pack path (`sq_quote`), if unambiguous. */
export function uploadPackCommand(repositoryPath: string): string | undefined {
  return /['!]/u.test(repositoryPath) ? undefined : `git-upload-pack '${repositoryPath}'`;
}

/** `-c core.sshCommand=...` from the U14 fence, carried to `gh`'s Git as environment config. */
function configArgsAsEnvironment(configArgs: ReadonlyArray<string>): Record<string, string> {
  const pairs = configArgs.filter((_, index) => index % 2 === 1);
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) };
  for (const [index, pair] of pairs.entries()) {
    const split = pair.indexOf("=");
    env[`GIT_CONFIG_KEY_${index}`] = pair.slice(0, split);
    env[`GIT_CONFIG_VALUE_${index}`] = pair.slice(split + 1);
  }
  return env;
}

export function makeProductionGitHubCliOwnerTransport(
  dependencies: ProductionGitHubCliDependencies,
): GitHubCliOwnerTransportShape {
  const listRemoteUrls = dependencies.listRemoteUrls ?? defaultListRemoteUrls;
  const readGitConfig = dependencies.readGitConfig ?? defaultReadGitConfig;
  const runGh = dependencies.runGh ?? defaultRunGh;
  return {
    async execute(input, signal) {
      const run = (env: Record<string, string>) =>
        runGh(input.args, { cwd: input.cwd, env, timeoutMs: input.timeoutMs, signal });
      if (!requiresOwnerSshTransport(input.args)) {
        return run(sanitizedTransportEnvironment(process.env));
      }
      const refuse = () => initiatingTransportUnavailable("checkoutPullRequest", input.cwd);
      const ambient = ambientTransportEnvironment(process.env);
      if (ambient.length > 0) throw ambientTransportDenied(input.cwd, ambient);

      const urls = await listRemoteUrls(input.cwd).catch(() => undefined);
      if (!urls) throw refuse();
      const targets = await dependencies.targets().catch(() => undefined);
      const ownerUrls: string[] = [];
      let thirdPartySsh = false;
      for (const url of urls) {
        const route = classifyRemoteUrl(url);
        if (route.kind === "unsupported") throw refuse();
        if (route.kind !== "ssh") continue;
        const endpoint = await routeEndpoint(route, dependencies.resolveEndpoint);
        if (!targets || !endpoint || targets.some((t) => endpointMatchesTarget(endpoint, t))) {
          ownerUrls.push(url);
        } else {
          thirdPartySsh = true;
        }
      }

      if (ownerUrls.length === 0) {
        if (!thirdPartySsh) {
          return run(
            sanitizedTransportEnvironment(process.env, { GIT_ALLOW_PROTOCOL: LOCAL_PROTOCOLS }),
          );
        }
        const fence = await ordinaryGitTransport("ssh", input.cwd, { readGitConfig });
        return run({
          ...fence.env,
          ...configArgsAsEnvironment(fence.configArgs),
          GIT_ALLOW_PROTOCOL: ALL_PROTOCOLS,
        });
      }
      const live = dependencies.owner();
      const records = live ? await dependencies.records() : undefined;
      const ownerUrl = ownerUrls[0];
      if (!live || !records || ownerUrls.length !== 1 || thirdPartySsh || !ownerUrl) {
        throw refuse();
      }
      const selected = await selectProductionGitTarget(
        live,
        records,
        ownerUrl,
        dependencies.resolveEndpoint,
      );
      const expected = selected && uploadPackCommand(selected.repositoryPath);
      if (!selected || !expected) throw refuse();
      const stream = await bridgeOwnerGitLease(
        await openProductionUploadLease(
          live.handle.target(selected.descriptor),
          selected.workspaceRoot,
          selected.repositoryPath,
          signal,
        ),
        signal,
      );
      try {
        return await run({
          ...sanitizedTransportEnvironment(process.env),
          ...stream.env,
          GIT_ALLOW_PROTOCOL: ALL_PROTOCOLS,
          BIGBUD_GIT_STREAM_EXPECT: expected,
        });
      } finally {
        await stream.close();
      }
    },
  };
}
