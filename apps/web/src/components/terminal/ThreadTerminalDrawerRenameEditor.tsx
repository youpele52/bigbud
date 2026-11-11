import { Check, RotateCcw, X } from "lucide-react";

import {
  TerminalInlineBar,
  TerminalInlineBarButton,
  TerminalInlineBarInput,
} from "./TerminalInlineBar";

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
    <TerminalInlineBar
      className={className}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onCommit();
      }}
    >
      <TerminalInlineBarInput
        nativeInput
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
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
        autoFocus={autoFocus}
        ref={inputRef}
      />
      <TerminalInlineBarButton
        onClick={onReset}
        aria-label="Reset terminal name"
        title="Reset terminal name"
      >
        <RotateCcw className="size-3" />
      </TerminalInlineBarButton>
      <TerminalInlineBarButton
        onClick={onCommit}
        aria-label="Save terminal name"
        title="Save terminal name"
      >
        <Check className="size-3" />
      </TerminalInlineBarButton>
      <TerminalInlineBarButton
        onClick={onCancel}
        aria-label="Cancel terminal rename"
        title="Cancel terminal rename"
      >
        <X className="size-3" />
      </TerminalInlineBarButton>
    </TerminalInlineBar>
  );
}
