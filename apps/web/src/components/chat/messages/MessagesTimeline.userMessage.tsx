import { FileIcon } from "lucide-react";
import { memo, type ReactNode } from "react";
import { TerminalContextInlineChip } from "../terminal/TerminalContextInlineChip";
import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "../common/userMessageTerminalContexts";
import { type ParsedTerminalContextEntry } from "~/lib/terminalContext";
import { splitPromptIntoComposerSegments } from "../../../logic/composer";
import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../view/composerInlineChip";
import { cn } from "~/lib/utils";

const USER_MESSAGE_MENTION_BADGE_CLASS_NAME =
  "inline-flex shrink-0 rounded-sm border border-border/70 bg-background/60 px-1 py-0 text-[10px] font-semibold uppercase leading-none text-muted-foreground";

const UserMessageMentionChip = memo(function UserMessageMentionChip(props: {
  label: string;
  mentionKind: "path" | "agent" | "skill";
}) {
  return (
    <span className={cn(COMPOSER_INLINE_CHIP_CLASS_NAME, "mx-[1px]")}>
      {props.mentionKind === "path" ? (
        <FileIcon className="size-3.5 shrink-0 opacity-85" />
      ) : (
        <span className={USER_MESSAGE_MENTION_BADGE_CLASS_NAME}>{props.mentionKind}</span>
      )}
      <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{props.label}</span>
    </span>
  );
});

function renderUserMessageTextWithMentionChips(text: string): ReactNode {
  const segments = splitPromptIntoComposerSegments(text, [], {
    allowTrailingAgentAndSkillMentions: true,
  });
  if (segments.length === 0) {
    return text;
  }

  let textKeyIndex = 0;
  let mentionKeyIndex = 0;

  return segments.map((segment) => {
    if (segment.type === "text") {
      textKeyIndex += 1;
      return <span key={`user-message-text:${textKeyIndex}:${segment.text}`}>{segment.text}</span>;
    }
    if (segment.type === "mention") {
      mentionKeyIndex += 1;
      return (
        <UserMessageMentionChip
          key={`user-message-mention:${mentionKeyIndex}:${segment.rawValue}`}
          label={segment.displayLabel}
          mentionKind={segment.mentionKind}
        />
      );
    }
    return null;
  });
}

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

export const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
}) {
  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const inlineNodes: ReactNode[] = [];

    if (hasEmbeddedInlineLabels) {
      let cursor = 0;

      for (const context of props.terminalContexts) {
        const label = formatInlineTerminalContextLabel(context.header);
        const matchIndex = props.text.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            <span key={`user-terminal-context-inline-before:${context.header}:${cursor}`}>
              {props.text.slice(cursor, matchIndex)}
            </span>,
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
          />,
        );
        cursor = matchIndex + label.length;
      }

      if (inlineNodes.length > 0) {
        if (cursor < props.text.length) {
          inlineNodes.push(
            <span key={`user-message-terminal-context-inline-rest:${cursor}`}>
              {props.text.slice(cursor)}
            </span>,
          );
        }

        return (
          <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
            {inlineNodes}
          </div>
        );
      }
    }

    for (const context of props.terminalContexts) {
      inlineNodes.push(
        <UserMessageTerminalContextInlineLabel
          key={`user-terminal-context-inline:${context.header}`}
          context={context}
        />,
      );
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }

    if (props.text.length > 0) {
      inlineNodes.push(
        <span key="user-message-terminal-context-inline-text">
          {renderUserMessageTextWithMentionChips(props.text)}
        </span>,
      );
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
      {renderUserMessageTextWithMentionChips(props.text)}
    </div>
  );
});
