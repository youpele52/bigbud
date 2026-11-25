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
import { isIP, isIPv4 } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";

import {
  assertPrivatePickerProofSocketDirectory,
  connectPickerProofAttachment,
  copyPickerProofAttachment,
  exchangePickerProofAttachmentHello,
} from "./sshOwnerPickerProof.attachment.ts";
import { makeProofAgentProxyClient } from "./sshOwnerPickerProof.client.agentProxy.ts";
import { makeProofOpencodeOwner } from "./sshOwnerPickerProof.client.opencode.ts";
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
import { validateProviderServiceStartup } from "./sshOwnerPickerProof.client.services.ts";

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
import type {
  LaunchedPickerProofOwner,
  PickerProofAttachOptions,
  PickerProofOwnerOptions,
} from "./sshOwnerPickerProof.client.types.ts";

/** Only for the private S1 proof. No product composition and no legacy SSH fallback. */
export async function startPickerProofOwner(
  options: PickerProofOwnerOptions,
): Promise<LaunchedPickerProofOwner> {
  const session = copyPickerProofSessionOptions(options);
  const { profileBinding, targetId, major } = session;
  const { binary, host, port, user, workspaceRoot } = options;
  const production = options.productionLaunch;
  if (
    ![
      binary,
      options.lockFile,
      options.sshBinary,
      options.keyscanBinary,
      options.identityFile,
      options.knownHostsFile,
    ].every(isAbsolute) ||
    (workspaceRoot !== undefined && (!isAbsolute(workspaceRoot) || workspaceRoot.includes("\0"))) ||
    (options.devInteractiveTerminal === true &&
      (process.platform !== "darwin" || workspaceRoot === undefined)) ||
    (production === undefined
      ? host !== "::1" && !(isIPv4(host) && host.startsWith("127."))
      : host.length === 0 || host.length > 255 || isIP(host) === 0) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !user
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
  validateProviderServiceStartup([options.providerService, options.opencodeService], workspaceRoot);
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
  const opencode = options.opencodeFixture && validateProofProviderFixture(options.opencodeFixture);
  if (options.opencodeService && opencode) throw new PickerProofOwnerError("invalidOperands");
  if (
    opencode &&
    (process.platform !== "linux" ||
      opencode.cwd !== workspaceRoot ||
      options.aliasConfig ||
      options.attachment ||
      provider ||
      relay ||
      agentFixture ||
      agentPath !== undefined ||
      options.devInteractiveTerminal ||
      scoped.args.length)
  )
    throw new PickerProofOwnerError("invalidOperands");
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
    ...(attachment ? { attachmentSocket: attachment.socketPath } : {}),
    aliasArgs,
    ...(agentFixture ? { agentFixture } : {}),
    ...(installed === undefined ? {} : { installedAgentState: installed }),
    ...(agentPath === undefined ? {} : { identityAgentPath: agentPath }),
    ...(provider ? { provider: { ...provider, codex: codex !== undefined } } : {}),
    ...(opencode ? { opencode } : {}),
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
      !production && Boolean(attachment && options.devInteractiveTerminal),
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
    executeProofOpencode,
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
  return Object.assign(
    owner,
    makeProofCodexClient(
      targetId,
      codex,
      pipe.takeAgentProxyPipes,
      executeProofAgentProxy,
      (runtime) => probeProofProvider("codex", runtime),
    ),
    {
      ...(opencode || options.opencodeService
        ? {
            opencodeOwner: makeProofOpencodeOwner(
              targetId,
              opencode,
              options.opencodeService?.binaryPath,
              opencodeBinding,
              executeProofOpencode,
            ),
          }
        : {}),
      openPeerRelay: makeProofPeerRelay(
        targetId,
        scoped.peer,
        { host, port, user },
        pipe.takeAgentProxyPipes,
        executeProofAgentProxy,
      ),
      openGitUpload: makeProofGitUpload(
        targetId,
        scoped.gitUpload,
        pipe.takeAgentProxyPipes,
        executeProofAgentProxy,
      ),
      openGitAdvertisement: makeProofGitAdvertisement(
        targetId,
        scoped.git,
        pipe.takeAgentProxyPipes,
        executeProofAgentProxy,
      ),
      piRpcOwner: makeProofPiClient(
        targetId,
        pi,
        options.providerService?.kind === "pi" ? options.providerService.binaryPath : undefined,
        pipe.takeAgentProxyPipes,
        executeProofAgentProxy,
        (runtime) => probeProofProvider("pi", runtime),
      ),
      runAgentAction: executeAgentAction,
      openProofAgentProxy: makeProofAgentProxyClient(
        targetId,
        agentFixture,
        pipe.takeAgentProxyPipes,
        executeProofAgentProxy,
      ),
      openClientRelay: makeProofClientRelay(
        targetId,
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
            targetId,
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
      exchangePickerProofAttachmentHello(pipe, capability, session.profileBinding, session.major),
    undefined,
    pipe.onLost,
  );
  return owner;
}
