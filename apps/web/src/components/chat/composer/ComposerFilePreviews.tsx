import { XIcon } from "lucide-react";
import { Button } from "../../ui/button";
import { VscodeEntryIcon } from "../common/VscodeEntryIcon";
import type { ComposerFileAttachment } from "../../../stores/composer";

interface ComposerFilePreviewsProps {
  composerFiles: ComposerFileAttachment[];
  resolvedTheme: "light" | "dark";
  onRemoveFile: (fileId: string) => void;
}

/** Strips the file extension from a filename, returning the base name. */
function fileBaseName(name: string): string {
  const dotIndex = name.lastIndexOf(".");
  return dotIndex > 0 ? name.slice(0, dotIndex) : name;
}

export function ComposerFilePreviews({
  composerFiles,
  resolvedTheme,
  onRemoveFile,
}: ComposerFilePreviewsProps) {
  if (composerFiles.length === 0) return null;

  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {composerFiles.map((file) => (
        <div
          key={file.id}
          className="group relative flex max-w-[160px] items-center gap-1.5 rounded-lg border border-border/80 bg-background px-2 py-1.5"
        >
          <VscodeEntryIcon
            pathValue={file.name}
            kind="file"
            theme={resolvedTheme}
            className="shrink-0"
          />
          <span className="truncate text-xs text-foreground/80" title={file.name}>
            {fileBaseName(file.name)}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-0.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
            onClick={() => onRemoveFile(file.id)}
            aria-label={`Remove ${file.name}`}
          >
            <XIcon />
          </Button>
        </div>
      ))}
    </div>
  );
}
