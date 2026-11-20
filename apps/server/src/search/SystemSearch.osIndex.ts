import { randomUUID } from "node:crypto";
import * as nodePath from "node:path";

import type { FileAccessPermissionLevel } from "@bigbud/contracts/core/settings.search.ts";
import {
  SystemSearchOsIndexSource,
  type SystemSearchHit,
  type SystemSearchReason,
} from "@bigbud/contracts/search/systemSearch.ts";
import { Schema } from "effect";
import { isOsIndexExcludedPath } from "@bigbud/shared/search/osIndexExclusions";
import { countUnicodeCodePoints } from "@bigbud/shared/String";

import { runRemoteAgentOsIndexSearch } from "../remote-agent/remoteAgentOsIndexSearch.ts";
import {
  REMOTE_AGENT_OS_INDEX_CAPABILITY,
  REMOTE_AGENT_OS_INDEX_SCOPE,
  type RemoteAgentOsIndexSearchHit,
} from "../remote-agent/remoteAgentProtocol.search.ts";
import type { SearchAgentConnection } from "./SystemSearch.agentRequest.ts";
import type { SystemSearchEmitter } from "./SystemSearch.emitter.ts";

/** T5 source on a platform without an OS index adapter (the agent answers `UNSUPPORTED`). */
export const OS_INDEX_FALLBACK_SOURCE_ID = "os-index";
const isOsIndexSource = Schema.is(SystemSearchOsIndexSource);

/**
 * The OS index the local agent on this machine uses (it runs beside the server). The agent's own
 * `OsIndexSearchCompleted.source` stays authoritative for rows and the final state.
 */
export function expectedOsIndexSource(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case "darwin":
      return "spotlight";
    case "win32":
      return "windows-search";
    case "linux":
      return "locate";
    default:
      return OS_INDEX_FALLBACK_SOURCE_ID;
  }
}
/** T5 rows (plan §4); the agent fetches 200 from Spotlight and filters down to these. */
export const OS_INDEX_MAX_RESULTS = 50;
/** The agent never returns more than this (`MAX_OS_INDEX_RESULTS`); paging stops here. */
export const OS_INDEX_MAX_PAGED_RESULTS = 200;
export const OS_INDEX_DEADLINE_MS = 1_500;
export const OS_INDEX_MIN_CHARS = 2;

export interface OsIndexGate {
  /** The server runs as the desktop-embedded backend (never the remote-backend profile). */
  readonly desktopEmbedded: boolean;
  readonly allowedByPolicy: boolean;
  readonly thisComputer: boolean;
  readonly fileAccessLevel: FileAccessPermissionLevel;
}

/**
 * Server-enforced gate for T5 (plan §6, Q2): `null` means the tier is absent (not the desktop
 * backend); otherwise the scope level to query or the reason it is unavailable.
 */
export function resolveOsIndexScope(gate: OsIndexGate):
  | null
  | {
      readonly level: (typeof REMOTE_AGENT_OS_INDEX_SCOPE)[keyof typeof REMOTE_AGENT_OS_INDEX_SCOPE];
    }
  | { readonly reason: SystemSearchReason } {
  if (!gate.desktopEmbedded) return null;
  if (!gate.allowedByPolicy) return { reason: "policy" };
  if (!gate.thisComputer) return { reason: "disabled" };
  switch (gate.fileAccessLevel) {
    case "none":
      return { reason: "file-access-none" };
    case "common-folders":
      return { level: REMOTE_AGENT_OS_INDEX_SCOPE.commonFolders };
    case "unrestricted":
      return { level: REMOTE_AGENT_OS_INDEX_SCOPE.unrestricted };
  }
}

