import type { ReactNode } from "react";
import { Maximize2Icon } from "lucide-react";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../ui/dialog";

/** Expand live resource content with the same accessible zoom behavior as chat tables. */
export function ResourceDetailDialog({
  title,
  description,
  children,
  expandedContent,
}: {
  title: string;
  description: string;
  children: (trigger: ReactNode) => ReactNode;
  expandedContent: ReactNode;
}) {
  return (
    <Dialog>
      {children(
        <DialogTrigger
          render={<Button variant="ghost" size="icon-xs" />}
          title={`Expand ${title}`}
          aria-label={`Expand ${title}`}
        >
          <Maximize2Icon />
        </DialogTrigger>,
      )}
      <DialogContent
        className="max-w-4xl overflow-y-auto p-6 will-change-auto sm:p-8"
        backdropClassName="backdrop-blur-none"
        bottomStickOnMobile={false}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        {expandedContent}
      </DialogContent>
    </Dialog>
  );
}
