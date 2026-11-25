import { BookOpenIcon, LinkIcon, UploadIcon, XIcon } from "lucide-react";
import { memo, useId, useLayoutEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "../../ui/alert";
import { parseComposerDocumentUrl } from "./ComposerReadDialog.url";

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
  onSubmitUrl: (url: string, signal: AbortSignal) => Promise<void>;
  onSubmitFiles: (files: File[]) => boolean;
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

  const [submitError, setSubmitError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const urlId = useId();

  useLayoutEffect(() => {
    if (!open) {
      setUrl("");
      setFiles([]);
      setIsSubmitting(false);
      setSubmitError(null);
    }
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [open]);

  const hasUrl = url.trim().length > 0;
  const parsedUrl = hasUrl ? parseComposerDocumentUrl(url) : null;
  const invalidUrl = hasUrl && !parsedUrl;
  const hasFiles = files.length > 0;
  const hasConflictingSources = hasUrl && hasFiles;
  const canSubmit = !isSubmitting && !invalidUrl && !hasConflictingSources && (hasUrl || hasFiles);

  async function addToDraft() {
    if (!canSubmit || requestRef.current) return;
    const request = new AbortController();
    requestRef.current = request;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      if (parsedUrl) {
        await onSubmitUrl(parsedUrl, request.signal);
      } else if (!onSubmitFiles(files)) {
        setSubmitError("Could not attach these files. Check the attachment limits and try again.");
        return;
      }
      if (!request.signal.aborted) onOpenChange(false);
    } catch (error) {
      if (!request.signal.aborted) {
        setSubmitError(
          error instanceof Error ? error.message : "Could not add this document. Try again.",
        );
      }
    } finally {
      if (requestRef.current === request) {
        requestRef.current = null;
        setIsSubmitting(false);
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        className="max-w-xl"
        onDragEnter={(event) => event.stopPropagation()}
        onDragLeave={(event) => event.stopPropagation()}
        onDragOver={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpenIcon className="size-4.5" />
            Read document or URL
          </DialogTitle>
          <DialogDescription>
            Add a public URL or local documents to your draft. Nothing is sent until you send the
            draft.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="space-y-2">
            <label
              htmlFor={urlId}
              className="flex items-center gap-2 text-muted-foreground/80 text-sm"
            >
              <LinkIcon className="size-4" />
              URL
            </label>
            <Input
              id={urlId}
              value={url}
              aria-invalid={invalidUrl || undefined}
              aria-describedby={invalidUrl ? `${urlId}-error` : undefined}
              onChange={(event) => {
                setUrl(event.target.value);
                setSubmitError(null);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                void addToDraft();
              }}
              placeholder="https://example.com/report.pdf"
              disabled={isSubmitting}
            />
            {invalidUrl && (
              <p id={`${urlId}-error`} className="text-destructive text-xs">
                Enter a valid HTTP or HTTPS URL without credentials (up to 2048 characters).
              </p>
            )}
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
                setSubmitError(null);
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
                if (isSubmitting) return;
                setSubmitError(null);
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
            <Alert variant="warning">
              <AlertDescription>Choose either a URL or local files to add.</AlertDescription>
            </Alert>
          ) : null}
          {submitError && (
            <Alert variant="error">
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            size="default"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" onClick={() => void addToDraft()} disabled={!canSubmit}>
            {isSubmitting ? "Adding to draft…" : "Add to draft"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
});