function toRow(hit: RemoteAgentOsIndexSearchHit, home: string): SystemSearchHit | null {
  if (!nodePath.isAbsolute(hit.path) || isOsIndexExcludedPath(hit.path, home)) return null;
  const root = nodePath.dirname(hit.path);
  const name = nodePath.basename(hit.path);
  if (!name || root === hit.path) return null;
  const label =
    root === home || root.startsWith(`${home}${nodePath.sep}`)
      ? `~${root.slice(home.length)}`
      : root;
  return {
    id: `thisComputer:name:local:${hit.path}`,
    kind: "name",
    executionTargetId: "local",
    root,
    path: name,
    label,
    isDirectory: hit.isDirectory,
    ...(!hit.isDirectory && hit.sizeBytes > 0 ? { sizeBytes: hit.sizeBytes } : {}),
    ...(hit.modifiedUnixMs > 0 ? { modifiedUnixMs: hit.modifiedUnixMs } : {}),
  };
}

function reasonFor(errorCode: string): SystemSearchReason {
  if (errorCode === "UNSUPPORTED") return "unsupported";
  if (errorCode === "UNAVAILABLE") return "index-unavailable";
  return errorCode === "SEARCH_BUSY" ? "busy" : "error";
}

/**
 * T5 "this computer" through the local agent's OS index. Rows outside the File Access scope or
 * on the exclusion list never leave the agent; the server checks the exclusions again.
 */
export async function runOsIndexSearch(input: {
  readonly gate: OsIndexGate;
  readonly localConnection: () => Promise<SearchAgentConnection>;
  readonly home: string;
  readonly query: string;
  readonly emitter: SystemSearchEmitter;
  readonly signal: AbortSignal;
  readonly platform?: NodeJS.Platform;
  /** Page `n` asks for `n + 1` pages of rows, up to `OS_INDEX_MAX_PAGED_RESULTS`. */
  readonly page?: number | undefined;
}): Promise<void> {
  if (countUnicodeCodePoints(input.query) < OS_INDEX_MIN_CHARS) return;
  const scope = resolveOsIndexScope(input.gate);
  if (scope === null) return;
  const tier = "thisComputer" as const;
  const expected = expectedOsIndexSource(input.platform);
  if ("reason" in scope) {
    input.emitter.state({ tier, sourceId: expected, state: "unavailable", reason: scope.reason });
    return;
  }
  input.emitter.state({ tier, sourceId: expected, state: "searching" });
  let sourceId = expected;
  const maxResults = Math.min(
    OS_INDEX_MAX_RESULTS * ((input.page ?? 0) + 1),
    OS_INDEX_MAX_PAGED_RESULTS,
  );
  try {
    const connection = await input.localConnection();
    if (!connection.supportsCapability(REMOTE_AGENT_OS_INDEX_CAPABILITY)) {
      input.emitter.state({ tier, sourceId, state: "unavailable", reason: "unsupported" });
      return;
    }
    const { hits, completed } = await runRemoteAgentOsIndexSearch(
      connection,
      {
        operationId: `search-os-index-${randomUUID()}`,
        query: input.query,
        scopeLevel: scope.level,
        maxResults,
        deadlineMs: OS_INDEX_DEADLINE_MS,
      },
      { signal: input.signal },
    );
    if (input.signal.aborted || completed.stopReason === "cancelled") return;
    if (isOsIndexSource(completed.source) && completed.source !== expected) {
      // Close the source announced as searching, then answer under the agent's own source.
      input.emitter.state({ tier, sourceId: expected, state: "done" });
      sourceId = completed.source;
    }
    if (completed.errorCode) {
      const reason = reasonFor(completed.errorCode);
      input.emitter.state({ tier, sourceId, state: "unavailable", reason });
      return;
    }
    const items = hits.flatMap((hit) => toRow(hit, input.home) ?? []);
    const complete = input.emitter.rowsFor({ tier, sourceId, items });
    // The agent's own cap ends paging: no page asks past it.
    const truncated = (completed.truncated && maxResults < OS_INDEX_MAX_PAGED_RESULTS) || !complete;
    const finished = completed.stopReason === "complete" && !truncated;
    input.emitter.state({ tier, sourceId, state: finished ? "done" : "partial", truncated });
  } catch {
    if (!input.signal.aborted) {
      input.emitter.state({ tier, sourceId, state: "unavailable", reason: "error" });
    }
  }
}
