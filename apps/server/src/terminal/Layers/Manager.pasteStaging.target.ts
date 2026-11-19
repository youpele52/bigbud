import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import {
  TerminalPasteStageError,
  type TerminalPasteHost,
  type TerminalPasteStageResult,
} from "@bigbud/contracts/workspace/terminal.paste.ts";
import { isWslTerminalTargetId } from "@bigbud/shared/terminalExecutionTarget";
import { isLocalExecutionTarget } from "../../executionTargets.ts";
import { parseSshExecutionTarget } from "../../ssh/sshExecutionTarget.ts";
import type { LocalPasteStore } from "./Manager.pasteStaging.local.ts";
import type { PasteFileKind } from "./Manager.pasteStaging.names.ts";

export type PasteClipboardOutcome = Extract<
  TerminalPasteStageResult,
  { op: "commit" }
>["clipboard"];

export interface PasteStagingSink {
  readonly write: (chunk: Uint8Array) => Promise<void>;
  /** Verifies the server-computed digest and resolves to the absolute staged path. */
  readonly commit: (
    sha256: string,
  ) => Promise<{ readonly path: string; readonly clipboard: PasteClipboardOutcome }>;
  readonly abort: () => Promise<void>;
}

/** The machine one terminal generation stages on, chosen from its server session. */
export interface PasteStagingTarget {
  readonly host: TerminalPasteHost;
  readonly hostLabel: string;
  readonly generation: string | undefined;
  readonly begin: (kind: PasteFileKind, byteLength: number) => Promise<PasteStagingSink>;
  readonly release: (path: string) => Promise<void>;
}

/** A remote agent's staging folder, scoped to one terminal generation. */
export interface RemotePasteAgent {
  readonly begin: (input: {
    readonly scope: string;
    readonly kind: PasteFileKind;
    readonly byteLength: number;
  }) => Promise<PasteStagingSink>;
  /** Deletes every file staged under the scope (idempotent). */
  readonly discard: (scope: string) => Promise<void>;
}

export type RemotePasteAgentResolver = (
  executionTargetId: string,
) => Effect.Effect<RemotePasteAgent, TerminalPasteStageError>;

/** Stable per terminal generation, so a restart can never reuse the previous scope. */
export function pasteStagingScope(threadId: string, terminalId: string, generation = "") {
  return createHash("sha256")
    .update(JSON.stringify([threadId, terminalId, generation]))
    .digest("hex")
    .slice(0, 32);
}

export const resolvePasteTarget = Effect.fn("terminal.pasteStaging.target")(function* (input: {
  readonly executionTargetId: string | undefined;
  readonly threadId: string;
  readonly terminalId: string;
  readonly generation: string | undefined;
  readonly local: LocalPasteStore;
  readonly remote: RemotePasteAgentResolver | undefined;
}) {
  const target = input.executionTargetId;
  if (isWslTerminalTargetId(target))
    return yield* new TerminalPasteStageError({
      code: "unsupportedTarget",
      detail:
        "Pasting files is unavailable for WSL terminals. Enter a path inside the distro instead.",
    });
  if (isLocalExecutionTarget(target)) {
    return {
      host: "local",
      hostLabel: "this computer",
      generation: input.generation,
      begin: async (kind, byteLength) => {
        const sink = await input.local.begin(kind.extension, byteLength);
        return {
          ...sink,
          commit: async () => ({ path: await sink.commit(), clipboard: "skipped" }),
        };
      },
      release: (path) => input.local.remove([path]),
    } satisfies PasteStagingTarget;
  }
  if (!input.remote || !target)
    return yield* new TerminalPasteStageError({
      code: "remoteAgentRequired",
      detail:
        "Pasting files into this remote terminal needs the bigbud remote agent on that host. Connect it with the remote agent, then paste again.",
    });
  const agent = yield* input.remote(target);
  const scope = pasteStagingScope(input.threadId, input.terminalId, input.generation);
  return {
    host: "remote",
    hostLabel: parseSshExecutionTarget(target)?.host ?? target,
    generation: input.generation,
    begin: (kind, byteLength) => agent.begin({ scope, kind, byteLength }),
    release: () => agent.discard(scope),
  } satisfies PasteStagingTarget;
});
