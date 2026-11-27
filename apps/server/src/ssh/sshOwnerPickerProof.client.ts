import { scopedProofStartup } from "./sshOwnerPickerProof.client.scopedStartup.ts";
import {
  makeProofPeerRelay,
  makeProofGitAdvertisement,
  makeProofGitUpload,
} from "./sshOwnerPickerProof.client.scopedDuplex.ts";
import { makeProofPiClient } from "./sshOwnerPickerProof.client.pi.ts";
import { makeProofCodexClient } from "./sshOwnerPickerProof.client.codex.ts";
import { validateProofProviderFixture } from "./sshOwnerPickerProof.codec.provider.ts";

import { makeProofClientRelay } from "./sshOwnerPickerProof.client.relay.ts";
import { isIPv4 } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";

import {
  assertPrivatePickerProofSocketDirectory,
  connectPickerProofAttachment,
  copyPickerProofAttachment,
  exchangePickerProofAttachmentHello,
} from "./sshOwnerPickerProof.attachment.ts";
import { makeProofAgentProxyClient } from "./sshOwnerPickerProof.client.agentProxy.ts";
import { makeProviderServicePorts } from "./sshOwnerPickerProof.client.providerPorts.ts";
import { proofAliasStartupArgs } from "./sshOwnerPickerProof.client.alias.ts";
import { pickerProofLaunchArgs } from "./sshOwnerPickerProof.client.args.ts";
import { copyPickerProofSessionOptions } from "./sshOwnerPickerProof.client.options.ts";
import {
  openPickerProofSession,
  type PickerProofOwner,
} from "./sshOwnerPickerProof.client.session.ts";
import {
  validateProofAgentFixture,
  validateProofRelayFixture,
} from "./sshOwnerPickerProof.codec.agentProxy.ts";
import {
  encodeHello,
  encodeRequest,
  PickerProofOwnerError,
  type PickerProofOperation,
} from "./sshOwnerPickerProof.codec.ts";
import { makePickerProofOwnerLifecycle } from "./sshOwnerPickerProof.client.lifecycle.ts";
import { throwPickerProofStartupError } from "./sshOwnerPickerProof.client.startupError.ts";
import { spawnPickerProofPipe } from "./sshOwnerPickerProof.pipe.ts";
import { sshOwnerBindingTiedToLauncher } from "./sshOwnerProfileLifetime.ts";
import {
  validateOpencodeV2ServiceStartup,
  validateProviderServiceStartup,
} from "./sshOwnerPickerProof.client.services.ts";

export type { PickerProofOwner } from "./sshOwnerPickerProof.client.session.ts";
export type {
  PickerProofWorkspaceGitAction,
  PickerProofWorkspaceGitInput,
  PickerProofWorkspaceGitResult,
} from "./sshOwnerPickerProof.codec.git.ts";
export type {
  PickerProofWorkspaceContentMatches,
  PickerProofWorkspaceContentSearchInput,
  PickerProofWorkspaceDirectory,
  PickerProofWorkspaceFile,
  PickerProofWorkspaceIndex,
  PickerProofWorkspaceIndexInput,
  PickerProofWorkspaceListInput,
  PickerProofWorkspaceReadInput,
  PickerProofWorkspaceWriteInput,
} from "./sshOwnerPickerProof.codec.workspace.ts";
export type { PickerProofTerminalReservation } from "./sshOwnerPickerProof.client.terminal.ts";
export type {
  PickerProofPrepareTerminalInput,
  PickerProofTerminal,
} from "./sshOwnerPickerProof.codec.terminal.ts";
export { PickerProofOwnerError };
export type { PickerProofOwnerErrorCode } from "./sshOwnerPickerProof.codec.ts";
export type {
  LaunchedPickerProofOwner,
  PickerProofAttachOptions,
  PickerProofOwnerOptions,
} from "./sshOwnerPickerProof.client.types.ts";

/** The pinned fixture target facts; a production owner has none. */
function fixtureTarget(options: PickerProofOwnerOptions) {
  const { targetId, host, port, user, identityFile, knownHostsFile } = options;
  if (
    targetId === undefined ||
    host === undefined ||
    port === undefined ||
    user === undefined ||
    identityFile === undefined ||
    knownHostsFile === undefined ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    user.length === 0
  ) {
    throw new PickerProofOwnerError("invalidOperands");
  }
  return { targetId, host, port, user, identityFile, knownHostsFile };
}
import type {
  LaunchedPickerProofOwner,
  PickerProofAttachOptions,
  PickerProofOwnerOptions,
} from "./sshOwnerPickerProof.client.types.ts";

// Fixture-only peer relay startup facts. In production mode no peer fixture can
// be selected, so these placeholders never reach an SSH launch.
const FIXTURE_PEER = { host: "127.0.0.1", port: 1, user: "owner" } as const;

