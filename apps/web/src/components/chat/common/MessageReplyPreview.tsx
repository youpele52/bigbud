import { type ChatMessageReplyTarget } from "../../../models/types";
import { cn } from "~/lib/utils";

function senderLabel(role: ChatMessageReplyTarget["role"]): string {
  switch (role) {
    case "assistant":
      return "AI";
    case "system":
      return "System";
    case "user":
    default:
      return "You";
  }
}

export function MessageReplyPreview(props: {
  replyTarget: ChatMessageReplyTarget;
  onClick?: () => void;
  className?: string;
}) {
  const { replyTarget, onClick, className } = props;
  const content = (
    <>
      <span
        className={cn(
          "mt-0.5 h-8 w-0.5 shrink-0 rounded-full",
          replyTarget.role === "assistant" ? "bg-primary/70" : "bg-muted-foreground/45",
        )}
      />
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/70">
          {senderLabel(replyTarget.role)}
        </p>
        <p className="line-clamp-2 break-words text-xs text-muted-foreground/80">
          {replyTarget.excerpt || "(empty message)"}
        </p>
      </div>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex min-w-0 items-start gap-2 rounded-xl border border-border/65 bg-background/45 px-3 py-2 text-left transition-colors hover:border-foreground/20 hover:bg-background/60",
          className,
        )}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      className={cn(
        "flex min-w-0 items-start gap-2 rounded-xl border border-border/65 bg-background/45 px-3 py-2 text-left",
        className,
      )}
    >
      {content}
    </div>
  );
}
