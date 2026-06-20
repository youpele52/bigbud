import { BaseMarkdown } from "~/components/common/BaseMarkdown";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { FilePreviewAnnotationComposer } from "./FilePreview.annotations";
import type { CodeAnnotationDraft } from "./FilePreview";

export type MarkdownFileViewMode = "raw" | "preview";

interface FilePreviewMarkdownToggleProps {
  viewMode: MarkdownFileViewMode;
  onViewModeChange: (mode: MarkdownFileViewMode) => void;
}

export function FilePreviewMarkdownToggle({
  viewMode,
  onViewModeChange,
}: FilePreviewMarkdownToggleProps) {
  return (
    <ToggleGroup
      aria-label="Switch markdown file view"
      variant="toolbar"
      size="xs"
      className="shrink-0"
      value={[viewMode]}
      onValueChange={(value) => {
        const next = value[0];
        if (next === "raw" || next === "preview") {
          onViewModeChange(next);
        }
      }}
    >
      <Toggle aria-label="View raw markdown" value="raw">
        Raw
      </Toggle>
      <Toggle aria-label="View markdown preview" value="preview">
        Preview
      </Toggle>
    </ToggleGroup>
  );
}

interface FilePreviewMarkdownContentProps {
  contents: string;
  cwd: string;
  onContextMenu?: (event: React.MouseEvent<HTMLDivElement>) => void;
}

export function FilePreviewMarkdownContent({
  contents,
  cwd,
  onContextMenu,
}: FilePreviewMarkdownContentProps) {
  return (
    <div className="p-3" onContextMenu={onContextMenu}>
      <BaseMarkdown
        text={contents}
        cwd={cwd}
        isStreaming={false}
        className="file-preview-markdown"
        preserveLineBreaks
      />
    </div>
  );
}

interface FilePreviewMarkdownViewProps {
  contents: string;
  cwd: string;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  linesContainerRef: React.RefObject<HTMLDivElement | null>;
  selectedRange: { startLine: number; endLine: number } | null;
  selectedText: string;
  onContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
  onCreateAnnotation?: ((annotation: CodeAnnotationDraft) => void) | undefined;
  onCancelAnnotation: () => void;
}

export function FilePreviewMarkdownView({
  contents,
  cwd,
  scrollContainerRef,
  linesContainerRef,
  selectedRange,
  selectedText,
  onContextMenu,
  onCreateAnnotation,
  onCancelAnnotation,
}: FilePreviewMarkdownViewProps) {
  return (
    <div ref={scrollContainerRef} className="relative min-h-0 flex-1 overflow-auto">
      <FilePreviewMarkdownContent contents={contents} cwd={cwd} onContextMenu={onContextMenu} />
      {selectedRange && onCreateAnnotation ? (
        <FilePreviewAnnotationComposer
          placement="sticky"
          scrollContainerRef={scrollContainerRef}
          linesContainerRef={linesContainerRef}
          selectedRange={selectedRange}
          selectedText={selectedText}
          onCreateAnnotation={onCreateAnnotation}
          onCancel={onCancelAnnotation}
        />
      ) : null}
    </div>
  );
}
