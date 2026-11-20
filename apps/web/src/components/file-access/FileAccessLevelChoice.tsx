import { FolderOpenIcon } from "lucide-react";

import type { FileAccessPromptLevel } from "./FileAccessLevelChoice.logic";

export const FILE_ACCESS_PROMPT_TITLE = "Allow bigbud to access your files";
export const FILE_ACCESS_PROMPT_DESCRIPTION =
  'bigbud needs access to your folders to help you work with projects, documents, and files. The same choice sets what "Search this computer" can find.';

const OPTIONS: ReadonlyArray<{
  value: FileAccessPromptLevel;
  label: string;
  description: string;
  recommended?: boolean;
}> = [
  {
    value: "unrestricted",
    label: "All files and folders",
    description:
      "bigbud can access any file on your system, and search covers your home and cloud folders.",
    recommended: true,
  },
  {
    value: "common-folders",
    label: "Commonly used folders only",
    description: "Desktop, Documents, Downloads, Music, and Pictures.",
  },
];

/** The File Access levels offered on first launch, shared by every place that asks. */
export function FileAccessLevelChoice({
  value,
  onChange,
  disabled = false,
}: {
  value: FileAccessPromptLevel;
  onChange: (value: FileAccessPromptLevel) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-3">
      <div role="group" aria-label="File access level" className="space-y-3">
        {OPTIONS.map((option) => {
          const selected = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              disabled={disabled}
              onClick={() => onChange(option.value)}
              className={`flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring ${
                selected ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-accent"
              }`}
            >
              <div
                className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 ${
                  selected ? "border-primary" : "border-muted-foreground"
                }`}
              >
                {selected && <div className="size-2.5 rounded-full bg-primary" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{option.label}</span>
                  {option.recommended ? (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                      Recommended
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{option.description}</p>
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-8 flex items-start gap-2 px-7 py-1">
        <FolderOpenIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <p className="text-[11px] text-muted-foreground">
          You can change this anytime in Settings → AI → File Access. macOS asks you to confirm each
          protected folder now, so search never asks later.
        </p>
      </div>
    </div>
  );
}