/** Only for the private S1 proof. No product composition and no legacy SSH fallback. */
export async function startPickerProofOwner(
  options: PickerProofOwnerOptions,
): Promise<LaunchedPickerProofOwner> {
  const session = copyPickerProofSessionOptions(options);
  const { profileBinding, targetId, major } = session;
  const { binary, workspaceRoot } = options;
  const production = options.productionLaunch;
  const fixture = production === undefined ? fixtureTarget(options) : undefined;
  if (
    ![
      binary,
      options.lockFile,
      options.sshBinary,
      options.keyscanBinary,
      ...(fixture === undefined ? [] : [fixture.identityFile, fixture.knownHostsFile]),
    ].every(isAbsolute) ||
    (workspaceRoot !== undefined && (!isAbsolute(workspaceRoot) || workspaceRoot.includes("\0"))) ||
    (options.devInteractiveTerminal === true &&
      (process.platform !== "darwin" || workspaceRoot === undefined)) ||
    (fixture !== undefined &&
      fixture.host !== "::1" &&
      !(isIPv4(fixture.host) && fixture.host.startsWith("127."))) ||
    (fixture === undefined &&
      (options.host !== undefined || options.port !== undefined || options.user !== undefined))
  )
    throw new PickerProofOwnerError("invalidOperands");
  const agentFixture =
    options.agentProxyFixture && validateProofAgentFixture(options.agentProxyFixture);
  const relay = options.clientRelayFixture && validateProofRelayFixture(options.clientRelayFixture);
  if (relay && (process.platform !== "linux" || agentFixture || options.attachment)) {
    throw new PickerProofOwnerError("invalidOperands");
  }
  const codex = options.codexFixture && validateProofProviderFixture(options.codexFixture);
  const pi = options.piFixture && validateProofProviderFixture(options.piFixture);
  const provider = codex ?? pi;
  validateProviderServiceStartup([options.providerService], workspaceRoot);
  validateOpencodeV2ServiceStartup(
    options.opencodeV2Service,
    workspaceRoot,
    production !== undefined,
  );
  const productionAgent = options.agentService;
  if (
    productionAgent !== undefined &&
    (production === undefined ||
      process.platform === "win32" ||
      !isAbsolute(productionAgent.binaryPath) ||
      productionAgent.binaryPath.includes("\0") ||
      !/^[a-f0-9]{64}$/.test(productionAgent.sha256) ||
      !isAbsolute(productionAgent.stateDir) ||
      productionAgent.stateDir.includes("\0"))
  ) {
    throw new PickerProofOwnerError("invalidOperands");
  }
  if (
    options.providerService?.kind !== undefined &&
    options.providerService.kind !== "pi" &&
    options.providerService.kind !== "codex"
  ) {
    throw new PickerProofOwnerError("invalidOperands");
  }
  if (options.providerService && provider) throw new PickerProofOwnerError("invalidOperands");
  if (
    (codex && pi) ||
    (provider &&
      (process.platform !== "linux" ||
        provider.cwd !== workspaceRoot ||
        agentFixture ||
        relay ||
        options.attachment))
  ) {
    throw new PickerProofOwnerError("invalidOperands");
  }
  const agentPath = options.identityAgentPath;
  if (
    agentPath !== undefined &&
    (process.platform === "win32" || !isAbsolute(agentPath) || agentPath.includes("\0"))
  ) {
    throw new PickerProofOwnerError("invalidOperands");
  }
  const scoped = scopedProofStartup(options);
  const aliasArgs = proofAliasStartupArgs(options.aliasConfig);
  if (
    options.opencodeV2Service !== undefined &&
    production === undefined &&
    targetId === undefined
  ) {
    // A pinned fixture target owns exactly one v2 listener; a multi-target
    // production owner binds its own per-target client from the handle.
    throw new PickerProofOwnerError("invalidOperands");
  }
  if (
    scoped.args.length &&
    (provider ||
      relay ||
      agentFixture ||
      (options.attachment && !options.posixPickerMaster) ||
      (options.posixWorkspaceSnapshotCancellation
        ? !workspaceRoot || options.attachment
        : workspaceRoot !== undefined || options.aliasConfig || options.devInteractiveTerminal) ||
      agentPath !== undefined)
  )
    throw new PickerProofOwnerError("invalidOperands");
  const installed = options.installedAgentStateDir;
  if (
    installed !== undefined &&
    (process.platform !== "linux" ||
      !agentFixture ||
      !isAbsolute(installed) ||
      installed.includes("\0"))
  ) {
    throw new PickerProofOwnerError("invalidOperands");
  }
  const attachment = options.attachment && copyPickerProofAttachment(options.attachment);
  if (attachment) await assertPrivatePickerProofSocketDirectory(attachment.socketPath);
  const launchArgs = pickerProofLaunchArgs(options, {
    profileBindingHex: profileBinding.toString("hex"),
    ...(fixture === undefined ? {} : { target: fixture }),
    ...(attachment ? { attachmentSocket: attachment.socketPath } : {}),
    aliasArgs,
    ...(agentFixture ? { agentFixture } : {}),
    ...(installed === undefined ? {} : { installedAgentState: installed }),
    ...(agentPath === undefined ? {} : { identityAgentPath: agentPath }),
    ...(provider ? { provider: { ...provider, codex: codex !== undefined } } : {}),
    ...(relay ? { relay } : {}),
    scopedArgs: scoped.args,
  });
  let pipe: ReturnType<typeof spawnPickerProofPipe>;
  try {
    pipe = spawnPickerProofPipe(
      binary,
      launchArgs,
      dirname(options.lockFile),
      !production &&
        (agentFixture !== undefined ||
          relay !== undefined ||
          provider !== undefined ||
          options.providerService !== undefined ||
          scoped.peer !== undefined ||
          scoped.git !== undefined ||
          scoped.gitUpload !== undefined),
      !production && scoped.pickerCancellation,
      // FD 3 lifetime socket: supervised dev terminals, and non-surviving production owners.
      production
        ? sshOwnerBindingTiedToLauncher(production.profileBindingText)
        : Boolean(attachment && options.devInteractiveTerminal),
      production === undefined
        ? {}
        : {
            environment: {},
            clearEnvironment: true,
            startupDeadlineMs: production.startupDeadlineMs,
          },
    );
  } catch {
    throw new PickerProofOwnerError("ownerUnavailable");
  }

  const {
    owner,
    stopAdmission,
    executeProofAgentProxy,
    probeProofProvider,
    executeProofOperation,
    opencodeBinding,
    executeAgentAction,
  } = await openPickerProofSession(
    pipe,
    session,
    () => pipe.exchange(encodeHello(profileBinding, major, attachment?.capability)),
    scoped.pickerCancellation ? pipe.sendPickerCancellation : undefined,
    pipe.onLost,
  )
    .then((session) => {
      pipe.sealStartup();
      return session;
    })
    .catch((error: unknown) => {
      pipe.sealStartup();
      throwPickerProofStartupError(error, pipe, options.productionLaunch?.startupDeadlineMs);
    });
  pipe.sealStartupConfigDiagnostic();
  const providerPorts = makeProviderServicePorts({
    targetId,
    options,
    binding: opencodeBinding,
    executeOperation: executeProofOperation,
  });
  return Object.assign(
    owner,
    makeProofCodexClient(
      targetId ?? "",
      codex,
      pipe.takeAgentProxyPipes,
      executeProofAgentProxy,
      (runtime) => probeProofProvider("codex", runtime),
    ),
    {
      ...providerPorts,
      openPeerRelay: makeProofPeerRelay(
        targetId ?? "",
        scoped.peer,
        fixture ?? FIXTURE_PEER,
        pipe.takeAgentProxyPipes,
        executeProofAgentProxy,
      ),
      openGitUpload: makeProofGitUpload(
        targetId ?? "",
        scoped.gitUpload,
        pipe.takeAgentProxyPipes,
        executeProofAgentProxy,
      ),
      openGitAdvertisement: makeProofGitAdvertisement(
        targetId ?? "",
        scoped.git,
        pipe.takeAgentProxyPipes,
        executeProofAgentProxy,
      ),
      piRpcOwner: makeProofPiClient(
        targetId ?? "",
        pi,
        options.providerService?.kind === "pi" ? options.providerService.binaryPath : undefined,
        pipe.takeAgentProxyPipes,
        executeProofAgentProxy,
        (runtime) => probeProofProvider("pi", runtime),
      ),
      runAgentAction: executeAgentAction,
      openProofAgentProxy: makeProofAgentProxyClient(
        targetId ?? "",
        agentFixture,
        pipe.takeAgentProxyPipes,
        executeProofAgentProxy,
      ),
      openClientRelay: makeProofClientRelay(
        targetId ?? "",
        relay,
        pipe.takeAgentProxyPipes,
        executeProofAgentProxy,
      ),
      async issueProofGrantForTest(operation: PickerProofOperation) {
        const requestId = randomBytes(16);
        const reply = await pipe.exchange(
          encodeRequest({
            requestId,
            ownerEpoch: owner.ownerEpoch,
            generation: owner.targetGeneration,
            targetId: targetId ?? "",
            operation,
          }),
        );
        if (reply.kind !== "grantReply" || !Buffer.from(reply.requestId).equals(requestId)) {
          throw new PickerProofOwnerError("protocolError");
        }
        return reply.error === 0 ? undefined : reply.error;
      },
      ...makePickerProofOwnerLifecycle(pipe, stopAdmission),
    },
  );
}

/** Authenticate the surviving S1 proof owner without spawning or falling back. */
export async function attachPickerProofOwner(
  options: PickerProofAttachOptions,
): Promise<PickerProofOwner> {
  const session = copyPickerProofSessionOptions(options);
  const { socketPath, capability } = copyPickerProofAttachment(options);
  const pipe = await connectPickerProofAttachment(socketPath);
  const { owner } = await openPickerProofSession(
    pipe,
    session,
    () =>
      exchangePickerProofAttachmentHello(
        pipe,
        capability,
        session.profileBinding,
        session.major,
        options.expectedArtifactIdentity,
      ),
    undefined,
    pipe.onLost,
  );
  return owner;
}
