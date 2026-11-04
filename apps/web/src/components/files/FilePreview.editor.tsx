import { Editor, type EditorFactory } from "@pierre/diffs-edit/edit";
import { EditProvider, File } from "@pierre/diffs-edit/react";
import { useEffect, useMemo, useRef } from "react";

import { changeFileEditDraft, trackFileEditSession } from "./fileEditDrafts";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { useTheme } from "../../hooks/useTheme";

const createEditor: EditorFactory<undefined, undefined> = (type, options, editStateKey) =>
  new Editor(type, options, editStateKey);

interface FilePreviewEditorProps {
  readonly fileKey: string;
  readonly relativePath: string;
  readonly initialContents: string;
}

export function FilePreviewEditor({
  fileKey,
  relativePath,
  initialContents,
}: FilePreviewEditorProps) {
  const { resolvedTheme } = useTheme();
  const initial = useRef(initialContents);
  useEffect(() => trackFileEditSession(fileKey), [fileKey]);
  const file = useMemo(() => ({ name: relativePath, contents: initial.current }), [relativePath]);
  return (
    <div className="min-h-0 flex-1 overflow-auto" data-file-preview-editor>
      <EditProvider createEditor={createEditor}>
        <File
          file={file}
          edit
          options={{
            theme: resolveDiffThemeName(resolvedTheme),
            themeType: resolvedTheme,
            overflow: "scroll",
            disableFileHeader: true,
          }}
          onEditChange={(event) => changeFileEditDraft(fileKey, event.file.contents)}
          onEditComplete={(event) => {
            if (event.file) changeFileEditDraft(fileKey, event.file.contents);
            return "reject";
          }}
        />
      </EditProvider>
    </div>
  );
}
