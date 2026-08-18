import { memo } from "react";

import { BaseMarkdown, type MarkdownAnchorClick } from "../../common/BaseMarkdown";
import {
  ChatFileTargetContextMenu,
  useChatFileTargetContextMenu,
} from "./ChatFileTargetContextMenu";

interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
  isStreaming?: boolean;
  className?: string;
  onAnchorClick?: ((input: MarkdownAnchorClick) => void) | undefined;
}

function ChatMarkdown({
  text,
  cwd,
  isStreaming = false,
  className,
  onAnchorClick,
}: ChatMarkdownProps) {
  const { contextMenuState, hideContextMenu, showContextMenu } = useChatFileTargetContextMenu();

  return (
    <>
      <BaseMarkdown
        text={text}
        cwd={cwd}
        isStreaming={isStreaming}
        className={className}
        onFileContextMenu={showContextMenu}
        onAnchorClick={onAnchorClick}
      />
      <ChatFileTargetContextMenu contextMenuState={contextMenuState} onClose={hideContextMenu} />
    </>
  );
}

export default memo(ChatMarkdown);
