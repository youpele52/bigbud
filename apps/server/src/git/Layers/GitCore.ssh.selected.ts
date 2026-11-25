import { GitCommandError } from "@bigbud/contracts/workspace/git.errors.ts";
import { Effect, Layer, Option } from "effect";

import {
  RemoteAgentGitExecutorService,
  type RemoteAgentGitExecutor,
} from "../../remote-agent/remoteAgentGit.ts";
import { isRemoteAgentExecutionTarget } from "../../remote-agent/remoteAgentDefault.ts";
import { isDevSshOwnerSelected } from "../../ssh/sshOwnerDevMode.ts";
import { DevSshOwnerRuntime } from "../../ssh/sshOwnerDevRuntime.ts";
import type { LaunchedPickerProofOwner } from "../../ssh/sshOwnerPickerProof.client.ts";
import { workspaceGitForPickerProof } from "../../ssh/sshOwnerPickerProof.git.ts";
import { makeSshGitExecutor } from "./GitCore.ssh.ts";
import type { DirectWorkspaceGitOwner } from "./GitCore.ssh.owner.ts";
import { InitiatingFetchOwner } from "./GitCore.initiatingTransport.ts";
import {
  makeSelectedGitHubCliOwnerTransport,
  makeSelectedInitiatingFetchBinding,
  type OwnerGitStreamSession,
} from "./GitCore.selectedStream.ts";
import { GitHubCliOwnerTransport } from "./GitHubCli.owner.ts";

interface SelectedOwner {
  readonly kind: "unix";
  readonly targetId: string;
  readonly fixture: { readonly folder: string };
  readonly picker: {
    readonly withOwner: <A>(
      targetId: string,
      operation: (client: LaunchedPickerProofOwner) => Promise<A>,
      signal?: AbortSignal,
    ) => Promise<A>;
  };
}

function directPort(owner: SelectedOwner): DirectWorkspaceGitOwner {
  return {
    execute: (input, signal) =>
      owner.picker.withOwner(
        owner.targetId,
        (client) => workspaceGitForPickerProof(client).execute(input, signal),
        signal,
      ),
    statusMetadata: {
      execute: (input, signal) =>
        owner.picker.withOwner(
          owner.targetId,
          (client) => workspaceGitForPickerProof(client).statusMetadata.execute(input, signal),
          signal,
        ),
    },
    mutation: {
      execute: (input, signal) =>
        owner.picker.withOwner(
          owner.targetId,
          (client) => workspaceGitForPickerProof(client).mutation.execute(input, signal),
          signal,
        ),
    },
    pathRead: {
      execute: (input, signal) =>
        owner.picker.withOwner(
          owner.targetId,
          (client) => workspaceGitForPickerProof(client).pathRead.execute(input, signal),
          signal,
        ),
    },
  };
}

function selectedOwner(
  context: Option.Option<{ readonly session: unknown }>,
): SelectedOwner | undefined {
  const session = Option.getOrUndefined(context)?.session as Partial<SelectedOwner> | undefined;
  return session?.kind === "unix" &&
    typeof session.targetId === "string" &&
    typeof session.fixture === "object" &&
    session.fixture !== null &&
    typeof session.picker === "object" &&
    session.picker !== null
    ? (session as SelectedOwner)
    : undefined;
}

function streamSession(owner: SelectedOwner | undefined): OwnerGitStreamSession | undefined {
  return (
    owner && {
      targetId: owner.targetId,
      withClient: (operation, signal) => owner.picker.withOwner(owner.targetId, operation, signal),
    }
  );
}

/** The selected fixture is the only direct Git authority, even if a legacy agent is configured. */
export function makeSelectedDevGitLayer<E = never, R = never>(
  runtime?: Layer.Layer<DevSshOwnerRuntime, E, R>,
  agent?: RemoteAgentGitExecutor,
) {
  const unselected = makeSshGitExecutor();
  const resolve = Effect.serviceOption(DevSshOwnerRuntime);
  const git = Layer.effect(
    RemoteAgentGitExecutorService,
    resolve.pipe(
      Effect.map((context): RemoteAgentGitExecutor => {
        const owner = selectedOwner(context);
        const port = owner && directPort(owner);
        const execute = port && makeSshGitExecutor(port);
        return (input) => {
          if (!isDevSshOwnerSelected()) {
            return agent && isRemoteAgentExecutionTarget(input.executionTargetId)
              ? agent(input)
              : unselected(input);
          }
          if (
            execute &&
            owner &&
            input.executionTargetId === owner.targetId &&
            input.cwd === owner.fixture.folder
          )
            return execute(input);
          return Effect.fail(
            new GitCommandError({
              operation: input.operation,
              command: "direct workspace Git",
              cwd: input.cwd,
              detail:
                "Only the exact development workspace admits native Git reads. No Git command was launched.",
            }),
          );
        };
      }),
    ),
  );
  const fetch = Layer.effect(
    InitiatingFetchOwner,
    resolve.pipe(
      Effect.map((context) =>
        makeSelectedInitiatingFetchBinding({ session: streamSession(selectedOwner(context)) }),
      ),
    ),
  );
  const github = Layer.effect(
    GitHubCliOwnerTransport,
    resolve.pipe(
      Effect.map((context) =>
        makeSelectedGitHubCliOwnerTransport({ session: streamSession(selectedOwner(context)) }),
      ),
    ),
  );
  const merged = Layer.mergeAll(git, fetch, github);
  return runtime ? merged.pipe(Layer.provide(runtime)) : merged;
}
