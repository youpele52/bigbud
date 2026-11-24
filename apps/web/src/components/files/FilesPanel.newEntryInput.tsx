import { ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { VscodeEntryIcon } from "../chat/common/VscodeEntryIcon";
import type { PendingNewEntry } from "./useFilesPanelEntryActions";

interface FilesPanelNewEntryInputProps {
  readonly pending: PendingNewEntry;
  readonly depth: number;
  readonly resolvedTheme: "light" | "dark";
  readonly onSubmit: (name: string) => void;
  readonly onCancel: () => void;
}

/** Inline name input shown in the target folder. Enter creates; Esc cancels. */
export function FilesPanelNewEntryInput({
  pending,
  depth,
  resolvedTheme,
  onSubmit,
  onCancel,
}: FilesPanelNewEntryInputProps) {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const folder = pending.kind === "folder";
  const errorId = `files-new-entry-error-${depth}`;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div data-files-new-entry={pending.kind} style={{ paddingLeft: `${8 + depth * 16}px` }}>
      <div className="flex items-center gap-1.5 rounded-md px-2 py-0.5">
        {folder ? (
          <ChevronRightIcon className="size-3 shrink-0" />
        ) : (
          <span className="size-3 shrink-0" />
        )}
        <VscodeEntryIcon
          pathValue={name || (folder ? "folder" : "file")}
          kind={folder ? "directory" : "file"}
          theme={resolvedTheme}
          className="size-3.5 shrink-0"
        />
        <input
          ref={inputRef}
          value={name}
          // Read only (not disabled) while creating, so focus stays for Esc or a corrected name.
          readOnly={pending.busy}
          aria-busy={pending.busy || undefined}
          aria-label={folder ? "New folder name" : "New file name"}
          aria-invalid={pending.error ? true : undefined}
          aria-describedby={pending.error ? errorId : undefined}
          placeholder={folder ? "Folder name" : "File name"}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="h-6 min-w-0 flex-1 rounded-sm border border-input bg-background px-1.5 text-sm text-foreground outline-none focus-visible:border-ring aria-invalid:border-destructive/60"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onSubmit(name);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onCancel();
            }
          }}
          onBlur={() => {
            // Leaving an empty input cancels; a typed name stays until Enter or Esc.
            if (name.trim().length === 0 && !pending.busy) onCancel();
          }}
        />
      </div>
      {pending.error ? (
        <p id={errorId} role="alert" className="px-2 pb-1 pl-8 text-xs text-destructive">
          {pending.error}
        </p>
      ) : null}
    </div>
  );
}
