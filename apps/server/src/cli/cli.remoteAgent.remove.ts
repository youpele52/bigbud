import { Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";

import { sendRemoteAgentControlRequest } from "../remote-agent/remoteAgentLocalControl.client.ts";
import { REMOTE_AGENT_CLI_EXIT } from "../remote-agent/remoteAgentLocalControl.protocol.ts";
import { askYesNo } from "./cli.remoteAgent.replace.ts";
import {
  failResponse,
  print,
  runAction,
  sharedFlags,
  socketFor,
  targetArgument,
} from "./cli.remoteAgent.shared.ts";

export const REMOVE_FLAG_CONFLICT =
  "--switch-to-direct-ssh and --keep-transport cannot be used together.";
const REMOVE_TIMEOUT_MS = 180_000;

interface RemovalReply {
  readonly status?: string;
  readonly message?: string;
  readonly outcome?: "removed" | "blocked" | "failed";
  readonly switchedWorkspaceIds?: ReadonlyArray<string>;
  readonly blockers?: ReadonlyArray<{ readonly kind: string; readonly label: string }>;
}

/** Human summary and exit code for a removal reply from the backend. */
export function describeRemoval(
  target: string,
  reply: RemovalReply,
): { readonly text: string; readonly code: number } {
  if (reply.outcome === "removed") {
    const switched = reply.switchedWorkspaceIds?.length ?? 0;
    return {
      text: `Removed ~/.bigbud/agent from ${target}.${
        switched > 0 ? ` ${switched} workspace(s) now use Direct SSH.` : ""
      } Reconnect over SSH or the remote agent.`,
      code: REMOTE_AGENT_CLI_EXIT.active,
    };
  }
  if (reply.outcome === "blocked") {
    const lines = (reply.blockers ?? []).map((blocker) => `  - ${blocker.label}`);
    return {
      text: [`Nothing was removed. Live work still uses the agent on ${target}:`, ...lines].join(
        "\n",
      ),
      code: REMOTE_AGENT_CLI_EXIT.deferred,
    };
  }
  return {
    text: `bigbud remote-agent: ${reply.message ?? "Removal failed."}`,
    code: REMOTE_AGENT_CLI_EXIT.failed,
  };
}

export const removeCommand = Command.make("remove", {
  target: targetArgument,
  switchToDirectSsh: Flag.boolean("switch-to-direct-ssh").pipe(
    Flag.withDescription("Move this host's workspaces to Direct SSH after removal (the default)."),
    Flag.optional,
  ),
  keepTransport: Flag.boolean("keep-transport").pipe(
    Flag.withDescription("Leave this host's workspaces on the remote agent transport."),
    Flag.optional,
  ),
  yes: Flag.boolean("yes").pipe(
    Flag.withDescription("Confirm removal without asking."),
    Flag.optional,
  ),
  ...sharedFlags,
}).pipe(
  Command.withDescription(
    "Remove the bigbud remote agent (~/.bigbud/agent only) from a host, then disconnect it. Refuses while live work uses the agent; ~/.bigbud/backend-* is never touched.",
  ),
  Command.withHandler((options) =>
    runAction(options, async (json) => {
      const keepTransport = Option.getOrElse(options.keepTransport, () => false);
      if (Option.getOrElse(options.switchToDirectSsh, () => false) && keepTransport) {
        print(
          json,
          { ok: false, error: { code: "usage", message: REMOVE_FLAG_CONFLICT } },
          `bigbud remote-agent: ${REMOVE_FLAG_CONFLICT}`,
        );
        return REMOTE_AGENT_CLI_EXIT.failed;
      }
      const socketPath = socketFor(options);
      const send = (consent: boolean) =>
        sendRemoteAgentControlRequest(
          socketPath,
          {
            method: "remove",
            target: options.target,
            switchToDirectSsh: !keepTransport,
            consent,
          },
          REMOVE_TIMEOUT_MS,
        );
      let response = await send(Option.getOrElse(options.yes, () => false));
      if (!response.ok) return failResponse(json, response);
      let reply = response.result as RemovalReply;
      if (reply.status === "confirmation-required") {
        const confirmed =
          !json && (await askYesNo(`${reply.message}\nRemove it from ${options.target}? [y/N] `));
        if (!confirmed) {
          print(json, reply, `${reply.message}\nRerun with --yes to confirm.`);
          return REMOTE_AGENT_CLI_EXIT.consentRequired;
        }
        response = await send(true);
        if (!response.ok) return failResponse(json, response);
        reply = response.result as RemovalReply;
      }
      const summary = describeRemoval(options.target, reply);
      print(json, reply, summary.text);
      return summary.code;
    }),
  ),
);
