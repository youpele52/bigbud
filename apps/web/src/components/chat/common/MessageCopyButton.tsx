import { memo, useMemo, useRef } from "react";
import { CopyIcon, CheckIcon } from "lucide-react";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { createFullTextPrefetch } from "./MessageCopyButton.logic";

/** `resolveText` reads the full text when the shown `text` is only a bounded preview. */
export const MessageCopyButton = memo(function MessageCopyButton({
  text,
  resolveText,
}: {
  text: string;
  resolveText?: (() => Promise<string>) | undefined;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  // Callers may pass a fresh closure per render; the latest one serves each read.
  const resolveTextRef = useRef(resolveText);
  resolveTextRef.current = resolveText;
  const fullText = useMemo(
    () => createFullTextPrefetch(() => resolveTextRef.current?.() ?? Promise.resolve(text)),
    [text],
  );
  const prefetch = resolveText ? () => void fullText.prefetch().catch(() => undefined) : undefined;

  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      onPointerEnter={prefetch}
      onFocus={prefetch}
      onClick={() => {
        if (!resolveText) return copyToClipboard(text);
        const read = fullText.take();
        if ("text" in read) return copyToClipboard(read.text);
        read.promise.then(copyToClipboard, (error: unknown) => {
          toastManager.add({
            type: "error",
            title: "Could not copy message",
            description: error instanceof Error ? error.message : "The full message did not load.",
          });
        });
      }}
      title="Copy message"
    >
      {isCopied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
    </Button>
  );
});
