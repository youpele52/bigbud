import { Toast } from "@base-ui/react/toast";
import { CheckIcon, CopyIcon, Wifi, XIcon, type LucideIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { TOAST_DISMISS_ALL_HINT, useToastDismissAllGesture } from "./toast.dismissAll";

function CopyErrorButton({ text }: { text: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  return (
    <button
      className="shrink-0 cursor-pointer rounded-md p-1 text-muted-foreground opacity-60 transition-opacity hover:opacity-100"
      onClick={() => copyToClipboard(text)}
      title="Copy error"
      type="button"
    >
      {isCopied ? (
        <CheckIcon className="size-3.5 text-success" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
    </button>
  );
}

export function ToastCloseButton({
  className,
  exposeToAccessibility = false,
}: {
  className?: string;
  exposeToAccessibility?: boolean;
}) {
  const dismissAllGesture = useToastDismissAllGesture();
  return (
    <Toast.Close
      {...dismissAllGesture}
      aria-label="Close notification"
      aria-description={TOAST_DISMISS_ALL_HINT}
      aria-keyshortcuts="Shift+Delete"
      title={TOAST_DISMISS_ALL_HINT}
      className={cn(
        "shrink-0 rounded-md p-1 text-muted-foreground opacity-60 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
      {...(exposeToAccessibility ? { "aria-hidden": false } : {})}
    >
      <XIcon className="size-3.5" />
    </Toast.Close>
  );
}

export function ToastTitleAndDescription({
  Icon,
  icon,
  description,
  hideCopyButton,
}: {
  Icon: LucideIcon | null;
  icon?: "wifi" | undefined;
  description: unknown;
  hideCopyButton: boolean | undefined;
}) {
  const DisplayIcon = icon === "wifi" ? Wifi : Icon;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 gap-2 pr-7">
      {DisplayIcon && (
        <div
          className="[&>svg]:h-lh [&>svg]:w-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 mt-0.5"
          data-slot="toast-icon"
        >
          <DisplayIcon
            className={
              icon === "wifi"
                ? "text-warning"
                : "in-data-[type=loading]:animate-spin in-data-[type=error]:text-destructive in-data-[type=info]:text-info in-data-[type=success]:text-success in-data-[type=warning]:text-warning in-data-[type=loading]:text-info"
            }
          />
        </div>
      )}

      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        data-slot="toast-message"
        tabIndex={0}
        role="region"
        aria-label="Notification message"
        onPointerDownCapture={(event) => {
          // Let long text scroll/select without starting a card swipe. Keep
          // short messages swipeable and preserve Base UI's touch timer pause.
          const element = event.currentTarget;
          element.toggleAttribute(
            "data-base-ui-swipe-ignore",
            element.scrollHeight > element.clientHeight,
          );
        }}
        onTouchMoveCapture={(event) => {
          const element = event.currentTarget;
          if (element.scrollHeight > element.clientHeight) event.stopPropagation();
        }}
      >
        <Toast.Title
          className="min-w-0 shrink-0 wrap-break-word font-medium text-sm"
          data-slot="toast-title"
        />
        <Toast.Description
          className="min-w-0 shrink-0 select-text wrap-break-word whitespace-pre-line text-muted-foreground"
          data-slot="toast-description"
        />
        {typeof description === "string" && !hideCopyButton ? (
          <CopyErrorButton text={description} />
        ) : null}
      </div>
    </div>
  );
}
