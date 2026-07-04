import { Check, RotateCcw, X } from "lucide-react";

import { Input } from "../ui/input";
import { TerminalActionButton } from "./TerminalActionButton";

interface ThreadTerminalDrawerRenameEditorProps {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onReset: () => void;
  autoFocus?: boolean | undefined;
  inputRef?: ((element: HTMLInputElement | null) => void) | undefined;
  className?: string | undefined;
}

export function ThreadTerminalDrawerRenameEditor({
  value,
  placeholder,
  onChange,
  onCommit,
  onCancel,
  onReset,
  autoFocus,
  inputRef,
  className,
}: ThreadTerminalDrawerRenameEditorProps) {
  return (
    <div className={className}>
      <div className="flex flex-col gap-1.5 rounded-md border border-border/80 bg-background/95 p-1.5 shadow-sm">
        <Input
          nativeInput
          size="sm"
          className="w-full rounded-md"
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onCommit();
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }
          }}
          onBlur={onCommit}
          autoFocus={autoFocus}
          ref={inputRef}
        />
        <div className="flex items-center justify-end gap-1">
          <TerminalActionButton
            className="inline-flex size-6 items-center justify-center rounded text-foreground/90 transition-colors hover:bg-accent"
            onClick={onReset}
            label="Reset terminal name"
          >
            <RotateCcw className="size-3" />
          </TerminalActionButton>
          <TerminalActionButton
            className="inline-flex size-6 items-center justify-center rounded text-foreground/90 transition-colors hover:bg-accent"
            onClick={onCommit}
            label="Save terminal name"
          >
            <Check className="size-3" />
          </TerminalActionButton>
          <TerminalActionButton
            className="inline-flex size-6 items-center justify-center rounded text-foreground/90 transition-colors hover:bg-accent"
            onClick={onCancel}
            label="Cancel terminal rename"
          >
            <X className="size-3" />
          </TerminalActionButton>
        </div>
      </div>
    </div>
  );
}
