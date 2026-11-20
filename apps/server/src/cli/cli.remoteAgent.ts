import { randomUUID } from "node:crypto";
import {
  followRemoteAgentOperation,
  RemoteAgentOperationUncertainError,
} from "./cli.remoteAgent.recovery.ts";
import {
  askYesNo,
  capacityHint,
  REPLACE_FLAG_CONFLICT,
  resolveReplaceChoice,
} from "./cli.remoteAgent.replace.ts";
import { removeCommand } from "./cli.remoteAgent.remove.ts";
import {
  failResponse,
  print,
  runAction,
  sharedFlags,
  socketFor,
  targetArgument,
} from "./cli.remoteAgent.shared.ts";

import { Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import {
  RemoteAgentBackendUnavailableError,
  sendRemoteAgentControlRequest,
} from "../remote-agent/remoteAgentLocalControl.client.ts";
import {
  isRemoteAgentOperationSnapshot,
  REMOTE_AGENT_CLI_EXIT,
  type RemoteAgentControlRequest,
} from "../remote-agent/remoteAgentLocalControl.protocol.ts";

import { version } from "../../package.json" with { type: "json" };

function askConsent(target: string, message: string): Promise<boolean> {
  return askYesNo(`${message}\nInstall it on ${target}? [y/N] `);
}

const readOnlyCommand = (method: "status" | "doctor", description: string) =>
  Command.make(method, { target: targetArgument, ...sharedFlags }).pipe(
    Command.withDescription(description),
    Command.withHandler((options) =>
      runAction(options, async (json) => {
        const response = await sendRemoteAgentControlRequest(
          socketFor(options),
          { method, target: options.target },
          120_000,
        );
        if (!response.ok) return failResponse(json, response);
        print(json, response.result, JSON.stringify(response.result, null, 2));
        return REMOTE_AGENT_CLI_EXIT.active;
      }),
    ),
  );

const installCommand = Command.make("install", {
  target: targetArgument,
  replace: Flag.boolean("replace").pipe(
    Flag.withDescription(
      "Retire older builds after the new build is active, without asking (the default).",
    ),
    Flag.optional,
  ),
  keepPrevious: Flag.boolean("keep-previous").pipe(
    Flag.withDescription("Keep older builds instead of retiring them, without asking."),
    Flag.optional,
  ),
  yes: Flag.boolean("yes").pipe(
    Flag.withDescription("Consent to installing on a host not yet approved in bigbud."),
    Flag.optional,
  ),
  ...sharedFlags,
}).pipe(
  Command.withDescription(
    "Install the bigbud remote agent and activate it. Older builds are retired once the new build is active (deferred while live work uses them). Interactive installs over an older build ask first, defaulting to yes; --replace or --keep-previous answers without asking.",
  ),
  Command.withHandler((options) =>
    runAction(options, async (json) => {
      const replaceFlag = Option.getOrElse(options.replace, () => false);
      const keepPrevious = Option.getOrElse(options.keepPrevious, () => false);
      if (replaceFlag && keepPrevious) {
        print(
          json,
          { ok: false, error: { code: "usage", message: REPLACE_FLAG_CONFLICT } },
          `bigbud remote-agent: ${REPLACE_FLAG_CONFLICT}`,
        );
        return REMOTE_AGENT_CLI_EXIT.failed;
      }
      const socketPath = socketFor(options);
      // Read-only status first: the replace question needs an approved host with an older build.
      const replace = await resolveReplaceChoice({
        socketPath,
        target: options.target,
        replace: replaceFlag,
        keepPrevious,
        json,
        agentVersion: version,
        hint: (line) => void process.stderr.write(`${line}\n`),
      });
      const operationId = randomUUID();
      const request = (consent: boolean): RemoteAgentControlRequest => ({
        method: "install",
        operationId,
        target: options.target,
        replace,
        consent,
      });
      let response = await sendRemoteAgentControlRequest(
        socketPath,
        request(Option.getOrElse(options.yes, () => false)),
        120_000,
      ).catch((cause: unknown) => {
        if (cause instanceof RemoteAgentBackendUnavailableError) throw cause;
        throw new RemoteAgentOperationUncertainError(operationId, options.target, cause);
      });
      if (!response.ok) return failResponse(json, response);
      const accepted = response.result as { status?: string; message?: string };
      if (accepted.status === "consent-required") {
        if (json || !(await askConsent(options.target, accepted.message ?? ""))) {
          print(json, accepted, `${accepted.message}\nRerun with --yes to consent.`);
          return REMOTE_AGENT_CLI_EXIT.consentRequired;
        }
        response = await sendRemoteAgentControlRequest(socketPath, request(true), 120_000).catch(
          (cause: unknown) => {
            throw new RemoteAgentOperationUncertainError(operationId, options.target, cause);
          },
        );
        if (!response.ok) return failResponse(json, response);
      }
      if (!isRemoteAgentOperationSnapshot(response.result))
        throw new RemoteAgentOperationUncertainError(
          operationId,
          options.target,
          new Error("Invalid acceptance reply."),
        );
      if (!json) process.stderr.write(`Operation ${response.result.operationId} started.\n`);
      return followRemoteAgentOperation({
        socketPath,
        operationId: response.result.operationId,
        target: options.target,
        print: (value, text) => print(json, value, text),
        hint: (snapshot) => capacityHint(snapshot, replace),
      });
    }),
  ),
);

export const remoteAgentCommand = Command.make("remote-agent").pipe(
  Command.withDescription(
    "Install, inspect or remove the bigbud remote agent through the running bigbud backend.",
  ),
  Command.withSubcommands([
    readOnlyCommand("status", "Show the agent status of a remote target."),
    readOnlyCommand("doctor", "Read-only platform and prerequisite report for a remote target."),
    installCommand,
    removeCommand,
    Command.make("follow", { operationId: Argument.string("operationId"), ...sharedFlags }).pipe(
      Command.withDescription(
        "Read an existing install operation without starting another install.",
      ),
      Command.withHandler((options) =>
        runAction(options, (json) =>
          followRemoteAgentOperation({
            socketPath: socketFor(options),
            operationId: options.operationId,
            print: (value, text) => print(json, value, text),
          }),
        ),
      ),
    ),
  ]),
);
