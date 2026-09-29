import { CheckIcon, CopyIcon, Maximize2Icon } from "lucide-react";
import {
  Children,
  isValidElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { copyTextToClipboard } from "~/lib/clipboard/copyText";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Table } from "../ui/table";

interface MarkdownTableProps {
  children: ReactNode;
}

type ElementWithChildren = {
  children?: ReactNode;
};

function childrenOf(node: ReactNode): ReactNode {
  return isValidElement<ElementWithChildren>(node) ? node.props.children : null;
}

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }
  if (isValidElement<ElementWithChildren>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return "";
}

function toMarkdownCell(node: ReactNode): string {
  return nodeToPlainText(node).replace(/\s+/g, " ").trim().replaceAll("|", "\\|");
}

function renderMarkdownRow(row: string[]): string {
  return `| ${row.join(" | ")} |`;
}

function tableToMarkdown(children: ReactNode): string {
  const rows: string[][] = [];

  for (const section of Children.toArray(children)) {
    for (const row of Children.toArray(childrenOf(section))) {
      const cells = Children.toArray(childrenOf(row));
      if (cells.length === 0) {
        continue;
      }
      rows.push(cells.map(toMarkdownCell));
    }
  }

  if (rows.length === 0) {
    return "";
  }

  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) => row.concat(Array(columnCount - row.length).fill("")));
  const headerRow = normalizedRows[0];
  if (!headerRow) {
    return "";
  }

  return [
    renderMarkdownRow(headerRow),
    renderMarkdownRow(headerRow.map(() => "---")),
    ...normalizedRows.slice(1).map(renderMarkdownRow),
  ].join("\n");
}

function MarkdownTableActions({
  copied,
  onCopy,
  onOpen,
}: {
  copied: boolean;
  onCopy: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="chat-markdown-table-actions" role="toolbar" aria-label="Table actions">
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onOpen}
        title="Open table"
        aria-label="Open table"
      >
        <Maximize2Icon />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onCopy}
        title={copied ? "Copied" : "Copy table"}
        aria-label={copied ? "Copied" : "Copy table"}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}

export function MarkdownTable({ children }: MarkdownTableProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markdown = tableToMarkdown(children);

  const handleCopy = useCallback(() => {
    void copyTextToClipboard(markdown)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch(() => undefined);
  }, [markdown]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
      }
    },
    [],
  );

  return (
    <div
      className="chat-markdown-table group relative"
      role="region"
      aria-label="Scrollable table"
      tabIndex={0}
    >
      <MarkdownTableActions copied={copied} onCopy={handleCopy} onOpen={() => setOpen(true)} />
      <Table className="chat-markdown-table-scroll">{children}</Table>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="chat-markdown-table-dialog gap-0 overflow-hidden p-0 will-change-auto"
          backdropClassName="backdrop-blur-none"
          bottomStickOnMobile={false}
        >
          <div className="chat-markdown flex h-full min-h-0 flex-1 flex-col p-6 sm:p-8">
            <DialogTitle className="sr-only">Expanded table</DialogTitle>
            <DialogDescription className="sr-only">Expanded markdown table</DialogDescription>
            <Table className="chat-markdown-table-scroll chat-markdown-table-expanded min-h-0 flex-1">
              {children}
            </Table>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export { tableToMarkdown };
