import type { GitCommitAuthor } from "@bigbud/contracts";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const MAX_VISIBLE_AUTHORS = 2;

function normalizeAuthorLabel(author: GitCommitAuthor): string {
  return author.name.trim();
}

function normalizeAuthorIdentity(author: GitCommitAuthor): string {
  const email = author.email?.trim().toLowerCase();
  if (email && email.length > 0) {
    return email;
  }
  return normalizeAuthorLabel(author).toLowerCase();
}

function hashAuthorHue(value: string): number {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash) % 360;
}

function getAuthorColorStyles(author: GitCommitAuthor): {
  backgroundColor: string;
  color: string;
} {
  const hue = hashAuthorHue(normalizeAuthorIdentity(author));
  return {
    backgroundColor: `hsl(${hue} 22% 72%)`,
    color: `hsl(${hue} 20% 24%)`,
  };
}

function getAuthorInitials(author: GitCommitAuthor): string {
  const words = normalizeAuthorLabel(author)
    .split(/\s+/)
    .filter((part) => part.length > 0);

  if (words.length === 0) {
    return "?";
  }

  if (words.length === 1) {
    return words[0]!.slice(0, 2).toUpperCase();
  }

  return `${words[0]![0] ?? ""}${words.at(-1)?.[0] ?? ""}`.toUpperCase();
}

export function formatGitCommitAuthorNames(authors: ReadonlyArray<GitCommitAuthor>): string {
  return authors.map((author) => normalizeAuthorLabel(author)).join(", ");
}

export function GitPanelAuthors(input: {
  authors: ReadonlyArray<GitCommitAuthor>;
  className?: string;
  textClassName?: string;
}) {
  const visibleAuthors = input.authors.slice(0, MAX_VISIBLE_AUTHORS);
  const hiddenCount = Math.max(0, input.authors.length - visibleAuthors.length);
  const label = formatGitCommitAuthorNames(input.authors);

  return (
    <div className={cn("flex min-w-0 items-center gap-2", input.className)}>
      <div className="flex shrink-0 items-center">
        {visibleAuthors.map((author, index) => (
          <Tooltip key={normalizeAuthorIdentity(author)}>
            <TooltipTrigger
              render={
                <span
                  className={cn(
                    "inline-flex size-4 items-center justify-center rounded-full border border-background text-[9px] font-medium tracking-tight shadow-sm",
                    index > 0 && "-ml-1.5",
                  )}
                  aria-hidden="true"
                  style={{
                    ...getAuthorColorStyles(author),
                    zIndex: visibleAuthors.length - index,
                  }}
                >
                  {getAuthorInitials(author)}
                </span>
              }
            />
            <TooltipPopup side="bottom">{normalizeAuthorLabel(author)}</TooltipPopup>
          </Tooltip>
        ))}
        {hiddenCount > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="-ml-1.5 inline-flex size-4 items-center justify-center rounded-full border border-background bg-muted text-[9px] font-medium text-muted-foreground shadow-sm">
                  +{hiddenCount}
                </span>
              }
            />
            <TooltipPopup side="bottom">{label}</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <span className={cn("truncate", input.textClassName)}>{label}</span>
    </div>
  );
}
