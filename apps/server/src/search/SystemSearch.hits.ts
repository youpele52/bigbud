import type { SystemSearchHit } from "@bigbud/contracts/search/systemSearch.ts";

import type {
  RemoteAgentWorkspaceSearchContentHit,
  RemoteAgentWorkspaceSearchNameHit,
} from "../remote-agent/remoteAgentProtocol.search.ts";
import type { SearchRootEntry } from "./SystemSearch.roots.ts";

function rowId(root: SearchRootEntry, kind: "name" | "content", path: string, suffix = ""): string {
  const base = root.root.endsWith("/") ? root.root : `${root.root}/`;
  return `${root.tier}:${kind}:${root.executionTargetId}:${base}${path}${suffix}`;
}

function rootFields(root: SearchRootEntry) {
  return {
    executionTargetId: root.executionTargetId,
    root: root.root,
    ...(root.projectId ? { projectId: root.projectId } : {}),
    label: root.label,
  };
}

/** 0 means unknown on the wire; negative or unsafe values are dropped rather than sent. */
function knownCount(value: number): number | undefined {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function nameHitToRow(
  root: SearchRootEntry,
  hit: Pick<RemoteAgentWorkspaceSearchNameHit, "path" | "isDirectory" | "sizeBytes"> & {
    readonly modifiedUnixMs?: number | undefined;
  },
): SystemSearchHit | null {
  if (!hit.path) return null;
  const sizeBytes = hit.isDirectory ? undefined : knownCount(hit.sizeBytes);
  const modifiedUnixMs = knownCount(hit.modifiedUnixMs ?? 0);
  return {
    id: rowId(root, "name", hit.path),
    kind: "name",
    ...rootFields(root),
    path: hit.path,
    isDirectory: hit.isDirectory,
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    ...(modifiedUnixMs !== undefined ? { modifiedUnixMs } : {}),
  };
}

export function contentHitToRow(
  root: SearchRootEntry,
  hit: Pick<RemoteAgentWorkspaceSearchContentHit, "path" | "line" | "column" | "excerpt">,
): SystemSearchHit | null {
  if (!hit.path || hit.line <= 0) return null;
  const column = hit.column > 0 ? hit.column : 0;
  return {
    id: rowId(root, "content", hit.path, `:${hit.line}:${column}`),
    kind: "content",
    ...rootFields(root),
    path: hit.path,
    line: hit.line,
    ...(column > 0 ? { column } : {}),
    excerpt: hit.excerpt,
  };
}
