import { ArrowUpIcon, FolderGit2Icon, FolderIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import type { ServerListRemoteFoldersResult } from "@bigbud/contracts/server/server.remoteFolders";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { joinRemoteFolderPath, parentRemoteFolderPath } from "./Sidebar.projects.logic";
import type { RemoteFolderBrowserState } from "./SidebarRemoteProjectDialog.folderBrowser";

function FolderList({
  result,
  onNavigate,
}: {
  result: ServerListRemoteFoldersResult;
  onNavigate: (path: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const folders = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle
      ? result.folders.filter((folder) => folder.name.toLowerCase().includes(needle))
      : result.folders;
  }, [filter, result.folders]);

  return (
    <>
      <Input
        aria-label="Filter folders"
        className="rounded-none border-0 border-b border-border bg-transparent shadow-none before:hidden has-focus-visible:ring-0 [&_input]:placeholder:text-xs"
        placeholder="Filter folders"
        spellCheck={false}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <ul aria-label="Remote folders" className="max-h-56 overflow-y-auto p-1">
        {folders.map((folder) => (
          <li key={folder.name}>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              onClick={() => onNavigate(joinRemoteFolderPath(result.path, folder.name))}
            >
              {folder.isGitRepo ? (
                <FolderGit2Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <FolderIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 truncate">{folder.name}</span>
              {folder.isGitRepo ? (
                <span className="ms-auto shrink-0 text-muted-foreground text-xs">git</span>
              ) : null}
            </button>
          </li>
        ))}
        {folders.length === 0 ? (
          <li className="px-2 py-3 text-center text-muted-foreground text-xs">
            {filter.trim() ? `No folders match “${filter.trim()}”` : "No folders here"}
          </li>
        ) : null}
      </ul>
      {result.truncated ? (
        <p className="border-t border-border px-3 py-1.5 text-muted-foreground text-xs">
          Showing the first {result.folders.length} folders. Type a path to go elsewhere.
        </p>
      ) : null}
    </>
  );
}

/** Inline remote folder browser: navigate into folders, then choose the current one. */
export function RemoteFolderBrowserPanel({
  state,
  onNavigate,
  onChoose,
  onClose,
}: {
  state: RemoteFolderBrowserState;
  onNavigate: (path: string | undefined) => void;
  onChoose: (path: string) => void;
  onClose: () => void;
}) {
  if (state.status === "closed") return null;
  const result = state.status === "ready" ? state.result : null;

  return (
    <section
      aria-label="Browse remote folders"
      className="mt-2 overflow-hidden rounded-lg border border-border bg-card"
    >
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Parent folder"
          disabled={!result || result.path === "/"}
          onClick={() => result && onNavigate(parentRemoteFolderPath(result.path))}
        >
          <ArrowUpIcon className="size-3.5" />
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={result?.path}>
          {result?.path ?? "…"}
        </span>
        <Button variant="ghost" size="icon-xs" aria-label="Close folder browser" onClick={onClose}>
          <XIcon className="size-3.5" />
        </Button>
      </div>

      {state.status === "loading" ? (
        <div className="flex items-center gap-2 px-3 py-4 text-muted-foreground text-xs">
          <Spinner className="size-3" />
          <span>Loading folders…</span>
        </div>
      ) : null}
      {state.status === "error" ? (
        <div className="flex flex-wrap items-center gap-2 px-3 py-3 text-destructive text-xs">
          <span className="min-w-0 flex-1">{state.message}</span>
          <Button variant="outline" size="xs" onClick={() => onNavigate(state.path)}>
            Retry
          </Button>
        </div>
      ) : null}
      {result ? <FolderList key={result.path} result={result} onNavigate={onNavigate} /> : null}

      {result ? (
        <div className="flex items-center justify-end gap-2 border-t border-border px-2 py-1.5">
          <Button size="xs" onClick={() => onChoose(result.path)}>
            Use this folder
          </Button>
        </div>
      ) : null}
    </section>
  );
}
