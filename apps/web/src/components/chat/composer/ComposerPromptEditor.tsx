import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer";
import { forwardRef, useMemo, useRef } from "react";

import { ComposerMentionNode, ComposerTerminalContextNode } from "./ComposerPromptEditor.nodes";
import { $setComposerEditorPrompt } from "./ComposerPromptEditor.nodes.helpers";
import { ComposerPromptEditorInner } from "./ComposerPromptEditor.inner";
import {
  type ComposerPromptEditorHandle,
  type ComposerPromptEditorProps,
} from "./ComposerPromptEditor.shared";

const COMPOSER_EDITOR_HMR_KEY = `composer-editor-${Math.random().toString(36).slice(2)}`;
export type {
  ComposerPromptEditorHandle,
  ComposerPromptEditorProps,
} from "./ComposerPromptEditor.shared";

export const ComposerPromptEditor = forwardRef<
  ComposerPromptEditorHandle,
  ComposerPromptEditorProps
>(function ComposerPromptEditor(
  {
    value,
    cursor,
    terminalContexts,
    discoveredSkills,
    disabled,
    placeholder,
    className,
    onRemoveTerminalContext,
    onChange,
    onCommandKeyDown,
    onPaste,
  },
  ref,
) {
  const initialValueRef = useRef(value);
  const initialTerminalContextsRef = useRef(terminalContexts);
  const initialDiscoveredSkillsRef = useRef(discoveredSkills ?? []);
  const initialConfig = useMemo<InitialConfigType>(
    () => ({
      namespace: "t3tools-composer-editor",
      editable: true,
      nodes: [ComposerMentionNode, ComposerTerminalContextNode],
      editorState: () => {
        $setComposerEditorPrompt(
          initialValueRef.current,
          initialTerminalContextsRef.current,
          initialDiscoveredSkillsRef.current,
        );
      },
      onError: (error) => {
        throw error;
      },
    }),
    [],
  );

  return (
    <LexicalComposer key={COMPOSER_EDITOR_HMR_KEY} initialConfig={initialConfig}>
      <ComposerPromptEditorInner
        value={value}
        cursor={cursor}
        terminalContexts={terminalContexts}
        discoveredSkills={discoveredSkills}
        disabled={disabled}
        placeholder={placeholder}
        onRemoveTerminalContext={onRemoveTerminalContext}
        onChange={onChange}
        onPaste={onPaste}
        editorRef={ref}
        {...(onCommandKeyDown ? { onCommandKeyDown } : {})}
        {...(className ? { className } : {})}
      />
    </LexicalComposer>
  );
});
