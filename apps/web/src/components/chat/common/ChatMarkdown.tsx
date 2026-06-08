import { memo } from "react";

import { BaseMarkdown } from "../../common/BaseMarkdown";
import {
  ChatFileTargetContextMenu,
  useChatFileTargetContextMenu,
} from "./ChatFileTargetContextMenu";

interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
  isStreaming?: boolean;
  className?: string;
}

function ChatMarkdown({ text, cwd, isStreaming = false, className }: ChatMarkdownProps) {
  const { contextMenuState, hideContextMenu, showContextMenu } = useChatFileTargetContextMenu();

  return (
    <>
      <BaseMarkdown
        text={text}
        cwd={cwd}
        isStreaming={isStreaming}
        className={className}
        onFileContextMenu={showContextMenu}
      />
      <ChatFileTargetContextMenu contextMenuState={contextMenuState} onClose={hideContextMenu} />
    </>
  );
}

export default memo(ChatMarkdown);
