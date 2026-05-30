import { BookOpenIcon, LinkIcon, UploadIcon, XIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { cn } from "~/lib/utils";

interface ComposerReadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitUrl: (url: string) => Promise<void> | void;
  onSubmitFiles: (files: File[]) => Promise<void> | void;
}

function appendUniqueFiles(currentFiles: File[], nextFiles: File[]) {
  const seen = new Set(
    currentFiles.map((file) => `${file.name}:${file.size}:${file.lastModified}`),
  );
  const mergedFiles = [...currentFiles];
  for (const file of nextFiles) {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mergedFiles.push(file);
  }
  return mergedFiles;
}

export const ComposerReadDialog = memo(function ComposerReadDialog({
  open,
  onOpenChange,
  onSubmitUrl,
  onSubmitFiles,
}: ComposerReadDialogProps) {
  const [url, setUrl] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      setUrl("");
      setFiles([]);
      setIsSubmitting(false);
    }
  }, [open]);

  const hasUrl = url.trim().length > 0;
  const hasFiles = files.length > 0;
  const hasConflictingSources = hasUrl && hasFiles;
  const canSubmit = !isSubmitting && !hasConflictingSources && (hasUrl || hasFiles);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpenIcon className="size-4.5" />
            Read document or URL
          </DialogTitle>
          <DialogDescription>
            Choose one source: paste a remote URL or select local documents to send with the next
            turn.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-muted-foreground/80 text-sm">
              <LinkIcon className="size-4" />
              URL
            </div>
            <Input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/report.pdf"
              disabled={isSubmitting}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2 text-muted-foreground/80 text-sm">
              <UploadIcon className="size-4" />
              Local documents
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="sr-only"
              tabIndex={-1}
              onChange={(event) => {
                setFiles((currentFiles) =>
                  appendUniqueFiles(currentFiles, Array.from(event.target.files ?? [])),
                );
                event.target.value = "";
              }}
            />
            <button
              type="button"
              className={cn(
                "flex min-h-28 w-full flex-col items-center justify-center rounded-lg border border-dashed border-border/70 bg-muted/18 px-4 py-5 text-center transition-colors hover:bg-muted/26",
                isSubmitting && "cursor-not-allowed opacity-64",
              )}
              disabled={isSubmitting}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }}
              onDrop={(event) => {
                event.preventDefault();
                setFiles((currentFiles) =>
                  appendUniqueFiles(currentFiles, Array.from(event.dataTransfer.files ?? [])),
                );
              }}
            >
              <UploadIcon className="mb-2 size-5 text-muted-foreground/75" />
              <div className="text-sm">Choose files or drag them here</div>
              <div className="mt-1 text-muted-foreground/70 text-xs">
                PDF, DOCX, PPTX, XLSX, and other supported document formats
              </div>
            </button>
            {files.length > 0 ? (
              <div className="rounded-lg border border-border/55 bg-muted/18 px-3 py-2">
                <div className="mb-2 text-muted-foreground/75 text-xs">
                  {files.length === 1 ? "1 file selected" : `${files.length} files selected`}
                </div>
                <div className="space-y-2">
                  {files.map((file, index) => (
                    <div
                      key={`${file.name}:${file.size}:${file.lastModified}`}
                      className="group flex items-center gap-2 rounded-lg border border-border/50 bg-background/70 px-2.5 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm" title={file.name}>
                          {file.name}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="shrink-0 opacity-70 transition-opacity group-hover:opacity-100"
                        aria-label={`Remove ${file.name}`}
                        disabled={isSubmitting}
                        onClick={() =>
                          setFiles((currentFiles) =>
                            currentFiles.filter((_, currentIndex) => currentIndex !== index),
                          )
                        }
                      >
                        <XIcon />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {hasConflictingSources ? (
            <div className="rounded-lg border border-warning/35 bg-warning/10 px-3 py-2 text-sm text-warning">
              Choose either a URL or local files for one send.
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            onClick={async () => {
              if (!canSubmit) return;
              setIsSubmitting(true);
              try {
                if (hasUrl) {
                  await onSubmitUrl(url.trim());
                } else if (hasFiles) {
                  await onSubmitFiles(files);
                }
                onOpenChange(false);
              } finally {
                setIsSubmitting(false);
              }
            }}
            disabled={!canSubmit}
          >
            Send
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
});
