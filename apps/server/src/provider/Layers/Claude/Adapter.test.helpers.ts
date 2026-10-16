import * as NodeServices from "@effect/platform-node/NodeServices";
import type { Options as ClaudeQueryOptions, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ThreadId } from "@bigbud/contracts";
import { Layer } from "effect";

import { ServerConfig } from "../../../startup/config.ts";
import { ServerSettingsService } from "../../../ws/serverSettings.ts";
import { makeClaudeAdapterLive, type ClaudeAdapterLiveOptions } from "./Adapter.ts";
import { FakeClaudeQuery } from "./Adapter.test.helpers.query.ts";

export function makeHarness(config?: {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: ClaudeAdapterLiveOptions["nativeEventLogger"];
  readonly cwd?: string;
  readonly baseDir?: string;
  readonly remoteWorkspaceReadinessProbe?: ClaudeAdapterLiveOptions["remoteWorkspaceReadinessProbe"];
  readonly serverSettings?: Parameters<typeof ServerSettingsService.layerTest>[0];
  /** A resolved alternate harness (as CLIProxy uses) disables provider subagents. */
  readonly resolveHarness?: ClaudeAdapterLiveOptions["resolveHarness"];
}) {
  const query = new FakeClaudeQuery();
  let createInput:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
        readonly options: ClaudeQueryOptions;
      }
    | undefined;

  const adapterOptions: ClaudeAdapterLiveOptions = {
    remoteWorkspaceReadinessProbe:
      config?.remoteWorkspaceReadinessProbe ??
      (async () => ({ os: "linux", architecture: "x86_64" })),
    ...(config?.resolveHarness ? { resolveHarness: config.resolveHarness } : {}),
    createQuery: (input) => {
      createInput = input;
      return query;
    },
    ...(config?.nativeEventLogger
      ? {
          nativeEventLogger: config.nativeEventLogger,
        }
      : {}),
    ...(config?.nativeEventLogPath
      ? {
          nativeEventLogPath: config.nativeEventLogPath,
        }
      : {}),
  };

  return {
    layer: makeClaudeAdapterLive(adapterOptions).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(
          config?.cwd ?? "/tmp/claude-adapter-test",
          config?.baseDir ?? "/tmp",
        ),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest(config?.serverSettings)),
      Layer.provideMerge(NodeServices.layer),
    ),
    query,
    getLastCreateQueryInput: () => createInput,
  };
}

export function makeDeterministicRandomService(seed = 0x1234_5678): {
  nextIntUnsafe: () => number;
  nextDoubleUnsafe: () => number;
} {
  let state = seed >>> 0;
  const nextIntUnsafe = (): number => {
    state = (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
    return state;
  };

  return {
    nextIntUnsafe,
    nextDoubleUnsafe: () => nextIntUnsafe() / 0x1_0000_0000,
  };
}

export async function readFirstPromptText(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
): Promise<string | undefined> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return undefined;
  }
  const next = await iterator.next();
  if (next.done) {
    return undefined;
  }
  if (typeof next.value.message.content === "string") {
    return next.value.message.content;
  }
  const content = next.value.message.content[0];
  if (!content || content.type !== "text") {
    return undefined;
  }
  return content.text;
}

export async function readFirstPromptMessage(
  input:
    | {
        readonly prompt: AsyncIterable<SDKUserMessage>;
      }
    | undefined,
): Promise<SDKUserMessage | undefined> {
  const iterator = input?.prompt[Symbol.asyncIterator]();
  if (!iterator) {
    return undefined;
  }
  const next = await iterator.next();
  if (next.done) {
    return undefined;
  }
  return next.value;
}

export const THREAD_ID = ThreadId.makeUnsafe("thread-claude-1");
export const RESUME_THREAD_ID = ThreadId.makeUnsafe("thread-claude-resume");
