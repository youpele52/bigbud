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
import { makeProofOpencodeOwner } from "./sshOwnerPickerProof.client.opencode.ts";
import { proofAliasStartupArgs } from "./sshOwnerPickerProof.client.alias.ts";
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
import {
  PickerProofStartupConfigError,
  PickerProofStartupRetirementError,
} from "./sshOwnerPickerProof.startupDiagnostic.ts";
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
    (host !== "::1" && !(isIPv4(host) && host.startsWith("127."))) ||
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
  let pipe: ReturnType<typeof spawnPickerProofPipe>;
  try {
    pipe = spawnPickerProofPipe(
      binary,
      [
        profileBinding.toString("hex"),
        targetId,
        options.lockFile,
        options.sshBinary,
        options.keyscanBinary,
        host,
        String(port),
        user,
        options.identityFile,
        options.knownHostsFile,
        ...aliasArgs,
        ...(attachment ? ["--attach-socket", attachment.socketPath] : []),
        ...(workspaceRoot === undefined ? [] : ["--workspace-root", workspaceRoot]),
        ...(options.devInteractiveTerminal ? ["--dev-interactive-terminal"] : []),
        ...(agentFixture
          ? ["--agent-fixture", agentFixture.binaryPath, "--agent-sha256", agentFixture.sha256]
          : []),
        ...(installed === undefined ? [] : ["--installed-agent-state", installed]),
        ...(options.providerService
          ? ["--provider-service", options.providerService.kind, options.providerService.binaryPath]
          : []),
        ...(options.opencodeService
          ? ["--opencode-service", options.opencodeService.binaryPath]
          : []),
        ...(provider
          ? [
              codex ? "--codex-fixture" : "--pi-fixture",
              provider.binaryPath,
              provider.sha256,
              provider.cwd,
              provider.threadId,
              String(provider.sessionEpoch),
            ]
          : []),
        ...(agentPath ? ["--identity-agent-path", agentPath] : []),
        ...scoped.args,
        ...(opencode
          ? [
              "--opencode-v1-fixture",
              opencode.binaryPath,
              opencode.sha256,
              opencode.cwd,
              opencode.threadId,
              String(opencode.sessionEpoch),
            ]
          : []),
        ...(relay
          ? [
              "--client-relay-fixture",
              relay.nodeBinary,
              relay.nodeSha256,
              relay.helperEntry,
              relay.helperSha256,
              relay.authorityId,
            ]
          : []),
      ],
      dirname(options.lockFile),
      agentFixture !== undefined ||
        relay !== undefined ||
        provider !== undefined ||
        options.providerService !== undefined ||
        scoped.peer !== undefined ||
        scoped.git !== undefined ||
        scoped.gitUpload !== undefined,
      scoped.pickerCancellation,
      Boolean(attachment && options.devInteractiveTerminal),
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
  ).catch((error: unknown) => {
    const retirement = pipe.startupRetirementDiagnostic();
    if (retirement && error instanceof PickerProofOwnerError && error.code === "ownerUnavailable") {
      throw new PickerProofStartupRetirementError(retirement);
    }
    const diagnostic = pipe.startupConfigDiagnostic();
    if (diagnostic && error instanceof PickerProofOwnerError && error.code === "ownerUnavailable") {
      throw new PickerProofStartupConfigError(diagnostic);
    }
    throw error;
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
      async detach() {
        await stopAdmission();
        await pipe.detach();
      },
      async retireSupervised() {
        const drained = stopAdmission();
        await pipe.retireSupervised();
        await drained;
      },
      async killForTest() {
        const drained = stopAdmission();
        await pipe.killForTest();
        await drained;
      },
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
  const { owner } = await openPickerProofSession(pipe, session, () =>
    exchangePickerProofAttachmentHello(pipe, capability, session.profileBinding, session.major),
  );
  return owner;
}
